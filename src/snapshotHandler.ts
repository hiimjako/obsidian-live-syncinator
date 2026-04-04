import { log } from "src/logger/logger";
import type { ApiClient } from "./api/api";
import type { FileCache } from "./cache";
import { computeDiff, type DiffChunk } from "./diff/diff";
import type { FileDiff } from "./modals/conflict";
import type { Disk } from "./storage/storage";
import type { EventBus, Snapshot, SnapshotEventMap } from "./utils/eventBus";

interface SnapshotFileChangedDeps {
    fileCache: FileCache;
    apiClient: Pick<ApiClient, "fetchSnapshots">;
    snapshotEventBus: EventBus<SnapshotEventMap>;
}

export async function snapshotFileChanged(data: { path: string }, deps: SnapshotFileChangedDeps) {
    log.debug("[snapshot]: file-changed", data);
    const cachedFile = deps.fileCache.getByPath(data.path);
    if (cachedFile == null) {
        log.error(`file '${data.path}' not found`);
        return;
    }

    try {
        const snapshots = await deps.apiClient.fetchSnapshots(cachedFile.id);
        deps.snapshotEventBus.emit(
            "snapshots-list-updated",
            snapshots.map((s) => ({
                path: s.workspacePath,
                version: s.version,
                fileId: s.fileId,
                createdAt: s.createdAt,
            })),
        );
    } catch (error) {
        log.error(error);
    }
}

interface SnapshotSelectedDeps {
    fileCache: FileCache;
    apiClient: Pick<ApiClient, "fetchSnapshot">;
    diffModal: (filename: string, local: FileDiff, remote: FileDiff) => Promise<string>;
    storage: Pick<Disk, "write">;
    sendChunks: (fileId: number, version: number, chunks: DiffChunk[]) => void;
}

export async function snapshotSelected(snapshot: Snapshot, deps: SnapshotSelectedDeps) {
    log.debug("[snapshot]: snapshot-selected", snapshot);
    const cachedFile = deps.fileCache.getById(snapshot.fileId);
    if (cachedFile == null) {
        log.error(`file '${snapshot.fileId}' not found`);
        return;
    }

    try {
        const snapshotWithContent = await deps.apiClient.fetchSnapshot(
            snapshot.fileId,
            snapshot.version,
        );

        const mergedContent = await deps.diffModal(
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
        deps.fileCache.setById(cachedFile.id, cachedFile);

        await deps.storage.write(cachedFile.workspacePath, mergedContent, {
            force: true,
        });

        deps.sendChunks(cachedFile.id, cachedFile.version, chunks);
    } catch (error) {
        log.error(error);
    }
}
