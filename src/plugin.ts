import type { TAbstractFile } from "obsidian";
import path from "path-browserify";
import { log } from "src/logger/logger";
import type { ApiClient, File, FileWithContent } from "./api/api";
import {
    type ChunkMessage,
    type CursorMessage,
    type EventMessage,
    MessageType,
    type WsClient,
} from "./api/ws";
import { FileCache } from "./cache";
import { getChunksToPersist, revertOptimisticChunks } from "./chunkHandler";
import { isSameChunkMessage } from "./chunkUtils";
import { applyDiffs, computeDiff, type DiffChunk } from "./diff/diff";
import { handleEventMessage } from "./eventHandler";
import { type Deque, DequeRegistry } from "./messageQueue";
import type { FileDiff } from "./modals/conflict";
import type { Disk } from "./storage/storage";
import { generateSHA256Hash } from "./utils/crypto";
import type {
    CursorEventMap,
    CursorPosition,
    EventBus,
    ObsidianEventMap,
    Snapshot,
    SnapshotEventMap,
} from "./utils/eventBus";
import { isTextFile, isTextMime } from "./utils/mime";
import { sleep } from "./utils/sleep";

export type ConflictResolution = "remote" | "local" | "merge";
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
    private modifyPendingModifications: Map<number, Promise<void>> = new Map();
    private onChunkPendingModifications: Map<number, Promise<void>> = new Map();
    private suppressNextModify: Set<string> = new Set();

    constructor(
        storage: Disk,
        apiClient: ApiClient,
        wsClient: WsClient,
        contracts: Contracts,
        opts: Options,
    ) {
        this.storage = storage;
        this.apiClient = apiClient;
        this.wsClient = wsClient;
        this.contracts = contracts;
        this.options = opts;

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

            await Promise.allSettled(filesToPush);
        } catch (error) {
            log.error("error while pushing local files", error);
        }
    }

    /**
     * Publish to the server the local unsynchronized files
     */
    async fetchRemoteFiles() {
        try {
            const files = await this.apiClient.fetchFiles();
            log.info(`fetched ${files.length} files from remote`);
            log.debug(files);

            const fetchRemotePromises = files.map(async (file) => {
                const exists = await this.storage.exists(file.workspacePath);

                // Handle new files
                if (!exists) {
                    const remoteFile = await this.apiClient.fetchFile(file.id);
                    this.fileCache.create(remoteFile);
                    await this.storage.write(file.workspacePath, remoteFile.content);
                    return;
                }

                // Handle binary
                if (!isTextMime(file.mimeType)) {
                    const localBinaryContent = await this.storage.readBinary(file.workspacePath);
                    const localHash = await generateSHA256Hash(localBinaryContent);

                    const fileToCache: FileWithContent = {
                        ...file,
                        content: localBinaryContent,
                    };

                    if (localHash !== file.hash) {
                        const remoteFile = await this.apiClient.fetchFile(file.id);
                        await this.storage.write(file.workspacePath, remoteFile.content, {
                            force: true,
                        });
                        fileToCache.content = remoteFile.content;
                    }

                    this.fileCache.create(fileToCache);
                    return;
                }

                // Handle Text
                if (isTextMime(file.mimeType)) {
                    const localTextContent = await this.storage.readText(file.workspacePath);
                    const localHash = await generateSHA256Hash(localTextContent);

                    const fileToCache: FileWithContent = {
                        ...file,
                        content: localTextContent,
                    };

                    if (localHash === file.hash) {
                        this.fileCache.create(fileToCache);
                        return;
                    }

                    const remoteFile = await this.apiClient.fetchFile(file.id);
                    const localStat = await this.storage.stat(file.workspacePath);
                    const localFileMtime = new Date(localStat?.mtime ?? localStat?.ctime ?? 0);
                    const remoteFileMtime = new Date(remoteFile.updatedAt);

                    if (typeof remoteFile.content !== "string") {
                        log.error(
                            `critical error during conflict, expected "string" got "${typeof remoteFile.content}"`,
                        );
                        return;
                    }

                    // Handle conflict
                    switch (this.options.conflictResolution) {
                        case "merge": {
                            log.debug(
                                `handling conflict on file "${file.workspacePath}", using merge tool`,
                            );
                            const mergedContent = await this.contracts.diffModal(
                                file.workspacePath,
                                {
                                    content: localTextContent,
                                    lastUpdate: localFileMtime,
                                },
                                {
                                    content: remoteFile.content,
                                    lastUpdate: remoteFileMtime,
                                },
                            );

                            fileToCache.content = mergedContent;
                            this.fileCache.create(fileToCache);

                            await this.storage.write(file.workspacePath, mergedContent, {
                                force: true,
                            });

                            const chunks = computeDiff(remoteFile.content, mergedContent);
                            this.sendChunks(file.id, file.version, chunks);
                            break;
                        }
                        case "local": {
                            const chunks = computeDiff(remoteFile.content, localTextContent);
                            if (chunks.length === 0) {
                                return;
                            }

                            log.debug(
                                `handling conflict on file "${file.workspacePath}", overwriting remote copy`,
                            );

                            fileToCache.content = localTextContent;
                            fileToCache.updatedAt = new Date(localStat?.mtime ?? "").toISOString();
                            this.fileCache.create(fileToCache);

                            this.sendChunks(file.id, file.version, chunks);
                            break;
                        }
                        case "remote": {
                            log.debug(
                                `handling conflict on file "${file.workspacePath}", overwriting local copy`,
                            );
                            fileToCache.content = remoteFile.content;
                            this.fileCache.create(fileToCache);

                            await this.storage.write(file.workspacePath, remoteFile.content, {
                                force: true,
                            });
                            break;
                        }
                        default:
                            log.warn(
                                `conflict on file "${file.workspacePath}" not solved, invalid strategy ${this.options.conflictResolution}`,
                            );
                            break;
                    }
                    return;
                }

                log.warn(`unexpected reconciliation status for "${file.workspacePath}"`);
            });

            await Promise.allSettled(fetchRemotePromises);
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

        const pending = this.modifyPendingModifications.get(fileId);
        if (pending) {
            await pending;
        }

        let resolveModification: () => void;
        const modificationPromise = new Promise<void>((resolve) => {
            resolveModification = resolve;
        });
        this.onChunkPendingModifications.set(fileId, modificationPromise);

        try {
            let updatedContent = file.content;
            const deque = this.messageQueueRegistry.getDeque(fileId);
            const isAckMessage = !deque.isEmpty() && isSameChunkMessage(data, deque.peekFront());
            if (isAckMessage) {
                this.handleAckMessage(file, deque);
            } else {
                const chunksToPersist = await getChunksToPersist(data, file, this.apiClient);
                updatedContent = await this.storage.readText(file.workspacePath);
                // reverting the optimistic changes
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
                this.suppressNextModify.add(file.workspacePath);
                await this.storage.modifyText(file.workspacePath, updatedContent);
            }

            file.version = version;
            file.content = updatedContent;
            this.fileCache.setById(file.id, file);
        } catch (error) {
            log.error(error);
        } finally {
            // biome-ignore lint/style/noNonNullAssertion: <explanation>
            resolveModification!();
            this.onChunkPendingModifications.delete(fileId);
        }
    }

    private handleAckMessage(file: File, deque: Deque<ChunkMessage>): void {
        log.debug(`[onChunkMessage] ack message ${file.workspacePath} ${file.id}`);
        deque.removeFront();
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

        if (this.suppressNextModify.has(file.path)) {
            this.suppressNextModify.delete(file.path);
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

        const pendingChunk = this.onChunkPendingModifications.get(cachedFile.id);
        if (pendingChunk) {
            await pendingChunk;
        }

        const pendingModify = this.modifyPendingModifications.get(cachedFile.id);
        if (pendingModify) {
            await pendingModify;
        }

        let resolveModification: () => void;
        const modificationPromise = new Promise<void>((resolve) => {
            resolveModification = resolve;
        });

        this.modifyPendingModifications.set(cachedFile.id, modificationPromise);

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
            // biome-ignore lint/style/noNonNullAssertion: <explanation>
            resolveModification!();
            this.modifyPendingModifications.delete(cachedFile.id);
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

            await Promise.allSettled(
                this.fileCache
                    .find((f) => f.workspacePath.startsWith(file.path + path.sep))
                    .map((f) => deleteFile(f.id)),
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

            await Promise.allSettled(renamePromises);

            const msg: EventMessage = {
                type: MessageType.Rename,
                fileId: 0,
                objectType: "folder",
                workspacePath: oldPath,
            };
            this.wsClient.sendMessage(msg);

            // give time to obsidian to update cache
            for (let i = 0; i < 10; i++) {
                const filesPostRename = await this.storage.listFiles({
                    prefix: oldWorkspacePath,
                });
                if (filesPostRename.length === 0) {
                    this.storage.delete(oldPath, { force: true });
                    break;
                }
                await sleep(100);
            }
        }
    }
    // ---------- END ---------

    // ---------- Snapshot events ---------
    async snapshotFileChanged(data: { path: string }) {
        log.debug("[snapshot]: file-changed", data);
        const cachedFile = this.fileCache.getByPath(data.path);
        if (cachedFile == null) {
            log.error(`file '${data.path}' not found`);
            return;
        }

        try {
            const snapshot = await this.apiClient.fetchSnapshots(cachedFile.id);
            this.contracts.snapshotEventBus.emit(
                "snapshots-list-updated",
                snapshot.map((snapshot) => {
                    return {
                        path: snapshot.workspacePath,
                        version: snapshot.version,
                        fileId: snapshot.fileId,
                        createdAt: snapshot.createdAt,
                    };
                }),
            );
        } catch (error) {
            log.error(error);
        }
    }

    async snapshotSelected(snapshot: Snapshot) {
        log.debug("[snapshot]: snapshot-selected", snapshot);
        const cachedFile = this.fileCache.getById(snapshot.fileId);
        if (cachedFile == null) {
            log.error(`file '${snapshot.fileId}' not found`);
            return;
        }

        try {
            const snapshotWithContent = await this.apiClient.fetchSnapshot(
                snapshot.fileId,
                snapshot.version,
            );

            const mergedContent = await this.contracts.diffModal(
                cachedFile.workspacePath,
                {
                    content: cachedFile.content as string,
                    lastUpdate: new Date(cachedFile.updatedAt),
                },
                {
                    content: snapshotWithContent.content as string,
                    lastUpdate: new Date(snapshotWithContent.createdAt),
                },
            );

            const chunks = computeDiff(cachedFile.content as string, mergedContent);

            cachedFile.content = mergedContent;
            this.fileCache.setById(cachedFile.id, cachedFile);

            await this.storage.write(cachedFile.workspacePath, mergedContent, {
                force: true,
            });

            this.sendChunks(cachedFile.id, cachedFile.version, chunks);
        } catch (error) {
            log.error(error);
        }
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
