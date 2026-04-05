import assert from "node:assert";
import { describe, test } from "node:test";
import type { File, Operation } from "./api/api";
import type { ChunkMessage } from "./api/ws";
import { MessageType } from "./api/ws";
import { getChunksToPersist, revertOptimisticChunks } from "./chunkHandler";
import type { DiffChunk } from "./diff/diff";
import { Operation as Op } from "./diff/diff";

function chunk(type: Op, position: number, len: number, text: string): DiffChunk {
    return { type, position, len, text };
}

function makeChunkMsg(chunks: DiffChunk[], version = 1): ChunkMessage {
    return { type: MessageType.Chunk, fileId: 1, version, chunks };
}

function makeFile(overrides: Partial<File> = {}): File {
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
        ...overrides,
    };
}

describe("revertOptimisticChunks", () => {
    test("should return initial content when no messages", () => {
        const result = revertOptimisticChunks([], "hello world");
        assert.equal(result, "hello world");
    });

    test("should revert a single insert", () => {
        const messages = [makeChunkMsg([chunk(Op.Add, 5, 3, "xyz")])];
        const result = revertOptimisticChunks(messages, "helloxyz world");
        assert.equal(result, "hello world");
    });

    test("should revert a single deletion", () => {
        const messages = [makeChunkMsg([chunk(Op.Remove, 5, 3, " wo")])];
        const result = revertOptimisticChunks(messages, "hellorld");
        assert.equal(result, "hello world");
    });

    test("should revert multiple messages in reverse order", () => {
        const messages = [
            makeChunkMsg([chunk(Op.Add, 0, 1, "A")]),
            makeChunkMsg([chunk(Op.Add, 0, 1, "B")]),
        ];
        const result = revertOptimisticChunks(messages, "BAhello");
        assert.equal(result, "hello");
    });
});

describe("getChunksToPersist", () => {
    test("should return incoming chunks when version matches", async () => {
        const file = makeFile({ version: 4 });
        const incomingChunk = chunk(Op.Add, 0, 0, "x");
        const msg = makeChunkMsg([incomingChunk], 5);

        const result = await getChunksToPersist(msg, file, {
            fetchOperations: async () => [],
        });
        assert.deepEqual(result, [incomingChunk]);
    });

    test("should prepend intermediate operations when versions are missing", async () => {
        const file = makeFile({ version: 2 });
        const incomingChunk = chunk(Op.Add, 0, 0, "new");
        const msg = makeChunkMsg([incomingChunk], 5);

        const intermediateOps: Operation[] = [
            {
                fileId: 1,
                version: 3,
                operation: [chunk(Op.Add, 0, 0, "a")],
                createdAt: "2024-01-01",
            },
            {
                fileId: 1,
                version: 4,
                operation: [chunk(Op.Add, 1, 0, "b")],
                createdAt: "2024-01-01",
            },
        ];

        const result = await getChunksToPersist(msg, file, {
            fetchOperations: async () => intermediateOps,
        });
        assert.equal(result.length, 3);
        assert.equal(result[0].text, "a");
        assert.equal(result[1].text, "b");
        assert.equal(result[2].text, "new");
    });

    test("should throw on gap in operation history", async () => {
        const file = makeFile({ version: 2 });
        const msg = makeChunkMsg([chunk(Op.Add, 0, 0, "x")], 5);

        await assert.rejects(
            () =>
                getChunksToPersist(msg, file, {
                    fetchOperations: async () => [
                        {
                            fileId: 1,
                            version: 4,
                            operation: [chunk(Op.Add, 0, 0, "a")],
                            createdAt: "2024-01-01",
                        },
                    ],
                }),
            { message: /Missing operation in history/ },
        );
    });
});
