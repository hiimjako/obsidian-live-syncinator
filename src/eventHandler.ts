import path from "path-browserify";
import { log } from "src/logger/logger";
import type { ApiClient } from "./api/api";
import { type EventMessage, MessageType } from "./api/ws";
import type { FileCache } from "./cache";
import type { Disk } from "./storage/storage";
import { sleep } from "./utils/sleep";

export const OBSIDIAN_CACHE_POLL_COUNT = 10;
export const OBSIDIAN_CACHE_POLL_INTERVAL_MS = 100;

interface EventHandlerDeps {
    apiClient: Pick<ApiClient, "fetchFile">;
    storage: Pick<Disk, "write" | "delete" | "listFiles" | "rename">;
    fileCache: FileCache;
}

export async function handleEventMessage(event: EventMessage, deps: EventHandlerDeps) {
    log.debug("[socket]: event message", event);
    switch (event.type) {
        case MessageType.Create:
            await handleCreateEvent(event, deps);
            break;
        case MessageType.Delete:
            await handleDeleteEvent(event, deps);
            break;
        case MessageType.Rename:
            await handleRenameEvent(event, deps);
            break;
        default:
            log.error(`[socket] unknown event ${event}`);
    }
}

async function handleCreateEvent(event: EventMessage, deps: EventHandlerDeps) {
    if (event.objectType === "file") {
        const fileApi = await deps.apiClient.fetchFile(event.fileId);
        deps.fileCache.create(fileApi);
        await deps.storage.write(fileApi.workspacePath, fileApi.content);
    } else if (event.objectType === "folder") {
        await deps.storage.write(event.workspacePath, "", { isDir: true });
    } else {
        log.error("[socket] unknown", event);
    }
}

async function handleDeleteEvent(event: EventMessage, deps: EventHandlerDeps) {
    if (event.objectType === "file") {
        const file = deps.fileCache.getById(event.fileId);
        if (!file) {
            log.warn(
                `[socket] cannot delete file ${event.fileId} as it is not present in current workspace`,
            );
            return;
        }
        await deps.storage.delete(file.workspacePath, { force: true });
        deps.fileCache.deleteById(file.id);
    } else if (event.objectType === "folder") {
        const files = await deps.storage.listFiles({
            prefix: event.workspacePath,
        });
        for (const file of files) {
            deps.fileCache.deleteByPath(file.path);
        }
        await deps.storage.delete(event.workspacePath, { force: true });
    } else {
        log.error("[socket] unknown", event);
    }
}

async function handleRenameEvent(event: EventMessage, deps: EventHandlerDeps) {
    if (event.objectType === "file") {
        await handleFileRenameEvent(event, deps);
    } else if (event.objectType === "folder") {
        await handleFolderRenameEvent(event, deps);
    } else {
        log.error("[socket] unknown", event);
    }
}

async function handleFileRenameEvent(event: EventMessage, deps: EventHandlerDeps) {
    const file = deps.fileCache.getById(event.fileId);
    if (!file) {
        log.warn(`[socket] cannot rename file ${event.fileId}. Fetching from remote`);
        const fileApi = await deps.apiClient.fetchFile(event.fileId);
        deps.fileCache.create(fileApi);
        await deps.storage.write(fileApi.workspacePath, fileApi.content);
        return;
    }

    const fileApi = await deps.apiClient.fetchFile(event.fileId);
    const oldPath = file.workspacePath;
    const newPath = fileApi.workspacePath;
    deps.fileCache.setPath(file.id, newPath);
    await deps.storage.rename(oldPath, newPath);
}

async function handleFolderRenameEvent(event: EventMessage, deps: EventHandlerDeps) {
    const workspacePath = event.workspacePath.endsWith(path.sep)
        ? event.workspacePath
        : event.workspacePath + path.sep;

    const files = await deps.storage.listFiles({ prefix: workspacePath });
    if (files.length === 0) {
        log.error("[socket] trying to rename not existing folder");
        return;
    }

    for (const file of files) {
        const fileDesc = deps.fileCache.getByPath(file.path);
        if (!fileDesc) continue;

        const fileApi = await deps.apiClient.fetchFile(fileDesc.id);
        const oldPath = fileDesc.workspacePath;
        const newPath = fileApi.workspacePath;

        if (oldPath !== newPath) {
            deps.fileCache.setUpdatedAt(fileDesc.id, fileApi.updatedAt);
            deps.fileCache.setPath(fileDesc.id, newPath);
            await deps.storage.rename(oldPath, fileApi.workspacePath);
        }
    }

    for (let i = 0; i < OBSIDIAN_CACHE_POLL_COUNT; i++) {
        const filesPostRename = await deps.storage.listFiles({
            prefix: workspacePath,
        });
        if (filesPostRename.length === 0) {
            deps.storage.delete(event.workspacePath);
            break;
        }
        await sleep(OBSIDIAN_CACHE_POLL_INTERVAL_MS);
    }
}
