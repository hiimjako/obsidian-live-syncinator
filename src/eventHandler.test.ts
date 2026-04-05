import assert from "node:assert";
import { describe, test } from "node:test";
import type { TFile } from "obsidian";
import type { FileWithContent } from "./api/api";
import { type EventMessage, MessageType } from "./api/ws";
import { FileCache } from "./cache";
import { handleEventMessage } from "./eventHandler";

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
        content: "file content",
        ...overrides,
    };
}

function makeDeps() {
    const writtenFiles: { path: string; content: string | ArrayBuffer }[] = [];
    const deletedPaths: string[] = [];
    const renamedPaths: { from: string; to: string }[] = [];
    const fileCache = new FileCache();

    return {
        deps: {
            apiClient: {
                fetchFile: async (id: number): Promise<FileWithContent> =>
                    makeFileWithContent({ id }),
            },
            storage: {
                write: async (path: string, content: string | ArrayBuffer) => {
                    writtenFiles.push({ path, content });
                },
                delete: async (path: string) => {
                    deletedPaths.push(path);
                },
                listFiles: async () => [] as TFile[],
                rename: async (from: string, to: string) => {
                    renamedPaths.push({ from, to });
                },
            },
            fileCache,
        },
        writtenFiles,
        deletedPaths,
        renamedPaths,
    };
}

function createEvent(overrides: Partial<EventMessage> = {}): EventMessage {
    return {
        type: MessageType.Create,
        fileId: 1,
        objectType: "file",
        workspacePath: "test.md",
        ...overrides,
    };
}

describe("handleEventMessage", () => {
    describe("create events", () => {
        test("should fetch and write file on create file event", async () => {
            const { deps, writtenFiles } = makeDeps();
            const event = createEvent({ type: MessageType.Create, objectType: "file", fileId: 1 });

            await handleEventMessage(event, deps);

            const cached = deps.fileCache.getById(1);
            assert.ok(cached);
            assert.equal(cached.content, "file content");
            assert.equal(writtenFiles.length, 1);
            assert.equal(writtenFiles[0].path, "test.md");
        });

        test("should create folder on create folder event", async () => {
            const { deps, writtenFiles } = makeDeps();
            const event = createEvent({
                type: MessageType.Create,
                objectType: "folder",
                workspacePath: "new-folder",
            });

            await handleEventMessage(event, deps);

            assert.equal(writtenFiles.length, 1);
            assert.equal(writtenFiles[0].path, "new-folder");
            assert.equal(writtenFiles[0].content, "");
        });
    });

    describe("delete events", () => {
        test("should delete file from storage and cache", async () => {
            const { deps, deletedPaths } = makeDeps();
            deps.fileCache.create(makeFileWithContent({ id: 1, workspacePath: "test.md" }));

            const event = createEvent({ type: MessageType.Delete, objectType: "file", fileId: 1 });

            await handleEventMessage(event, deps);

            assert.equal(deps.fileCache.getById(1), undefined);
            assert.equal(deletedPaths.length, 1);
            assert.equal(deletedPaths[0], "test.md");
        });

        test("should skip delete when file not in cache", async () => {
            const { deps, deletedPaths } = makeDeps();

            const event = createEvent({
                type: MessageType.Delete,
                objectType: "file",
                fileId: 99,
            });

            await handleEventMessage(event, deps);

            assert.equal(deletedPaths.length, 0);
        });

        test("should delete folder and all cached files within it", async () => {
            const { deps, deletedPaths } = makeDeps();
            deps.fileCache.create(
                makeFileWithContent({ id: 1, workspacePath: "folder/a.md" }),
            );
            deps.fileCache.create(
                makeFileWithContent({ id: 2, workspacePath: "folder/b.md" }),
            );

            deps.storage.listFiles = async () => [
                { path: "folder/a.md" } as TFile,
                { path: "folder/b.md" } as TFile,
            ];

            const event = createEvent({
                type: MessageType.Delete,
                objectType: "folder",
                workspacePath: "folder",
            });

            await handleEventMessage(event, deps);

            assert.equal(deps.fileCache.getByPath("folder/a.md"), undefined);
            assert.equal(deps.fileCache.getByPath("folder/b.md"), undefined);
            assert.ok(deletedPaths.includes("folder"));
        });
    });

    describe("rename events", () => {
        test("should rename cached file in storage and cache", async () => {
            const { deps, renamedPaths } = makeDeps();
            deps.fileCache.create(makeFileWithContent({ id: 1, workspacePath: "old.md" }));

            deps.apiClient.fetchFile = async () =>
                makeFileWithContent({ id: 1, workspacePath: "new.md" });

            const event = createEvent({
                type: MessageType.Rename,
                objectType: "file",
                fileId: 1,
                workspacePath: "old.md",
            });

            await handleEventMessage(event, deps);

            assert.equal(deps.fileCache.getByPath("new.md")?.workspacePath, "new.md");
            assert.equal(renamedPaths.length, 1);
            assert.equal(renamedPaths[0].from, "old.md");
            assert.equal(renamedPaths[0].to, "new.md");
        });

        test("should fetch and create file when rename target not in cache", async () => {
            const { deps, writtenFiles } = makeDeps();

            deps.apiClient.fetchFile = async () =>
                makeFileWithContent({ id: 5, workspacePath: "renamed.md" });

            const event = createEvent({
                type: MessageType.Rename,
                objectType: "file",
                fileId: 5,
                workspacePath: "old.md",
            });

            await handleEventMessage(event, deps);

            const cached = deps.fileCache.getById(5);
            assert.ok(cached);
            assert.equal(cached.workspacePath, "renamed.md");
            assert.equal(writtenFiles.length, 1);
        });
    });
});
