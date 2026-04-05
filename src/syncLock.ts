/**
 * Coordinates concurrency between handleChunkMessage and modify for a file.
 *
 * - Only one chunk or modify operation runs at a time per file
 * - suppressNextModify prevents echo loops when we write to disk from a chunk
 *
 * INVARIANT: acquireChunkLock/acquireModifyLock are NOT re-entrant for the same
 * fileId. A second acquire overwrites the first lock's promise, silently
 * releasing it. Callers must serialize per-fileId access externally (chunk
 * messages go through AsyncMessageQueue; modify events are single-threaded
 * by the Obsidian vault event loop). Always call waitFor* before acquire*.
 */
export class SyncLock {
    private chunkLocks = new Map<number, Promise<void>>();
    private modifyLocks = new Map<number, Promise<void>>();
    private suppressedPaths = new Set<string>();

    async waitForChunk(fileId: number): Promise<void> {
        const pending = this.chunkLocks.get(fileId);
        if (pending) await pending;
    }

    async waitForModify(fileId: number): Promise<void> {
        const pending = this.modifyLocks.get(fileId);
        if (pending) await pending;
    }

    acquireChunkLock(fileId: number): () => void {
        let resolve: () => void;
        const promise = new Promise<void>((r) => {
            resolve = r;
        });
        this.chunkLocks.set(fileId, promise);

        return () => {
            resolve?.();
            this.chunkLocks.delete(fileId);
        };
    }

    acquireModifyLock(fileId: number): () => void {
        let resolve: () => void;
        const promise = new Promise<void>((r) => {
            resolve = r;
        });
        this.modifyLocks.set(fileId, promise);

        return () => {
            resolve?.();
            this.modifyLocks.delete(fileId);
        };
    }

    suppressModify(path: string): void {
        this.suppressedPaths.add(path);
    }

    consumeSuppression(path: string): boolean {
        return this.suppressedPaths.delete(path);
    }
}
