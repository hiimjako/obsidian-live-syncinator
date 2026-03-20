import assert from "node:assert";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import type { Vault } from "obsidian";
import { ApiClient, type FileWithContent } from "./api/api";
import type { HttpClient } from "./api/http";
import { type ChunkMessage, MessageType, WsClient } from "./api/ws";
import { Operation } from "./diff/diff";
import { Syncinator } from "./plugin";
import { Disk } from "./storage/storage";
import { CreateVaultMock } from "./storage/storage.mock";
import {
    type CursorEventMap,
    EventBus,
    type ObsidianEventMap,
    type SnapshotEventMap,
} from "./utils/eventBus";

describe("modify serialization", () => {
    let vaultRootDir: string;
    let vault: Vault;
    let storage: Disk;
    let apiClient: ApiClient;
    let wsClient: WsClient;
    let syncinator: Syncinator;
    let obsidianEventBus: EventBus<ObsidianEventMap>;
    let sendMessage: ReturnType<typeof mock.method>;

    const filepath = "test.md";
    const initialContent = "a";

    const fileStub: FileWithContent = {
        id: 1,
        diskPath: "disk/test.md",
        workspacePath: filepath,
        mimeType: "text/markdown",
        hash: "fake",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        workspaceId: 1,
        version: 0,
        content: initialContent,
    };

    beforeEach(async () => {
        vaultRootDir = await fs.mkdtemp("/tmp/modify_test_");
        vault = CreateVaultMock(vaultRootDir);
        storage = new Disk(vault);

        const mockHttpClient = {
            get: async () => ({ status: 200, data: null, headers: new Headers() }),
            post: async () => ({ status: 201, data: null, headers: new Headers() }),
            patch: async () => ({ status: 200, data: null, headers: new Headers() }),
            delete: async () => ({ status: 204, data: null, headers: new Headers() }),
            setAuthorizationHeader: () => {},
        } as unknown as HttpClient;
        apiClient = new ApiClient(mockHttpClient);

        wsClient = new WsClient("ws", "127.0.0.1:9999", { maxReconnectAttempts: 0 });
        mock.method(wsClient, "connect", () => {});
        sendMessage = mock.method(wsClient, "sendMessage", () => {});

        obsidianEventBus = new EventBus<ObsidianEventMap>();

        syncinator = new Syncinator(
            storage,
            apiClient,
            wsClient,
            {
                diffModal: async () => "",
                snapshotEventBus: new EventBus<SnapshotEventMap>(),
                obsidianEventBus,
                cursorEventBus: new EventBus<CursorEventMap>(),
            },
            { conflictResolution: "remote" },
        );

        mock.method(apiClient, "fetchFile", async () => ({ ...fileStub }));

        await syncinator.handleEventMessage({
            type: MessageType.Create,
            fileId: fileStub.id,
            objectType: "file",
            workspacePath: filepath,
        });
    });

    afterEach(async () => {
        await fs.rm(vaultRootDir, { recursive: true, force: true });
        wsClient.close();
        mock.restoreAll();
    });

    test("sequential modifies should produce incremental diffs, not overlapping", async () => {
        const file = { path: filepath, vault, parent: null, name: "test.md" };

        // First edit: "a" -> "ab"
        await storage.write(filepath, "ab", { force: true });
        await obsidianEventBus.emit("modify", { file });

        // Second edit: "ab" -> "abc" (before any ACK)
        await storage.write(filepath, "abc", { force: true });
        await obsidianEventBus.emit("modify", { file });

        assert.equal(sendMessage.mock.callCount(), 2);

        const msg1 = sendMessage.mock.calls[0].arguments[0] as ChunkMessage;
        const msg2 = sendMessage.mock.calls[1].arguments[0] as ChunkMessage;

        // First modify: diff("a", "ab") = Add "b" at position 1
        assert.deepEqual(msg1.chunks, [{ type: Operation.Add, position: 1, text: "b", len: 1 }]);

        // Second modify should be INCREMENTAL: diff("ab", "abc") = Add "c" at position 2
        // BUG: without fix, it diffs against stale cache "a", producing Add "bc" at 1
        assert.deepEqual(msg2.chunks, [{ type: Operation.Add, position: 2, text: "c", len: 1 }]);
    });

    test("large diffs should be sent as a single message, not batched", async () => {
        const file = { path: filepath, vault, parent: null, name: "test.md" };

        // Create old/new content with many scattered differences to produce >10 chunks
        const oldContent = Array.from({ length: 20 }, (_, i) => `word${i}`).join(" ");
        const newContent = Array.from({ length: 20 }, (_, i) => `changed${i}`).join(" ");

        // Set cache to oldContent first
        await storage.write(filepath, oldContent, { force: true });
        await obsidianEventBus.emit("modify", { file });
        sendMessage.mock.resetCalls();

        // Now create a diff with many chunks
        await storage.write(filepath, newContent, { force: true });
        await obsidianEventBus.emit("modify", { file });

        assert.equal(sendMessage.mock.callCount(), 1);
        const msg = sendMessage.mock.calls[0].arguments[0] as ChunkMessage;
        assert.ok(msg.chunks.length > 10, `expected >10 chunks, got ${msg.chunks.length}`);
    });

    test("ACK should not re-apply content that was optimistically updated", async () => {
        const file = { path: filepath, vault, parent: null, name: "test.md" };

        // Edit: "a" -> "ab"
        await storage.write(filepath, "ab", { force: true });
        await obsidianEventBus.emit("modify", { file });

        // Verify optimistic update happened
        const cachePreAck = syncinator.cacheDump();
        assert.equal(cachePreAck[0].content, "ab");
        assert.equal(cachePreAck[0].version, 0);

        // Simulate ACK from server (version incremented by 1)
        await syncinator.handleChunkMessage({
            type: MessageType.Chunk,
            fileId: fileStub.id,
            chunks: [{ type: Operation.Add, position: 1, text: "b", len: 1 }],
            version: 1,
        });

        const cache = syncinator.cacheDump();
        assert.equal(cache.length, 1);
        assert.equal(cache[0].content, "ab");
        assert.equal(cache[0].version, 1);
    });
});
