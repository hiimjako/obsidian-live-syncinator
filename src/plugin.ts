import type { TAbstractFile } from "obsidian";
import path from "path-browserify";
import { log } from "src/logger/logger";

const OBSIDIAN_CACHE_POLL_COUNT = 10;
const OBSIDIAN_CACHE_POLL_INTERVAL_MS = 100;

import type { ApiClient } from "./api/api";
import {
    type ChunkMessage,
    type CursorMessage,
    type EventMessage,
    MessageType,
    type WsClient,
} from "./api/ws";
import { FileCache } from "./cache";
import { getChunksToPersist, isSameChunkMessage, revertOptimisticChunks } from "./chunkHandler";
import { applyDiffs, computeDiff, type DiffChunk } from "./diff/diff";
import { handleEventMessage } from "./eventHandler";
import { DequeRegistry } from "./messageQueue";
import type { FileDiff } from "./modals/conflict";
import { type ConflictResolution, reconcileFile } from "./reconcileHandler";
import {
    snapshotFileChanged as handleSnapshotFileChanged,
    snapshotSelected as handleSnapshotSelected,
} from "./snapshotHandler";
import type { Disk } from "./storage/storage";
import { SyncLock } from "./syncLock";
import type {
    CursorEventMap,
    CursorPosition,
    EventBus,
    ObsidianEventMap,
    Snapshot,
    SnapshotEventMap,
} from "./utils/eventBus";
import { isTextFile } from "./utils/mime";
import { sleep } from "./utils/sleep";

function logSettledFailures(results: PromiseSettledResult<unknown>[], context: string): void {
    for (const result of results) {
        if (result.status === "rejected") {
            log.error(`[${context}]`, result.reason);
        }
    }
}

export interface Options {
    conflictResolution: ConflictResolution;
}

interface Contracts {
    diffModal(filename: string, local: FileDiff, remote: FileDiff): Promise<string>;
    snapshotEventBus: EventBus<SnapshotEventMap>;
    obsidianEventBus: EventBus<ObsidianEventMap>;
    cursorEventBus: EventBus<CursorEventMap>;
}

export class Syncinator {
    private storage: Disk;
    private fileCache: FileCache = new FileCache();
    private apiClient: ApiClient;
    private wsClient: WsClient;
    private messageQueueRegistry = new DequeRegistry<number, ChunkMessage>();
    private initialized = false;
    options: Options = { conflictResolution: "remote" };
    contracts: Contracts;
    private syncLock = new SyncLock();

    constructor(
        storage: Disk,
        apiClient: ApiClient,
        wsClient: WsClient,
        contracts: Contracts,
        options: Options,
    ) {
        this.storage = storage;
        this.apiClient = apiClient;
        this.wsClient = wsClient;
        this.contracts = contracts;
        this.options = options;

        this.wsClient.onChunkMessage(this.handleChunkMessage.bind(this));
        this.wsClient.onEventMessage(this.handleEventMessage.bind(this));
        this.wsClient.onCursorMessage(this.handleCursorMessage.bind(this));
        this.wsClient.onOpen(() => {
            if (this.initialized) {
                this.fetchRemoteFiles();
            }
        });
        this.contracts.cursorEventBus.on("local-cursor-update", this.sendCursorPosition.bind(this));
        this.wsClient.connect();

        this.contracts.obsidianEventBus.on("create", this.create.bind(this));
        this.contracts.obsidianEventBus.on("delete", this.delete.bind(this));
        this.contracts.obsidianEventBus.on("modify", this.modify.bind(this));
        this.contracts.obsidianEventBus.on("rename", this.rename.bind(this));

        this.contracts.snapshotEventBus.on(
            "file-focus-change",
            this.snapshotFileChanged.bind(this),
        );
        this.contracts.snapshotEventBus.on("snapshot-selected", this.snapshotSelected.bind(this));
    }

    async init() {
        await this.fetchRemoteFiles();
        await this.pushLocalFiles();
        this.initialized = true;
    }

    /**
     * Publish to the server the local unsynchronized files
     */
    async pushLocalFiles() {
        try {
            const files = await this.storage.listFiles();

            const filesToPush = files.map(async (file) => {
                if (this.fileCache.hasByPath(file.path)) {
                    return;
                }

                const currentContent = await this.storage.read(file.path);
                const fileApi = await this.apiClient.createFile(file.path, currentContent);
                this.fileCache.create({ ...fileApi, content: currentContent });

                const msg: EventMessage = {
                    type: MessageType.Create,
                    fileId: fileApi.id,
                    objectType: "file",
                    workspacePath: fileApi.workspacePath,
                };
                this.wsClient.sendMessage(msg);
            });

            logSettledFailures(await Promise.allSettled(filesToPush), "pushLocalFiles");
        } catch (error) {
            log.error("error while pushing local files", error);
        }
    }

    async fetchRemoteFiles() {
        try {
            const files = await this.apiClient.fetchFiles();
            log.info(`fetched ${files.length} files from remote`);
            log.debug(files);

            const reconcileDeps = {
                apiClient: this.apiClient,
                storage: this.storage,
                fileCache: this.fileCache,
                conflictResolution: this.options.conflictResolution,
                diffModal: this.contracts.diffModal,
                sendChunks: this.sendChunks.bind(this),
            };

            logSettledFailures(
                await Promise.allSettled(files.map((file) => reconcileFile(file, reconcileDeps))),
                "fetchRemoteFiles",
            );
        } catch (error) {
            log.error("error while fetching remote files", error);
        }
    }

    // ---------- ChunkMessage ---------
    async handleChunkMessage(data: ChunkMessage) {
        log.debug("[socket]: chunk message", data);
        const { fileId, version } = data;
        const file = this.fileCache.getById(fileId);

        if (!file) {
            log.warn(`[onChunkMessage] file '${fileId}' not in cache, skipping`);
            return;
        }

        if (!isTextFile(file) || typeof file.content !== "string") {
            return;
        }

        if (version < file.version) {
            log.warn(`recived old message from ws: ${version} current ${file.version}`);
        }

        await this.syncLock.waitForModify(fileId);
        const release = this.syncLock.acquireChunkLock(fileId);

        try {
            let updatedContent = file.content;
            const deque = this.messageQueueRegistry.getDeque(fileId);
            const isAckMessage = !deque.isEmpty() && isSameChunkMessage(data, deque.peekFront());
            if (isAckMessage) {
                log.debug(`[onChunkMessage] ack message ${file.workspacePath} ${file.id}`);
                deque.removeFront();
            } else {
                const chunksToPersist = await getChunksToPersist(data, file, this.apiClient);
                updatedContent = await this.storage.readText(file.workspacePath);

                if (!deque.isEmpty()) {
                    log.debug(
                        `[onChunkMessage] chunk out of sync ${file.workspacePath} ${file.id}`,
                    );
                    const messages: ChunkMessage[] = [];
                    while (!deque.isEmpty()) {
                        messages.push(deque.removeFront());
                    }
                    updatedContent = revertOptimisticChunks(messages, updatedContent);
                }

                updatedContent = applyDiffs(updatedContent, chunksToPersist);
                this.syncLock.suppressModify(file.workspacePath);
                await this.storage.modifyText(file.workspacePath, updatedContent);
            }

            file.version = version;
            file.content = updatedContent;
            this.fileCache.setById(file.id, file);
        } catch (error) {
            log.error(error);
        } finally {
            release();
        }
    }

    // ---------- END ---------

    // ---------- EventMessage ---------
    async handleEventMessage(event: EventMessage) {
        await handleEventMessage(event, {
            apiClient: this.apiClient,
            storage: this.storage,
            fileCache: this.fileCache,
        });
    }

    async handleCursorMessage(cursor: CursorMessage) {
        log.debug("[socket]: cursor message", cursor);
        this.contracts.cursorEventBus.emit("remote-cursor-update", {
            id: cursor.id ?? "",
            ...cursor,
        });
    }

    async sendCursorPosition(cursor: CursorPosition) {
        if (!this.fileCache.hasByPath(cursor.path)) {
            return;
        }

        const cachedFile = this.fileCache.getByPath(cursor.path);
        if (cachedFile == null) {
            log.error(`file '${cursor.path}' not found`);
            return;
        }

        this.wsClient.sendMessage({
            type: MessageType.Cursor,
            fileId: cachedFile.id,
            path: cursor.path,
            label: cursor.label,
            color: cursor.color,
            line: cursor.line,
            ch: cursor.ch,
        });
    }

    // ---------- END ---------

    // ---------- Obsidian events ---------
    private async create({ file }: { file: TAbstractFile }) {
        log.debug("[event]: create", file);
        if (this.fileCache.hasByPath(file.path)) {
            return;
        }

        const stat = await this.storage.stat(file.path);
        if (stat?.type === "folder") {
            const msg: EventMessage = {
                type: MessageType.Create,
                fileId: 0,
                objectType: "folder",
                workspacePath: file.path,
            };
            this.wsClient.sendMessage(msg);
            return;
        }

        try {
            const currentContent = await this.storage.read(file.path);
            const fileApi = await this.apiClient.createFile(file.path, currentContent);
            this.fileCache.create({ ...fileApi, content: currentContent });

            const msg: EventMessage = {
                type: MessageType.Create,
                fileId: fileApi.id,
                objectType: "file",
                workspacePath: fileApi.workspacePath,
            };
            this.wsClient.sendMessage(msg);
        } catch (error) {
            log.error(error);
        }
    }

    private async modify({ file }: { file: TAbstractFile }) {
        log.debug("[event]: modify", file);

        if (this.syncLock.consumeSuppression(file.path)) {
            return;
        }

        const cachedFile = this.fileCache.getByPath(file.path);
        if (cachedFile == null) {
            log.error(`file '${file.path}' not found`);
            return;
        }

        if (!isTextFile(cachedFile) || typeof cachedFile.content !== "string") {
            return;
        }

        await this.syncLock.waitForChunk(cachedFile.id);
        await this.syncLock.waitForModify(cachedFile.id);

        const release = this.syncLock.acquireModifyLock(cachedFile.id);

        try {
            const newContent = await this.storage.readText(file.path);
            const chunks = computeDiff(cachedFile.content, newContent);

            log.debug("modify", { fileId: cachedFile.id, chunks, newContent });
            this.sendChunks(cachedFile.id, cachedFile.version, chunks);

            // Optimistically update cache content so subsequent modifies
            // diff against the latest content, not stale cache.
            // Version is NOT updated here — only on ACK.
            if (chunks.length > 0) {
                cachedFile.content = newContent;
                this.fileCache.setById(cachedFile.id, cachedFile);
                this.contracts.cursorEventBus.emit("trigger-cursor-update", file.path);
            }
        } finally {
            release();
        }
    }

    private async delete({ file }: { file: TAbstractFile }) {
        log.debug("[event]: delete", file);

        const deleteFile = async (fileId: number) => {
            const fileFromCache = this.fileCache.getById(fileId);
            if (!fileFromCache) {
                // should be unreachable
                log.error(`trying to delete a non existing file ${fileId}`);
                return;
            }
            try {
                await this.apiClient.deleteFile(fileId);
                this.fileCache.deleteById(fileId);

                const msg: EventMessage = {
                    type: MessageType.Delete,
                    fileId: fileId,
                    objectType: "file",
                    workspacePath: fileFromCache.workspacePath,
                };
                this.wsClient.sendMessage(msg);
            } catch (error) {
                log.error(error);
            }
        };

        const fileToDelete = this.fileCache.getByPath(file.path);
        if (fileToDelete) {
            await deleteFile(fileToDelete.id);
        } else {
            log.warn(`missing file for deletion: "${file.path}", probably a folder`);

            logSettledFailures(
                await Promise.allSettled(
                    this.fileCache
                        .find((f) => f.workspacePath.startsWith(file.path + path.sep))
                        .map((f) => deleteFile(f.id)),
                ),
                "delete folder",
            );

            const msg: EventMessage = {
                type: MessageType.Delete,
                fileId: 0,
                objectType: "folder",
                workspacePath: file.path,
            };
            this.wsClient.sendMessage(msg);
        }
    }

    private async rename({ file, oldPath }: { file: TAbstractFile; oldPath: string }) {
        log.debug("[event]: rename", oldPath, file);
        const fileToRename = this.fileCache.getByPath(oldPath);
        if (fileToRename) {
            try {
                const updatedFile = await this.apiClient.updateFile(fileToRename.id, file.path);
                this.fileCache.setPath(fileToRename.id, updatedFile.workspacePath);
                this.fileCache.setUpdatedAt(fileToRename.id, updatedFile.updatedAt);

                const msg: EventMessage = {
                    type: MessageType.Rename,
                    fileId: fileToRename.id,
                    objectType: "file",
                    workspacePath: oldPath,
                };
                this.wsClient.sendMessage(msg);
            } catch (error) {
                log.error(error);
                return;
            }
        } else {
            const oldWorkspacePath = oldPath.endsWith(path.sep) ? oldPath : oldPath + path.sep;

            const folderFiles = await this.storage.listFiles({
                prefix: oldWorkspacePath,
            });

            if (folderFiles.length === 0) {
                log.debug(`[event]: rename skipped for "${oldPath}", file not yet in cache`);
                return;
            }

            log.debug(`[event]: rename folder "${oldPath}"`);

            const renamePromises = folderFiles.map(async (folderFile) => {
                const fileToRename = this.fileCache.getByPath(folderFile.path);
                if (!fileToRename) return;

                const oldFilePath = fileToRename.workspacePath;
                const newFilePath = oldFilePath.replace(oldPath, file.path);

                try {
                    const updatedFile = await this.apiClient.updateFile(
                        fileToRename.id,
                        newFilePath,
                    );

                    // Update cache and storage with the new file path
                    this.fileCache.setUpdatedAt(fileToRename.id, updatedFile.updatedAt);
                    this.fileCache.setPath(fileToRename.id, updatedFile.workspacePath);
                    this.storage.rename(oldFilePath, updatedFile.workspacePath);
                } catch (error) {
                    log.error(`Failed to update file "${fileToRename.id}": ${error.message}`);
                }
            });

            logSettledFailures(await Promise.allSettled(renamePromises), "rename folder");

            const msg: EventMessage = {
                type: MessageType.Rename,
                fileId: 0,
                objectType: "folder",
                workspacePath: oldPath,
            };
            this.wsClient.sendMessage(msg);

            // give time to obsidian to update cache
            for (let i = 0; i < OBSIDIAN_CACHE_POLL_COUNT; i++) {
                const filesPostRename = await this.storage.listFiles({
                    prefix: oldWorkspacePath,
                });
                if (filesPostRename.length === 0) {
                    this.storage.delete(oldPath, { force: true });
                    break;
                }
                await sleep(OBSIDIAN_CACHE_POLL_INTERVAL_MS);
            }
        }
    }
    // ---------- END ---------

    // ---------- Snapshot events ---------
    async snapshotFileChanged(data: { path: string }) {
        await handleSnapshotFileChanged(data, {
            fileCache: this.fileCache,
            apiClient: this.apiClient,
            snapshotEventBus: this.contracts.snapshotEventBus,
        });
    }

    async snapshotSelected(snapshot: Snapshot) {
        await handleSnapshotSelected(snapshot, {
            fileCache: this.fileCache,
            apiClient: this.apiClient,
            diffModal: this.contracts.diffModal,
            storage: this.storage,
            sendChunks: this.sendChunks.bind(this),
        });
    }
    // ---------- END ---------

    sendChunks(fileId: number, version: number, chunks: DiffChunk[]) {
        if (chunks.length > 0) {
            const msg: ChunkMessage = {
                type: MessageType.Chunk,
                fileId,
                chunks,
                version,
            };
            this.messageQueueRegistry.getDeque(fileId).addBack(msg);
            this.wsClient.sendMessage(msg);
        }
    }

    cacheDump() {
        return this.fileCache.dump().sort((a, b) => a.id - b.id);
    }
}
