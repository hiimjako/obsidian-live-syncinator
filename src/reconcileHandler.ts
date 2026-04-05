import { log } from "src/logger/logger";
import type { ApiClient, File, FileWithContent } from "./api/api";
import type { FileCache } from "./cache";
import { computeDiff, type DiffChunk } from "./diff/diff";
import type { FileDiff } from "./modals/conflict";
import type { ConflictResolution } from "./plugin";
import type { Disk } from "./storage/storage";
import { generateSHA256Hash } from "./utils/crypto";
import { isTextMime } from "./utils/mime";

interface ReconcileDeps {
    apiClient: Pick<ApiClient, "fetchFile">;
    storage: Pick<Disk, "exists" | "readBinary" | "readText" | "write" | "stat">;
    fileCache: FileCache;
    conflictResolution: ConflictResolution;
    diffModal: (filename: string, local: FileDiff, remote: FileDiff) => Promise<string>;
    sendChunks: (fileId: number, version: number, chunks: DiffChunk[]) => void;
}

export async function reconcileFile(file: File, deps: ReconcileDeps): Promise<void> {
    const exists = await deps.storage.exists(file.workspacePath);

    if (!exists) {
        return reconcileNewFile(file, deps);
    }

    if (!isTextMime(file.mimeType)) {
        return reconcileBinaryFile(file, deps);
    }

    return reconcileTextFile(file, deps);
}

async function reconcileNewFile(file: File, deps: ReconcileDeps): Promise<void> {
    const remoteFile = await deps.apiClient.fetchFile(file.id);
    deps.fileCache.create(remoteFile);
    await deps.storage.write(file.workspacePath, remoteFile.content);
}

async function reconcileBinaryFile(file: File, deps: ReconcileDeps): Promise<void> {
    const localContent = await deps.storage.readBinary(file.workspacePath);
    const localHash = await generateSHA256Hash(localContent);

    const fileToCache: FileWithContent = { ...file, content: localContent };

    if (localHash !== file.hash) {
        const remoteFile = await deps.apiClient.fetchFile(file.id);
        await deps.storage.write(file.workspacePath, remoteFile.content, { force: true });
        fileToCache.content = remoteFile.content;
    }

    deps.fileCache.create(fileToCache);
}

async function reconcileTextFile(file: File, deps: ReconcileDeps): Promise<void> {
    const localContent = await deps.storage.readText(file.workspacePath);
    const localHash = await generateSHA256Hash(localContent);

    const fileToCache: FileWithContent = { ...file, content: localContent };

    if (localHash === file.hash) {
        deps.fileCache.create(fileToCache);
        return;
    }

    const remoteFile = await deps.apiClient.fetchFile(file.id);

    if (typeof remoteFile.content !== "string") {
        log.error(
            `critical error during conflict, expected "string" got "${typeof remoteFile.content}"`,
        );
        return;
    }

    const localStat = await deps.storage.stat(file.workspacePath);
    const localMtime = new Date(localStat?.mtime ?? localStat?.ctime ?? 0);
    const remoteMtime = new Date(remoteFile.updatedAt);

    await resolveConflict(file, deps, fileToCache, {
        localContent,
        remoteContent: remoteFile.content,
        localMtime,
        remoteMtime,
    });
}

interface ConflictContext {
    localContent: string;
    remoteContent: string;
    localMtime: Date;
    remoteMtime: Date;
}

async function resolveConflict(
    file: File,
    deps: ReconcileDeps,
    fileToCache: FileWithContent,
    ctx: ConflictContext,
): Promise<void> {
    switch (deps.conflictResolution) {
        case "merge": {
            log.debug(`handling conflict on file "${file.workspacePath}", using merge tool`);
            const mergedContent = await deps.diffModal(
                file.workspacePath,
                { content: ctx.localContent, lastUpdate: ctx.localMtime },
                { content: ctx.remoteContent, lastUpdate: ctx.remoteMtime },
            );

            fileToCache.content = mergedContent;
            deps.fileCache.create(fileToCache);
            await deps.storage.write(file.workspacePath, mergedContent, { force: true });

            const chunks = computeDiff(ctx.remoteContent, mergedContent);
            deps.sendChunks(file.id, file.version, chunks);
            break;
        }
        case "local": {
            const chunks = computeDiff(ctx.remoteContent, ctx.localContent);
            if (chunks.length === 0) {
                return;
            }

            log.debug(`handling conflict on file "${file.workspacePath}", overwriting remote copy`);
            fileToCache.content = ctx.localContent;
            fileToCache.updatedAt = ctx.localMtime.toISOString();
            deps.fileCache.create(fileToCache);
            deps.sendChunks(file.id, file.version, chunks);
            break;
        }
        case "remote": {
            log.debug(`handling conflict on file "${file.workspacePath}", overwriting local copy`);
            fileToCache.content = ctx.remoteContent;
            deps.fileCache.create(fileToCache);
            await deps.storage.write(file.workspacePath, ctx.remoteContent, { force: true });
            break;
        }
        default:
            log.warn(
                `conflict on file "${file.workspacePath}" not solved, invalid strategy ${deps.conflictResolution}`,
            );
    }
}
