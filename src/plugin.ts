import type { TAbstractFile } from "obsidian";
import path from "path-browserify";
import { log } from "src/logger/logger";
import type { ApiClient, File, FileWithContent } from "./api/api";
import { type ChunkMessage, type EventMessage, MessageType, type WsClient } from "./api/ws";
import { FileCache } from "./cache";
import { type DiffChunk, computeDiff, invertDiff } from "./diff/diff";
import { type Deque, DequeRegistry } from "./messageQueue";
import type { FileDiff } from "./modals/conflict";
import type { Disk } from "./storage/storage";
import { shallowEqualStrict } from "./utils/comparison";
import { generateSHA256Hash } from "./utils/crypto";
import { isTextMime } from "./utils/mime";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Events {
    create(file: TAbstractFile): Promise<void>;
    modify(file: TAbstractFile): Promise<void>;
    delete(file: TAbstractFile): Promise<void>;
    rename(file: TAbstractFile, oldPath: string): Promise<void>;
}

export type ConflictResolution = "remote" | "local" | "merge";
export interface Options {
    conflictResolution: ConflictResolution;
}

interface Modals {
    diffModal(filename: string, local: FileDiff, remote: FileDiff): Promise<string>;
}

export class Syncinator {
    private storage: Disk;
    private fileCache: FileCache = new FileCache();
    private apiClient: ApiClient;
    private wsClient: WsClient;
    private messageQueueRegistry = new DequeRegistry<number, ChunkMessage>();
    options: Options = { conflictResolution: "remote" };
    modals: Modals;
    private lockedFiles = new Set<number>();

    events: Events;

    constructor(
        storage: Disk,
        apiClient: ApiClient,
        wsClient: WsClient,
        modals: Modals,
        opts: Options,
    ) {
        this.storage = storage;
        this.apiClient = apiClient;
        this.wsClient = wsClient;

        this.wsClient.onChunkMessage(this.handleChunkMessage.bind(this));
        this.wsClient.onEventMessage(this.handleEventMessage.bind(this));
        this.wsClient.connect();

        this.events = {
            create: this.create.bind(this),
            delete: this.delete.bind(this),
            modify: this.modify.bind(this),
            rename: this.rename.bind(this),
        };

        this.modals = modals;
        this.options = opts;
    }

    async init() {
        await this.fetchRemoteFiles();
        await this.pushLocalFiles();
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
                        await this.storage.write(file.workspacePath, remoteFile.content);
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
                            const mergedContent = await this.modals.diffModal(
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

                            log.debug(
                                `handling conflict on file "${file.workspacePath}", using merge tool`,
                            );

                            fileToCache.content = mergedContent;
                            this.fileCache.create(fileToCache);

                            await this.storage.write(file.workspacePath, mergedContent, {
                                force: true,
                            });

                            const chunks = computeDiff(remoteFile.content, mergedContent);
                            if (chunks.length > 0) {
                                const msg: ChunkMessage = {
                                    type: MessageType.Chunk,
                                    fileId: file.id,
                                    chunks,
                                    version: file.version,
                                };
                                this.messageQueueRegistry.getDeque(file.id).addBack(msg);
                                this.wsClient.sendMessage(msg);
                            }
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

                            const msg: ChunkMessage = {
                                type: MessageType.Chunk,
                                fileId: file.id,
                                chunks,
                                version: file.version,
                            };
                            this.wsClient.sendMessage(msg);
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
        const { fileId } = data;

        if (this.lockedFiles.has(fileId)) {
            log.error(`file ${fileId} already locked!`);
            return;
        }

        this.lockedFiles.add(fileId);

        try {
            const { fileId, version } = data;
            const file = this.fileCache.getById(fileId);

            if (!file) {
                throw new Error(`File '${fileId}' not found`);
            }

            const deque = this.messageQueueRegistry.getDeque(fileId);
            const isAckMessage = !deque.isEmpty() && isSameChunkMessage(data, deque.peekFront());
            if (isAckMessage) {
                this.handleAckMessage(file, version, deque);
                return;
            }

            // reverting the optimistic changes
            if (!deque.isEmpty()) {
                await this.handleOutOfSyncChunks(file, deque);
            }

            const chunksToPersist = await this.getChunksToPersist(data, file);
            const content = await this.storage.persistChunks(file.workspacePath, chunksToPersist);

            file.version = version;
            file.content = content;
            this.fileCache.setById(file.id, file);
        } catch (error) {
            log.error(error);
        } finally {
            this.lockedFiles.delete(fileId);
        }
    }

    private handleAckMessage(file: File, version: number, deque: Deque<ChunkMessage>): void {
        log.debug(`[onChunkMessage] ack message ${file.workspacePath} ${file.id}`);
        this.fileCache.setVersion(file.id, version);
        deque.removeFront();
    }

    private async handleOutOfSyncChunks(file: File, deque: Deque<ChunkMessage>): Promise<void> {
        log.debug(`[onChunkMessage] chunk out of sync ${file.workspacePath} ${file.id}`);

        while (!deque.isEmpty()) {
            const cm = deque.removeFront();
            for (const chunk of cm.chunks) {
                const inverse = invertDiff(chunk);
                await this.storage.persistChunk(file.workspacePath, inverse);
            }
        }
    }

    private async getChunksToPersist(data: ChunkMessage, file: File): Promise<DiffChunk[]> {
        const { fileId, chunks, version } = data;
        const chunksToPersist: DiffChunk[] = [];

        // fetch missing versions
        if (file.version + 1 !== version) {
            log.debug(`[onChunkMessage] missing intermediate msg ${file.workspacePath} ${file.id}`);
            const operations = await this.apiClient.fetchOperations(fileId, file.version);

            let currVersion = file.version;
            for (const operation of operations) {
                if (operation.version >= version) {
                    break;
                }

                if (currVersion + 1 !== operation.version) {
                    throw new Error(
                        `Missing operation in history for file ${file.workspacePath} ${fileId}`,
                    );
                }

                chunksToPersist.push(...operation.operation);
                currVersion = operation.version;
            }
        }

        chunksToPersist.push(...chunks);
        return chunksToPersist;
    }
    // ---------- END ---------

    // ---------- EventMessage ---------
    async handleCreateEvent(event: EventMessage) {
        if (event.objectType === "file") {
            const fileApi = await this.apiClient.fetchFile(event.fileId);
            this.fileCache.create(fileApi);
            await this.storage.write(fileApi.workspacePath, fileApi.content);
        } else if (event.objectType === "folder") {
            await this.storage.write(event.workspacePath, "", { isDir: true });
        } else {
            log.error("[socket] unknown", event);
        }
    }

    async handleDeleteEvent(event: EventMessage) {
        if (event.objectType === "file") {
            const file = this.fileCache.getById(event.fileId);
            if (!file) {
                log.warn(
                    `[socket] cannot delete file ${event.fileId} as it is not present in current workspace`,
                );
                return;
            }
            await this.storage.delete(file.workspacePath, { force: true });
            this.fileCache.deleteById(file.id);
        } else if (event.objectType === "folder") {
            const files = await this.storage.listFiles({
                prefix: event.workspacePath,
            });
            for (const file of files) {
                this.fileCache.deleteByPath(file.path);
            }
            await this.storage.delete(event.workspacePath, { force: true });
        } else {
            log.error("[socket] unknown", event);
        }
    }

    async handleRenameEvent(event: EventMessage) {
        if (event.objectType === "file") {
            await this.handleFileRenameEvent(event);
        } else if (event.objectType === "folder") {
            await this.handleFolderRenameEvent(event);
        } else {
            log.error("[socket] unknown", event);
        }
    }

    async handleFileRenameEvent(event: EventMessage) {
        const file = this.fileCache.getById(event.fileId);
        if (!file) {
            log.warn(`[socket] cannot rename file ${event.fileId}. Fetching from remote`);
            const fileApi = await this.apiClient.fetchFile(event.fileId);
            this.fileCache.create(fileApi);
            await this.storage.write(fileApi.workspacePath, fileApi.content);
            return;
        }

        const fileApi = await this.apiClient.fetchFile(event.fileId);
        const oldPath = file.workspacePath;
        const newPath = fileApi.workspacePath;
        this.fileCache.setPath(file.id, newPath);
        await this.storage.rename(oldPath, newPath);
    }

    async handleFolderRenameEvent(event: EventMessage) {
        const workspacePath = event.workspacePath.endsWith(path.sep)
            ? event.workspacePath
            : event.workspacePath + path.sep;

        const files = await this.storage.listFiles({ prefix: workspacePath });
        if (files.length === 0) {
            log.error("[socket] trying to rename not existing folder");
            return;
        }

        for (const file of files) {
            const fileDesc = this.fileCache.getByPath(file.path);
            if (!fileDesc) continue;

            const fileApi = await this.apiClient.fetchFile(fileDesc.id);
            const oldPath = fileDesc.workspacePath;
            const newPath = fileApi.workspacePath;

            if (oldPath !== newPath) {
                this.fileCache.setUpdatedAt(fileDesc.id, fileApi.updatedAt);
                this.fileCache.setPath(fileDesc.id, newPath);
                await this.storage.rename(oldPath, fileApi.workspacePath);
            }
        }

        // give time to obsidian to update cache
        for (let i = 0; i < 10; i++) {
            const filesPostRename = await this.storage.listFiles({
                prefix: workspacePath,
            });
            if (filesPostRename.length === 0) {
                this.storage.delete(event.workspacePath);
                break;
            }
            await sleep(100);
        }
    }

    async handleEventMessage(event: EventMessage) {
        log.debug("[socket]: message", event);
        switch (event.type) {
            case MessageType.Create:
                await this.handleCreateEvent(event);
                break;
            case MessageType.Delete:
                await this.handleDeleteEvent(event);
                break;
            case MessageType.Rename:
                await this.handleRenameEvent(event);
                break;
            default:
                log.error(`[socket] unknown event ${event}`);
        }
    }
    // ---------- END ---------

    // ---------- Obsidian events ---------
    private async create(file: TAbstractFile) {
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

    private async modify(file: TAbstractFile) {
        log.debug("[event]: modify", file);
        const cachedFile = this.fileCache.getByPath(file.path);
        if (cachedFile == null) {
            log.error(`file '${file.path}' not found`);
            return;
        }

        // FIXME: with this method if another client continues to write I will never
        // acquire the lock
        if (this.lockedFiles.has(cachedFile.id)) {
            return;
        }

        if (!isTextMime(cachedFile.mimeType) || typeof cachedFile.content !== "string") {
            return;
        }

        const newContent = await this.storage.readText(file.path);
        const chunks = computeDiff(cachedFile.content, newContent);

        cachedFile.content = newContent;
        this.fileCache.setById(cachedFile.id, cachedFile);

        if (chunks.length > 0) {
            log.debug("modify", {
                fileId: cachedFile.id,
                chunks,
                newContent,
            });

            const msg: ChunkMessage = {
                type: MessageType.Chunk,
                fileId: cachedFile.id,
                chunks,
                version: cachedFile.version,
            };
            this.messageQueueRegistry.getDeque(cachedFile.id).addBack(msg);
            this.wsClient.sendMessage(msg);
        }
    }

    private async delete(file: TAbstractFile) {
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

    private async rename(file: TAbstractFile, oldPath: string) {
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
            log.warn(`missing file for rename: "${oldPath}", probably a folder`);
            const oldWorkspacePath = oldPath.endsWith(path.sep) ? oldPath : oldPath + path.sep;

            const folderFiles = await this.storage.listFiles({
                prefix: oldWorkspacePath,
            });

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

    cacheDump() {
        return this.fileCache.dump().sort((a, b) => a.id - b.id);
    }
}

function isSameChunkMessage(fromWs: ChunkMessage, fromDeque: ChunkMessage): boolean {
    if (fromWs.chunks.length !== fromDeque.chunks.length) {
        return false;
    }

    for (let i = 0; i < fromWs.chunks.length; i++) {
        if (!shallowEqualStrict(fromWs.chunks[i], fromDeque.chunks[i])) {
            return false;
        }
    }

    // +1 because this the server acks the message with a +1 version
    const sameVersion = fromWs.version === fromDeque.version + 1;
    const sameType = fromWs.type === fromDeque.type;

    return sameVersion && sameType;
}
