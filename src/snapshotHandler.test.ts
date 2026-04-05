import assert from "node:assert";
import { describe, test } from "node:test";
import type { Snapshot as ApiSnapshot, FileWithContent, SnapshotWithContent } from "./api/api";
import { FileCache } from "./cache";
import type { DiffChunk } from "./diff/diff";
import { handleSnapshotFileChanged, handleSnapshotSelected } from "./snapshotHandler";
import { EventBus, type Snapshot, type SnapshotEventMap } from "./utils/eventBus";

function makeFileWithContent(overrides: Partial<FileWithContent> = {}): FileWithContent {
    return {
        id: 1,
        diskPath: "/disk/1",
        workspacePath: "test.md",
        mimeType: "text/plain",
        hash: "abc",
        createdAt: "2024-01-01",
        updatedAt: "2024-01-01",
        workspaceId: 1,
        version: 1,
        content: "current content",
        ...overrides,
    };
}

describe("handleSnapshotFileChanged", () => {
    test("should return early when file not in cache", async () => {
        let emitted = false;
        const bus = new EventBus<SnapshotEventMap>();
        bus.on("snapshots-list-updated", async () => {
            emitted = true;
        });

        await handleSnapshotFileChanged(
            { path: "missing.md" },
            {
                fileCache: new FileCache(),
                apiClient: { fetchSnapshots: async () => [] },
                snapshotEventBus: bus,
            },
        );

        assert.equal(emitted, false);
    });

    test("should emit snapshots-list-updated with fetched snapshots", async () => {
        const fileCache = new FileCache();
        fileCache.create(makeFileWithContent({ id: 1 }));

        const apiSnapshots: ApiSnapshot[] = [
            {
                fileId: 1,
                version: 3,
                diskPath: "/disk/1",
                hash: "abc",
                createdAt: "2024-01-03",
                type: "file",
                workspaceId: 1,
                mimeType: "text/plain",
                workspacePath: "test.md",
            },
        ];

        let emittedData: Snapshot[] = [];
        const bus = new EventBus<SnapshotEventMap>();
        bus.on("snapshots-list-updated", async (data) => {
            emittedData = data;
        });

        await handleSnapshotFileChanged(
            { path: "test.md" },
            {
                fileCache,
                apiClient: { fetchSnapshots: async () => apiSnapshots },
                snapshotEventBus: bus,
            },
        );

        assert.equal(emittedData.length, 1);
        assert.equal(emittedData[0].version, 3);
        assert.equal(emittedData[0].fileId, 1);
    });
});

describe("handleSnapshotSelected", () => {
    test("should return early when file not in cache", async () => {
        let diffCalled = false;

        await handleSnapshotSelected(
            { fileId: 99, version: 1, createdAt: "2024-01-01" },
            {
                fileCache: new FileCache(),
                apiClient: {
                    fetchSnapshot: async () => ({}) as SnapshotWithContent,
                },
                diffModal: async () => {
                    diffCalled = true;
                    return "";
                },
                storage: { write: async () => {} },
                sendChunks: () => {},
            },
        );

        assert.equal(diffCalled, false);
    });

    test("should apply merged content to cache, storage, and send chunks", async () => {
        const fileCache = new FileCache();
        fileCache.create(makeFileWithContent({ id: 1, content: "old content", version: 5 }));

        const writtenFiles: { path: string; content: string | ArrayBuffer }[] = [];
        const sentChunks: { fileId: number; version: number; chunks: DiffChunk[] }[] = [];

        await handleSnapshotSelected(
            { fileId: 1, version: 3, createdAt: "2024-01-01" },
            {
                fileCache,
                apiClient: {
                    fetchSnapshot: async (): Promise<SnapshotWithContent> => ({
                        fileId: 1,
                        version: 3,
                        diskPath: "/disk/1",
                        hash: "abc",
                        createdAt: "2024-01-01",
                        type: "file",
                        workspaceId: 1,
                        mimeType: "text/plain",
                        workspacePath: "test.md",
                        content: "snapshot content",
                    }),
                },
                diffModal: async () => "merged result",
                storage: {
                    write: async (p: string, c: string | ArrayBuffer) => {
                        writtenFiles.push({ path: p, content: c });
                    },
                },
                sendChunks: (fileId, version, chunks) => {
                    sentChunks.push({ fileId, version, chunks });
                },
            },
        );

        const cached = fileCache.getById(1);
        assert.ok(cached);
        assert.equal(cached.content, "merged result");

        assert.equal(writtenFiles.length, 1);
        assert.equal(writtenFiles[0].content, "merged result");

        assert.equal(sentChunks.length, 1);
        assert.equal(sentChunks[0].fileId, 1);
        assert.equal(sentChunks[0].version, 5);
    });
});
