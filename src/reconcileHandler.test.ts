import assert from "node:assert";
import { describe, test } from "node:test";
import type { File, FileWithContent } from "./api/api";
import { FileCache } from "./cache";
import type { DiffChunk } from "./diff/diff";
import { reconcileFile } from "./reconcileHandler";
import { generateSHA256Hash } from "./utils/crypto";

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

function makeDeps(overrides: Record<string, unknown> = {}) {
    const sentChunks: { fileId: number; version: number; chunks: DiffChunk[] }[] = [];
    const writtenFiles: { path: string; content: string | ArrayBuffer }[] = [];

    const defaults = {
        apiClient: {
            fetchFile: async (id: number): Promise<FileWithContent> => ({
                ...makeFile({ id }),
                content: "remote content",
            }),
        },
        storage: {
            exists: async () => false,
            readBinary: async () => new ArrayBuffer(0),
            readText: async () => "local content",
            write: async (path: string, content: string | ArrayBuffer) => {
                writtenFiles.push({ path, content });
            },
            stat: async () => ({
                type: "file" as const,
                ctime: Date.now(),
                mtime: Date.now(),
                size: 100,
            }),
        },
        fileCache: new FileCache(),
        conflictResolution: "remote" as const,
        diffModal: async () => "merged",
        sendChunks: (fileId: number, version: number, chunks: DiffChunk[]) => {
            sentChunks.push({ fileId, version, chunks });
        },
    };

    const deps = { ...defaults, ...overrides };
    return { deps, sentChunks, writtenFiles };
}

describe("reconcileFile", () => {
    test("should fetch and cache new files that don't exist locally", async () => {
        const { deps } = makeDeps();
        const file = makeFile();

        await reconcileFile(file, deps);

        const cached = deps.fileCache.getById(1);
        assert.ok(cached);
        assert.equal(cached.content, "remote content");
    });

    test("should write new file to storage", async () => {
        const { deps, writtenFiles } = makeDeps();
        const file = makeFile();

        await reconcileFile(file, deps);

        assert.equal(writtenFiles.length, 1);
        assert.equal(writtenFiles[0].path, "test.md");
        assert.equal(writtenFiles[0].content, "remote content");
    });

    test("should cache binary file when hashes match", async () => {
        const binaryContent = new TextEncoder().encode("binary data").buffer;
        const hash = await generateSHA256Hash(binaryContent);

        const { deps } = makeDeps({
            storage: {
                exists: async () => true,
                readBinary: async () => binaryContent,
                readText: async () => "",
                write: async () => {},
                stat: async () => ({ type: "file", ctime: 0, mtime: 0, size: 0 }),
            },
        });

        const file = makeFile({ mimeType: "application/octet-stream", hash });

        await reconcileFile(file, deps);

        const cached = deps.fileCache.getById(1);
        assert.ok(cached);
    });

    test("should cache text file when hashes match (no conflict)", async () => {
        const localContent = "same content";
        const hash = await generateSHA256Hash(localContent);

        const { deps } = makeDeps({
            storage: {
                exists: async () => true,
                readBinary: async () => new ArrayBuffer(0),
                readText: async () => localContent,
                write: async () => {},
                stat: async () => ({ type: "file", ctime: 0, mtime: 0, size: 0 }),
            },
        });

        const file = makeFile({ hash });
        await reconcileFile(file, deps);

        const cached = deps.fileCache.getById(1);
        assert.ok(cached);
        assert.equal(cached.content, localContent);
    });

    test("should overwrite local with remote on 'remote' conflict", async () => {
        const { deps, writtenFiles } = makeDeps({
            storage: {
                exists: async () => true,
                readBinary: async () => new ArrayBuffer(0),
                readText: async () => "local content",
                write: async (p: string, c: string) => {
                    writtenFiles.push({ path: p, content: c });
                },
                stat: async () => ({ type: "file", ctime: 0, mtime: 0, size: 0 }),
            },
        });
        // writtenFiles is from makeDeps closure, need to reference it
        const file = makeFile({ hash: "different" });

        await reconcileFile(file, deps);

        const cached = deps.fileCache.getById(1);
        assert.ok(cached);
        assert.equal(cached.content, "remote content");

        // should write to storage
        const writes = writtenFiles.filter((w) => w.path === "test.md");
        assert.ok(writes.length > 0);
    });

    test("should send chunks on 'local' conflict", async () => {
        const { deps, sentChunks } = makeDeps({
            conflictResolution: "local",
            storage: {
                exists: async () => true,
                readBinary: async () => new ArrayBuffer(0),
                readText: async () => "local different",
                write: async () => {},
                stat: async () => ({ type: "file", ctime: 0, mtime: Date.now(), size: 0 }),
            },
        });

        const file = makeFile({ hash: "different" });
        await reconcileFile(file, deps);

        assert.ok(sentChunks.length > 0);
        assert.equal(sentChunks[0].fileId, 1);
    });

    test("should fetch and write binary file when hashes differ", async () => {
        const localBinary = new TextEncoder().encode("local binary").buffer;
        const remoteBinary = new TextEncoder().encode("remote binary").buffer;

        const writtenFiles: { path: string; content: string | ArrayBuffer }[] = [];
        const { deps } = makeDeps({
            apiClient: {
                fetchFile: async () => ({
                    ...makeFile({ mimeType: "application/octet-stream" }),
                    content: remoteBinary,
                }),
            },
            storage: {
                exists: async () => true,
                readBinary: async () => localBinary,
                readText: async () => "",
                write: async (path: string, content: string | ArrayBuffer) => {
                    writtenFiles.push({ path, content });
                },
                stat: async () => ({ type: "file" as const, ctime: 0, mtime: 0, size: 0 }),
            },
        });

        const file = makeFile({ mimeType: "application/octet-stream", hash: "different" });
        await reconcileFile(file, deps);

        const cached = deps.fileCache.getById(1);
        assert.ok(cached);
        assert.equal(cached.content, remoteBinary);
        assert.equal(writtenFiles.length, 1);
        assert.equal(writtenFiles[0].content, remoteBinary);
    });

    test("should return early when remote text content is not a string", async () => {
        const { deps, sentChunks, writtenFiles } = makeDeps({
            apiClient: {
                fetchFile: async () => ({
                    ...makeFile(),
                    content: new ArrayBuffer(0),
                }),
            },
            storage: {
                exists: async () => true,
                readBinary: async () => new ArrayBuffer(0),
                readText: async () => "local content",
                write: async (p: string, c: string) => {
                    writtenFiles.push({ path: p, content: c });
                },
                stat: async () => ({ type: "file" as const, ctime: 0, mtime: 0, size: 0 }),
            },
        });

        const file = makeFile({ hash: "different" });
        await reconcileFile(file, deps);

        assert.equal(deps.fileCache.getById(1), undefined);
        assert.equal(sentChunks.length, 0);
        assert.equal(writtenFiles.length, 0);
    });

    test("should use diffModal on 'merge' conflict", async () => {
        let diffModalCalled = false;

        const { deps, writtenFiles } = makeDeps({
            conflictResolution: "merge",
            diffModal: async () => {
                diffModalCalled = true;
                return "merged result";
            },
            storage: {
                exists: async () => true,
                readBinary: async () => new ArrayBuffer(0),
                readText: async () => "local content",
                write: async (p: string, c: string) => {
                    writtenFiles.push({ path: p, content: c });
                },
                stat: async () => ({ type: "file", ctime: 0, mtime: 0, size: 0 }),
            },
        });

        const file = makeFile({ hash: "different" });
        await reconcileFile(file, deps);

        assert.ok(diffModalCalled);

        const cached = deps.fileCache.getById(1);
        assert.ok(cached);
        assert.equal(cached.content, "merged result");
    });
});
