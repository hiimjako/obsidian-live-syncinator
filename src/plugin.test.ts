import assert from "node:assert";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { promisify } from "node:util";
import type { Vault } from "obsidian";
import {
    ApiClient,
    type File,
    type FileWithContent,
    type WorkspaceCredentials,
} from "./api/api";
import { HttpClient } from "./api/http";
import { type EventMessage, MessageType, WsClient } from "./api/ws";
import { computeDiff } from "./diff";
import { LogLevel, log } from "./logger/logger";
import { Syncinator } from "./plugin";
import { Disk } from "./storage/storage";
import { CreateVaultMock } from "./storage/storage.mock";
const sleep = promisify(setTimeout);

function createNewUser(): WorkspaceCredentials {
    const name = Math.random().toString(36).slice(2);
    const password = "pass";

    const out = execSync(
        `docker exec syncinator-test-server ./cli -name ${name} -pass ${password} -db "./data/db.sqlite3"`,
        { encoding: "utf8" },
    );

    assert.equal(out, "workspace created correctly\n");

    return {
        name,
        password,
    };
}

describe("Plugin integration tests", () => {
    let vaultRootDir: string;
    let vault: Vault;
    let storage: Disk;
    let apiClient: ApiClient;
    let syncinator: Syncinator;
    let wsClient: WsClient;

    beforeEach(async () => {
        vaultRootDir = await fs.mkdtemp("/tmp/storage_test");
        vault = CreateVaultMock(vaultRootDir);
        storage = new Disk(vault);

        const credentials = createNewUser();
        const httpClient = new HttpClient("http", "127.0.0.1:8080", {});

        apiClient = new ApiClient(httpClient);
        const token = await apiClient.login(
            credentials.name,
            credentials.password,
        );

        wsClient = new WsClient("ws", "127.0.0.1:8080", {
            maxReconnectAttempts: 0,
        });

        apiClient.setAuthorizationHeader(token.token);
        wsClient.setAuthorization(token.token);

        syncinator = new Syncinator(storage, apiClient, wsClient, {
            conflictResolution: "remote",
        });
    });

    afterEach(async () => {
        await fs.rm(vaultRootDir, { recursive: true, force: true });
        wsClient.close();
        mock.restoreAll();
    });

    describe("init function", () => {
        test("should fetch missing files", async (t) => {
            // initializing a file in remote
            const content = "lorem ipsum";
            const filepath = "files/remoteOnly.md";

            const onlineFile = await apiClient.createFile(filepath, content);
            const filesPreInit = await storage.listFiles();
            assert.equal(filesPreInit.length, 0);

            const sendMessage = t.mock.method(
                wsClient,
                "sendMessage",
                () => {},
            );

            await syncinator.init();

            // checking cache
            assert.deepEqual(syncinator.cacheDump(), [
                { ...onlineFile, content },
            ]);

            // checking local vault
            const files = await storage.listFiles();
            assert.equal(files.length, 1);
            assert.equal(files[0].path, filepath);

            const fileContent = await storage.readText(filepath);
            assert.equal(fileContent, content);

            assert.equal(sendMessage.mock.callCount(), 0);
        });

        test("should post files not in remote", async (t) => {
            // initializing a file in local vault
            const content = "lorem ipsum";
            const filepath = "files/localOnly.md";

            await storage.write(filepath, content);

            const sendMessage = t.mock.method(
                wsClient,
                "sendMessage",
                () => {},
            );

            const filesPreInit = await apiClient.fetchFiles();
            assert.equal(filesPreInit.length, 0);

            await syncinator.init();

            // checking local vault
            const files = await apiClient.fetchFiles();
            assert.equal(files.length, 1);
            assert.equal(files[0].workspacePath, filepath);

            assert.equal(sendMessage.mock.callCount(), 1);
            assert.deepEqual(sendMessage.mock.calls[0].arguments, [
                {
                    type: MessageType.Create,
                    fileId: files[0].id,
                    objectType: "file",
                    workspacePath: filepath,
                },
            ] as EventMessage[]);

            // checking cache
            assert.deepEqual(syncinator.cacheDump(), [
                { ...files[0], content },
            ]);
        });

        test("should align changes with 'remote' priority", async (t) => {
            // initializing a file in remote
            const localContent = "local";
            const remoteContent = "remote";
            const filepath = "files/conflict.md";

            syncinator.options.conflictResolution = "remote";

            const onlineFile = await apiClient.createFile(
                filepath,
                remoteContent,
            );
            await storage.write(filepath, localContent);

            const sendMessage = t.mock.method(
                wsClient,
                "sendMessage",
                () => {},
            );

            await syncinator.init();

            // checking cache
            assert.deepEqual(syncinator.cacheDump(), [
                { ...onlineFile, content: remoteContent },
            ]);

            // checking local vault
            const fileContent = await storage.readText(filepath);
            assert.equal(fileContent, remoteContent);

            assert.equal(sendMessage.mock.callCount(), 0);
        });
    });

    describe("obsidian events", () => {
        test("should create a file on obsidian event 'create'", async (t) => {
            const content = "lorem ipsum";
            const filename = "create.md";
            const filepath = `files/${filename}`;

            const sendMessage = t.mock.method(
                wsClient,
                "sendMessage",
                () => {},
            );

            const filesPreInit = await apiClient.fetchFiles();
            assert.equal(filesPreInit.length, 0);

            // the file will exists before the event
            await storage.write(filepath, content);
            await syncinator.events.create({
                name: filename,
                path: filepath,
                vault,
                parent: null,
            });

            // checking cache
            const files = await apiClient.fetchFiles();
            assert.equal(files.length, 1);

            assert.deepEqual(syncinator.cacheDump(), [
                { ...files[0], content: content },
            ]);

            assert.strictEqual(sendMessage.mock.callCount(), 1);
            assert.deepEqual(sendMessage.mock.calls[0].arguments[0], {
                type: MessageType.Create,
                objectType: "file",
                fileId: files[0].id,
                workspacePath: filepath,
            } as EventMessage);
        });

        test("should delete a file on obsidian event 'delete'", async (t) => {
            const content = "lorem ipsum";
            const filename = "create.md";
            const filepath = `files/${filename}`;

            const sendMessage = t.mock.method(
                wsClient,
                "sendMessage",
                () => {},
            );

            const onlineFile = await apiClient.createFile(filepath, content);
            await storage.write(filepath, content);

            const filesPreInit = await apiClient.fetchFiles();
            assert.equal(filesPreInit.length, 1);

            // loading cache
            await syncinator.init();

            await syncinator.events.delete({
                name: filename,
                path: filepath,
                vault,
                parent: null,
            });

            // checking cache
            const files = await apiClient.fetchFiles();
            assert.equal(files.length, 0);

            assert.deepEqual(syncinator.cacheDump(), []);

            assert.strictEqual(sendMessage.mock.callCount(), 1);
            assert.deepEqual(sendMessage.mock.calls[0].arguments[0], {
                type: MessageType.Delete,
                objectType: "file",
                fileId: onlineFile.id,
                workspacePath: filepath,
            } as EventMessage);
        });

        test("should delete a folder on obsidian event 'delete'", async (t) => {
            const sendMessage = t.mock.method(
                wsClient,
                "sendMessage",
                () => {},
            );
            const filesToCreate = [
                {
                    content: "lorem ipsum 1",
                    filename: "fileToDelete1.md",
                    filepath: "folderToDelete/fileToDelete1.md",
                },
                {
                    content: "lorem ipsum 2",
                    filename: "fileToDelete2.md",
                    filepath: "folderToDelete/fileToDelete2.md",
                },
                {
                    content: "lorem ipsum 3",
                    filename: "file.md",
                    filepath: "file.md",
                },
            ];

            for (const file of filesToCreate) {
                await storage.write(file.filepath, file.content);
                await apiClient.createFile(file.filepath, file.content);
            }

            const filesPreInit = await apiClient.fetchFiles();
            assert.equal(filesPreInit.length, 3);

            // loading cache
            await syncinator.init();

            await syncinator.events.delete({
                name: "folderToDelete",
                path: "folderToDelete",
                vault,
                parent: null,
            });

            // checking cache
            const files = await apiClient.fetchFiles();
            assert.equal(files.length, 1);

            assert.deepEqual(syncinator.cacheDump(), [
                { ...files[0], content: "lorem ipsum 3" },
            ]);

            assert.strictEqual(sendMessage.mock.callCount(), 3);
            assert.deepEqual(sendMessage.mock.calls[0].arguments[0], {
                type: MessageType.Delete,
                objectType: "file",
                fileId: filesPreInit[0].id,
                workspacePath: filesPreInit[0].workspacePath,
            } as EventMessage);
            assert.deepEqual(sendMessage.mock.calls[1].arguments[0], {
                type: MessageType.Delete,
                objectType: "file",
                fileId: filesPreInit[1].id,
                workspacePath: filesPreInit[1].workspacePath,
            } as EventMessage);
            assert.deepEqual(sendMessage.mock.calls[2].arguments[0], {
                type: MessageType.Delete,
                objectType: "folder",
                fileId: 0,
                workspacePath: "folderToDelete",
            } as EventMessage);
        });

        test("should rename a file on obsidian event 'rename'", async (t) => {
            const content = "lorem ipsum";
            const oldFilename = "rename.md";
            const oldFilepath = `files/${oldFilename}`;
            const newFilename = "newName.md";
            const newFilepath = `files/${newFilename}`;

            const sendMessage = t.mock.method(
                wsClient,
                "sendMessage",
                () => {},
            );

            await apiClient.createFile(oldFilepath, content);
            await storage.write(oldFilepath, content);

            const filesPreInit = await apiClient.fetchFiles();
            assert.equal(filesPreInit.length, 1);

            // loading cache
            await syncinator.init();

            await syncinator.events.rename(
                {
                    name: newFilename,
                    path: newFilepath,
                    vault,
                    parent: null,
                },
                oldFilepath,
            );

            // checking cache
            const file = await apiClient.fetchFile(filesPreInit[0].id);
            assert.equal(file.workspacePath, newFilepath);

            assert.deepEqual(syncinator.cacheDump(), [{ ...file, content }]);

            assert.strictEqual(sendMessage.mock.callCount(), 1);
            assert.deepEqual(sendMessage.mock.calls[0].arguments[0], {
                type: MessageType.Rename,
                objectType: "file",
                fileId: file.id,
                workspacePath: oldFilepath,
            } as EventMessage);
        });

        test("should rename a folder on obsidian event 'rename'", async (t) => {
            const sendMessage = t.mock.method(
                wsClient,
                "sendMessage",
                () => {},
            );
            const filesToCreate = [
                {
                    content: "lorem ipsum 1",
                    oldFilename: "file1.md",
                    oldFilepath: "folderToRename/file1.md",
                    newFilename: "file1.md",
                    newFilepath: "renamedFolder/file1.md",
                },
                {
                    content: "lorem ipsum 2",
                    oldFilename: "file2.md",
                    oldFilepath: "folderToRename/file2.md",
                    newFilename: "file2.md",
                    newFilepath: "renamedFolder/file2.md",
                },
                {
                    content: "lorem ipsum 3",
                    oldFilename: "file.md",
                    oldFilepath: "file.md",
                    newFilename: "file.md",
                    newFilepath: "file.md",
                },
            ];

            for (const file of filesToCreate) {
                await storage.write(file.oldFilepath, file.content);
                await apiClient.createFile(file.oldFilepath, file.content);
            }

            const filesPreInit = await apiClient.fetchFiles();
            assert.equal(filesPreInit.length, 3);

            // loading cache
            await syncinator.init();

            await syncinator.events.rename(
                {
                    name: "renamedFolder",
                    path: "renamedFolder",
                    vault,
                    parent: null,
                },
                "folderToRename",
            );

            // checking cache
            const files = await apiClient.fetchFiles();
            assert.equal(files.length, 3);

            for (let i = 0; i < files.length; i++) {
                assert.equal(
                    files[i].workspacePath,
                    filesToCreate[i].newFilepath,
                );
            }

            assert.deepEqual(syncinator.cacheDump(), [
                { ...files[0], content: "lorem ipsum 1" },
                { ...files[1], content: "lorem ipsum 2" },
                { ...files[2], content: "lorem ipsum 3" },
            ]);

            assert.strictEqual(sendMessage.mock.callCount(), 1);
            assert.deepEqual(sendMessage.mock.calls[0].arguments[0], {
                type: MessageType.Rename,
                objectType: "folder",
                fileId: 0,
                workspacePath: "folderToRename",
            } as EventMessage);
        });
    });

    describe("ws events", () => {
        test("should write a new chunk coming from ws", async (t) => {
            const content = "lorem ipsum";
            const newContent = "lorem bar ipsum";
            const filepath = "files/file.md";

            const filesPreInit = await apiClient.fetchFiles();
            assert.equal(filesPreInit.length, 0);

            await storage.write(filepath, content);
            await syncinator.init();

            // checking cache
            const files = await apiClient.fetchFiles();
            assert.equal(files.length, 1);

            assert.deepEqual(syncinator.cacheDump(), [
                { ...files[0], content: content },
            ]);

            await syncinator.onChunkMessage({
                type: MessageType.Chunk,
                fileId: files[0].id,
                chunks: computeDiff(content, newContent),
                version: files[0].version,
            });

            assert.deepEqual(syncinator.cacheDump(), [
                { ...files[0], content: newContent },
            ]);
        });
    });
});
