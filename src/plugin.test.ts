import assert from "node:assert";
import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { promisify } from "node:util";
import type { Vault } from "obsidian";
import { ApiClient, type WorkspaceCredentials } from "./api/api";
import { HttpClient } from "./api/http";
import { type ChunkMessage, type EventMessage, MessageType, WsClient } from "./api/ws";
import { computeDiff } from "./diff/diff";
import { Syncinator } from "./plugin";
import { Disk } from "./storage/storage";
import { CreateVaultMock } from "./storage/storage.mock";
import { base64ToArrayBuffer } from "./utils/base64Utils";
import { EventBus } from "./utils/eventBus";
import type { Snapshot, SnapshotEventMap } from "./views/snapshots";
const sleep = promisify(setTimeout);

async function assertEventually(assertion: () => Promise<void>, timeout = 5000, interval = 100) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
        try {
            await assertion();
            return;
        } catch (_) {
            await new Promise((resolve) => setTimeout(resolve, interval));
        }
    }

    await assertion();
}

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
    let snapshotEventBus: EventBus<SnapshotEventMap>;

    beforeEach(async () => {
        vaultRootDir = await fs.mkdtemp("/tmp/storage_test");
        vault = CreateVaultMock(vaultRootDir);
        storage = new Disk(vault);

        const credentials = createNewUser();
        const httpClient = new HttpClient("http", "127.0.0.1:8080", {});

        apiClient = new ApiClient(httpClient);
        const token = await apiClient.login(credentials.name, credentials.password);

        wsClient = new WsClient("ws", "127.0.0.1:8080", {
            maxReconnectAttempts: 0,
        });

        apiClient.setAuthorizationHeader(token.token);
        wsClient.setAuthorization(token.token);

        snapshotEventBus = new EventBus<SnapshotEventMap>();

        syncinator = new Syncinator(
            storage,
            apiClient,
            wsClient,
            {
                diffModal: async () => {
                    return "";
                },
                snapshotEventBus,
            },
            {
                conflictResolution: "remote",
            },
        );
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

            const sendMessage = t.mock.method(wsClient, "sendMessage", () => {});

            await syncinator.init();

            // checking cache
            assert.deepEqual(syncinator.cacheDump(), [{ ...onlineFile, content }]);

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

            const sendMessage = t.mock.method(wsClient, "sendMessage", () => {});

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
            assert.deepEqual(syncinator.cacheDump(), [{ ...files[0], content }]);
        });

        test("should align changes with 'remote' priority", async (t) => {
            // initializing a file in remote
            const localContent = "local";
            const remoteContent = "remote";
            const filepath = "files/conflict.md";

            syncinator.options.conflictResolution = "remote";

            const onlineFile = await apiClient.createFile(filepath, remoteContent);
            await storage.write(filepath, localContent);

            const sendMessage = t.mock.method(wsClient, "sendMessage", () => {});

            await syncinator.init();

            // checking cache
            assert.deepEqual(syncinator.cacheDump(), [{ ...onlineFile, content: remoteContent }]);

            // checking local vault
            const fileContent = await storage.readText(filepath);
            assert.equal(fileContent, remoteContent);

            assert.equal(sendMessage.mock.callCount(), 0);
        });

        test("should align binary files", async (t) => {
            // initializing a file in remote
            const localContent = base64ToArrayBuffer("JVBERi1sb2NhbA==");
            const remoteContent = base64ToArrayBuffer("JVBERi1yZW1vdGU=");
            const filepath = "files/binary_conflict.md";

            const onlineFile = await apiClient.createFile(filepath, remoteContent);
            await storage.write(filepath, localContent);

            const sendMessage = t.mock.method(wsClient, "sendMessage", () => {});

            await syncinator.init();

            // checking cache
            assert.deepEqual(syncinator.cacheDump(), [{ ...onlineFile, content: remoteContent }]);

            // checking local vault
            const fileContent = await storage.readBinary(filepath);
            assert.deepEqual(fileContent, remoteContent);

            assert.equal(sendMessage.mock.callCount(), 0);
        });

        test("should align changes with 'merge' priority", async (t) => {
            // initializing a file in remote
            const localContent = "local";
            const remoteContent = "remote";
            const mergedContent = localContent + remoteContent;
            const filepath = "files/conflict.md";

            syncinator.options.conflictResolution = "merge";

            const onlineFile = await apiClient.createFile(filepath, remoteContent);
            await storage.write(filepath, localContent);

            const sendMessage = t.mock.method(wsClient, "sendMessage", () => {});
            const diffModal = t.mock.method(syncinator.modals, "diffModal", () => {
                return mergedContent;
            });

            await syncinator.init();

            // checking cache
            assert.deepEqual(syncinator.cacheDump(), [{ ...onlineFile, content: mergedContent }]);

            // checking local vault
            const fileContent = await storage.readText(filepath);
            assert.equal(fileContent, mergedContent);

            assert.equal(diffModal.mock.callCount(), 1);
            assert.equal(sendMessage.mock.callCount(), 1);
            assert.deepEqual(sendMessage.mock.calls[0].arguments[0], {
                type: MessageType.Chunk,
                chunks: [
                    {
                        len: 5,
                        position: 0,
                        text: "local",
                        type: 1,
                    },
                ],
                version: onlineFile.version,
                fileId: onlineFile.id,
            } as ChunkMessage);
        });
    });

    describe("obsidian events", () => {
        test("should create a file event 'create'", async (t) => {
            const content = "lorem ipsum";
            const filename = "create.md";
            const filepath = `files/${filename}`;

            const sendMessage = t.mock.method(wsClient, "sendMessage", () => {});

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

            assert.deepEqual(syncinator.cacheDump(), [{ ...files[0], content: content }]);

            assert.strictEqual(sendMessage.mock.callCount(), 1);
            assert.deepEqual(sendMessage.mock.calls[0].arguments[0], {
                type: MessageType.Create,
                objectType: "file",
                fileId: files[0].id,
                workspacePath: filepath,
            } as EventMessage);
        });

        test("should send an event on folder 'create'", async (t) => {
            const filepath = "files/";

            const sendMessage = t.mock.method(wsClient, "sendMessage", () => {});

            // the file will exists before the event
            await storage.write(filepath, "", { isDir: true });
            await syncinator.events.create({
                name: filepath,
                path: filepath,
                vault,
                parent: null,
            });

            // checking cache
            assert.deepEqual(syncinator.cacheDump(), []);
            assert.equal(await storage.listFiles(), 0);

            assert.strictEqual(sendMessage.mock.callCount(), 1);
            assert.deepEqual(sendMessage.mock.calls[0].arguments[0], {
                type: MessageType.Create,
                objectType: "folder",
                fileId: 0,
                workspacePath: filepath,
            } as EventMessage);
        });

        test("should delete a file on event 'delete'", async (t) => {
            const content = "lorem ipsum";
            const filename = "create.md";
            const filepath = `files/${filename}`;

            const sendMessage = t.mock.method(wsClient, "sendMessage", () => {});

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

        test("should delete a folder on event 'delete'", async (t) => {
            const sendMessage = t.mock.method(wsClient, "sendMessage", () => {});
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

            assert.deepEqual(syncinator.cacheDump(), [{ ...files[0], content: "lorem ipsum 3" }]);

            assert.strictEqual(sendMessage.mock.callCount(), 3);

            const eventById: Record<number, EventMessage> = {};
            eventById[filesPreInit[0].id] = {
                type: MessageType.Delete,
                objectType: "file",
                fileId: filesPreInit[0].id,
                workspacePath: filesPreInit[0].workspacePath,
            } as EventMessage;
            eventById[filesPreInit[1].id] = {
                type: MessageType.Delete,
                objectType: "file",
                fileId: filesPreInit[1].id,
                workspacePath: filesPreInit[1].workspacePath,
            } as EventMessage;
            eventById[0] = {
                type: MessageType.Delete,
                objectType: "folder",
                fileId: 0,
                workspacePath: "folderToDelete",
            } as EventMessage;

            for (let i = 0; i < sendMessage.mock.calls.length; i++) {
                const call = sendMessage.mock.calls[i];
                const args = call.arguments[0];
                if (args === undefined) {
                    assert.fail("unexpected undefined");
                }

                assert.deepEqual(eventById[args.fileId], args);
            }
        });

        test("should rename a file on event 'rename'", async (t) => {
            const content = "lorem ipsum";
            const oldFilename = "rename.md";
            const oldFilepath = `files/${oldFilename}`;
            const newFilename = "newName.md";
            const newFilepath = `files/${newFilename}`;

            const sendMessage = t.mock.method(wsClient, "sendMessage", () => {});

            await apiClient.createFile(oldFilepath, content);
            await storage.write(oldFilepath, content);

            const filesPreInit = await apiClient.fetchFiles();
            assert.equal(filesPreInit.length, 1);

            // loading cache
            await syncinator.init();

            // to check updatedAt
            await sleep(1000);

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

        test("should rename a folder on event 'rename'", async (t) => {
            const sendMessage = t.mock.method(wsClient, "sendMessage", () => {});
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
                assert.equal(files[i].workspacePath, filesToCreate[i].newFilepath);
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
        test("should write a new chunk on 'modify'", async () => {
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

            assert.deepEqual(syncinator.cacheDump(), [{ ...files[0], content: content }]);

            await syncinator.handleChunkMessage({
                type: MessageType.Chunk,
                fileId: files[0].id,
                chunks: computeDiff(content, newContent),
                version: files[0].version,
            });

            assert.deepEqual(syncinator.cacheDump(), [{ ...files[0], content: newContent }]);
        });

        test("should ACK message on 'modify'", async () => {
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

            assert.deepEqual(syncinator.cacheDump(), [{ ...files[0], content: content }]);

            await storage.write(filepath, newContent, { force: true });
            await syncinator.events.modify({
                path: filepath,
                vault: vault,
                parent: null,
                name: "file.md",
            });

            await sleep(500);

            assert.deepEqual(syncinator.cacheDump(), [
                { ...files[0], version: 1, content: newContent },
            ]);
        });

        test("should create a file on 'create'", async (_t) => {
            const content = "lorem ipsum";
            const filepath = "files/file.md";

            const createdFile = await apiClient.createFile(filepath, content);

            assert.deepEqual(syncinator.cacheDump(), []);

            await syncinator.handleEventMessage({
                type: MessageType.Create,
                fileId: createdFile.id,
                objectType: "file",
                workspacePath: filepath,
            });

            assert.deepEqual(syncinator.cacheDump(), [{ ...createdFile, content }]);

            await assertEventually(async () => {
                const diskContent = await storage.readText(filepath);
                assert.equal(diskContent, content);
            });
        });

        test("should create a folder on 'create'", async (_t) => {
            const folder = "files/";

            const exists = await storage.exists(folder);
            assert.equal(exists, false);

            await syncinator.handleEventMessage({
                type: MessageType.Create,
                fileId: 0, // not used yet
                objectType: "folder",
                workspacePath: folder,
            });

            assert.deepEqual(syncinator.cacheDump(), []);

            await assertEventually(async () => {
                const exists = await storage.exists(folder);
                assert.equal(exists, true);
            });
        });

        test("should delete a file on 'delete'", async (_t) => {
            const content = "lorem ipsum";
            const filepath = "files/create.md";

            const file = await apiClient.createFile(filepath, content);
            await storage.write(filepath, content);

            // loading cache
            await syncinator.init();

            assert.equal(syncinator.cacheDump().length, 1);

            await syncinator.handleEventMessage({
                type: MessageType.Delete,
                fileId: file.id,
                objectType: "file",
                workspacePath: filepath,
            });

            // checking cache
            assert.deepEqual(syncinator.cacheDump(), []);

            await assertEventually(async () => {
                const exists = await storage.exists(filepath);
                assert.equal(exists, false);
            });
        });

        test("should delete a folder on 'delete'", async (_t) => {
            const folderToDelete = "folderToDelete";
            const filesToCreate = [
                {
                    content: "lorem ipsum 1",
                    filepath: `${folderToDelete}/fileToDelete1.md`,
                    shouldExists: false,
                },
                {
                    content: "lorem ipsum 2",
                    filepath: `${folderToDelete}/fileToDelete2.md`,
                    shouldExists: false,
                },
                {
                    content: "lorem ipsum 3",
                    filepath: "file.md",
                    shouldExists: true,
                },
            ];

            let notDeletedFile = null;
            for (const file of filesToCreate) {
                await storage.write(file.filepath, file.content);
                notDeletedFile = await apiClient.createFile(file.filepath, file.content);
            }

            // loading cache
            await syncinator.init();

            assert.equal(syncinator.cacheDump().length, 3);

            await syncinator.handleEventMessage({
                type: MessageType.Delete,
                objectType: "folder",
                fileId: 0, // not used
                workspacePath: folderToDelete,
            });

            // checking cache
            assert.deepEqual(syncinator.cacheDump(), [
                { ...notDeletedFile, content: "lorem ipsum 3" },
            ]);

            await assertEventually(async () => {
                for (const file of filesToCreate) {
                    const exists = await storage.exists(file.filepath);
                    assert.equal(exists, file.shouldExists);
                }
            });
        });

        test("should rename a file on event 'rename'", async (_) => {
            const content = "lorem ipsum";
            const oldFilepath = "files/rename.md";
            const newFilepath = "files/newName.md";

            const createdFile = await apiClient.createFile(oldFilepath, content);
            await storage.write(oldFilepath, content);

            // loading cache
            await syncinator.init();

            await apiClient.updateFile(createdFile.id, newFilepath);

            await syncinator.handleEventMessage({
                type: MessageType.Rename,
                fileId: createdFile.id,
                objectType: "file",
                workspacePath: oldFilepath,
            });

            // checking cache
            assert.deepEqual(syncinator.cacheDump(), [
                { ...createdFile, workspacePath: newFilepath, content },
            ]);
        });

        test("should create missing file on event 'rename'", async (_) => {
            const content = "lorem ipsum";
            const oldFilepath = "files/rename.md";
            const newFilepath = "files/newName.md";

            const createdFile = await apiClient.createFile(newFilepath, content);

            assert.equal(syncinator.cacheDump().length, 0);

            await syncinator.handleEventMessage({
                type: MessageType.Rename,
                fileId: createdFile.id,
                objectType: "file",
                workspacePath: oldFilepath,
            });

            // checking cache
            assert.deepEqual(syncinator.cacheDump(), [
                { ...createdFile, workspacePath: newFilepath, content },
            ]);
        });

        test("should rename a folder on event 'rename'", async () => {
            const folderToRename = "folderToRename";
            const filesToCreate = [
                {
                    content: "lorem ipsum 1",
                    oldFilepath: `${folderToRename}/file1.md`,
                    newFilepath: "renamedFolder/file1.md",
                },
                {
                    content: "lorem ipsum 2",
                    oldFilepath: `${folderToRename}/file2.md`,
                    newFilepath: "renamedFolder/file2.md",
                },
                {
                    content: "lorem ipsum 3",
                    oldFilepath: "file.md",
                    newFilepath: "file.md",
                },
            ];

            const createdFiles = [];
            for (const file of filesToCreate) {
                await storage.write(file.oldFilepath, file.content);
                createdFiles.push(await apiClient.createFile(file.oldFilepath, file.content));
            }

            // loading cache
            await syncinator.init();

            assert.equal(syncinator.cacheDump().length, 3);

            for (let i = 0; i < createdFiles.length; i++) {
                await apiClient.updateFile(createdFiles[i].id, filesToCreate[i].newFilepath);
            }

            await syncinator.handleEventMessage({
                type: MessageType.Rename,
                fileId: 0,
                objectType: "folder",
                workspacePath: folderToRename,
            });

            // checking cache
            const files = await apiClient.fetchFiles();
            assert.equal(files.length, 3);

            assert.deepStrictEqual(syncinator.cacheDump(), [
                { ...files[0], content: "lorem ipsum 1" },
                { ...files[1], content: "lorem ipsum 2" },
                { ...files[2], content: "lorem ipsum 3" },
            ]);
        });
    });

    describe("snapshots events", () => {
        test("should load snapshots on event", async () => {
            const filepath = "files/file.md";
            const content = "lorem ipsum";
            await storage.write(filepath, content);
            await syncinator.init();

            const files = await apiClient.fetchFiles();
            assert.equal(files.length, 1);

            let actual: Snapshot[] | undefined;
            snapshotEventBus.emit("file-focus-change", { path: filepath });
            const p = new Promise<void>((resolve) => {
                snapshotEventBus.on("snapshots-list-updated", async (snapshots) => {
                    actual = snapshots;
                    resolve();
                });
            });

            await Promise.race([p, sleep(1_000)]);
            assert.deepEqual(actual, []);
        });

        test("should update content on snapshot select", async (t) => {
            const filepath = "files/file.md";
            const content = "lorem ipsum";
            const mergedContent = "lorem ipsum2";

            const file = await apiClient.createFile(filepath, "");
            await syncinator.init();

            // triggering write to create snapshot
            await storage.write(filepath, content, { force: true });
            await syncinator.events.modify({
                path: filepath,
                vault: vault,
                parent: null,
                name: "file.md",
            });

            const files = await apiClient.fetchFiles();
            assert.equal(files.length, 1);

            await sleep(1_000);

            const sendMessage = t.mock.method(wsClient, "sendMessage", () => {});
            const diffModal = t.mock.method(syncinator.modals, "diffModal", () => {
                return mergedContent;
            });

            snapshotEventBus.emit("snapshot-selected", {
                fileId: file.id,
                version: file.version + 1,
                createdAt: file.createdAt,
            });

            await sleep(1_000);

            assert.deepEqual(syncinator.cacheDump(), [
                { ...file, content: mergedContent, version: 1 },
            ]);

            // checking local vault
            const fileContent = await storage.readText(filepath);
            assert.equal(fileContent, mergedContent);

            assert.equal(diffModal.mock.callCount(), 1);
            assert.equal(sendMessage.mock.callCount(), 1);
            assert.deepEqual(sendMessage.mock.calls[0].arguments[0], {
                type: MessageType.Chunk,
                chunks: [
                    {
                        len: 1,
                        position: 11,
                        text: "2",
                        type: 1,
                    },
                ],
                version: file.version + 1,
                fileId: file.id,
            } as ChunkMessage);
        });
    });
});

describe("concurrent modifications", () => {
    let vaultRootDir1: string;
    let vaultRootDir2: string;

    let vault1: Vault;
    let vault2: Vault;

    let storage1: Disk;
    let storage2: Disk;

    let apiClient1: ApiClient;
    let wsClient1: WsClient;

    let apiClient2: ApiClient;
    let wsClient2: WsClient;

    let syncinator1: Syncinator;
    let syncinator2: Syncinator;

    beforeEach(async () => {
        vaultRootDir1 = await fs.mkdtemp("/tmp/storage_test_1");
        vault1 = CreateVaultMock(vaultRootDir1);
        vaultRootDir2 = await fs.mkdtemp("/tmp/storage_test_2");
        vault2 = CreateVaultMock(vaultRootDir2);

        storage1 = new Disk(vault1);
        storage2 = new Disk(vault2);

        const credentials = createNewUser();
        const httpClient = new HttpClient("http", "127.0.0.1:8080", {});

        apiClient1 = new ApiClient(httpClient);
        apiClient2 = new ApiClient(httpClient);
        const token = await apiClient1.login(credentials.name, credentials.password);

        wsClient1 = new WsClient("ws", "127.0.0.1:8080", {
            maxReconnectAttempts: 0,
        });
        wsClient2 = new WsClient("ws", "127.0.0.1:8080", {
            maxReconnectAttempts: 0,
        });

        apiClient1.setAuthorizationHeader(token.token);
        apiClient2.setAuthorizationHeader(token.token);
        wsClient1.setAuthorization(token.token);
        wsClient2.setAuthorization(token.token);

        syncinator1 = new Syncinator(
            storage1,
            apiClient1,
            wsClient1,
            {
                diffModal: async () => {
                    return "";
                },
                snapshotEventBus: new EventBus<SnapshotEventMap>(),
            },
            {
                conflictResolution: "remote",
            },
        );

        syncinator2 = new Syncinator(
            storage2,
            apiClient2,
            wsClient2,
            {
                diffModal: async () => {
                    return "";
                },
                snapshotEventBus: new EventBus<SnapshotEventMap>(),
            },
            {
                conflictResolution: "remote",
            },
        );
    });

    afterEach(async () => {
        await fs.rm(vaultRootDir1, { recursive: true, force: true });
        await fs.rm(vaultRootDir2, { recursive: true, force: true });
        wsClient1.close();
        wsClient2.close();
        mock.restoreAll();
    });

    test("should handle concurrent modifications from different clients", async () => {
        const initialContent = "initial content";
        const filepath = "files/concurrent.md";

        // Create initial file
        const file = await apiClient1.createFile(filepath, initialContent);
        await syncinator1.init();
        await syncinator2.init();

        // check initial status
        const initialContent1 = await storage1.readText(filepath);
        const initialContent2 = await storage2.readText(filepath);
        assert.equal(initialContent, initialContent1);
        assert.equal(initialContent1, initialContent2);

        // Simulate concurrent modifications
        const clientModification = "client modification";
        const secondWorkspaceChange = "server update";

        await storage1.write(filepath, clientModification, { force: true });
        await storage2.write(filepath, secondWorkspaceChange, { force: true });

        // Client starts modifying
        // Server sends a modification before client's change is acknowledged
        await Promise.all([
            syncinator1.events.modify({
                path: filepath,
                vault: vault1,
                parent: null,
                name: "concurrent.md",
            }),
            syncinator2.events.modify({
                path: filepath,
                vault: vault2,
                parent: null,
                name: "concurrent.md",
            }),
        ]);

        await sleep(500);

        // Verify final state
        const finalContent1 = await storage1.readText(filepath);
        const cacheState1 = syncinator1.cacheDump();

        const finalContent2 = await storage2.readText(filepath);
        const cacheState2 = syncinator2.cacheDump();

        assert.equal(cacheState1.length, 1);
        assert.equal(cacheState2.length, 1);
        assert.equal(cacheState1[0].content, finalContent1);
        assert.equal(cacheState2[0].content, finalContent2);

        assert.equal(cacheState1[0].content, cacheState2[0].content);
        assert.equal(finalContent1, finalContent2);
        assert.notEqual(finalContent1, initialContent);

        const fileContent = await apiClient1.fetchFile(file.id);
        assert.equal(fileContent.content, finalContent1);
    });

    test("should handle multiple modifications from different client", async () => {
        const initialContent = "initial content";
        const filepath = "files/concurrent.md";

        // Create initial file
        const file = await apiClient1.createFile(filepath, initialContent);
        await syncinator1.init();
        await syncinator2.init();

        // check initial status
        const initialContent1 = await storage1.readText(filepath);
        const initialContent2 = await storage2.readText(filepath);
        assert.equal(initialContent, initialContent1);
        assert.equal(initialContent1, initialContent2);

        const numberOfModifications = 10;
        for (let i = 1; i <= numberOfModifications; i++) {
            const modificationContent = `modification ${i} from syncinator`;
            await storage1.write(filepath, modificationContent, { force: true });
            await syncinator1.events.modify({
                path: filepath,
                vault: vault1,
                parent: null,
                name: "concurrent.md",
            });
            await sleep(50);
        }

        await sleep(1_000);

        // Verify final state
        const finalContent1 = await storage1.readText(filepath);
        const cacheState1 = syncinator1.cacheDump();

        const finalContent2 = await storage2.readText(filepath);
        const cacheState2 = syncinator2.cacheDump();

        // Assertions to verify synchronization worked properly
        assert.equal(cacheState1.length, 1);
        assert.equal(cacheState2.length, 1);
        assert.equal(cacheState1[0].content, finalContent1);
        assert.equal(cacheState2[0].content, finalContent2);

        // Both syncinator should have the same final content
        assert.equal(cacheState1[0].content, cacheState2[0].content);
        assert.equal(finalContent1, finalContent2);
        assert.notEqual(finalContent1, initialContent);

        // Verify server state matches client state
        const fileContent = await apiClient1.fetchFile(file.id);
        assert.equal(fileContent.content, finalContent1);
    });

    // TODO: Find a way to make it fully concurrent
    test("should handle multiple concurrent modifications from different clients", async () => {
        const initialContent = "initial content";
        const filepath = "files/concurrent.md";

        // Create initial file
        const file = await apiClient1.createFile(filepath, initialContent);
        await syncinator1.init();
        await syncinator2.init();

        // check initial status
        const initialContent1 = await storage1.readText(filepath);
        const initialContent2 = await storage2.readText(filepath);
        assert.equal(initialContent, initialContent1);
        assert.equal(initialContent1, initialContent2);

        const numberOfModifications = 10;
        const performModification = async (
            storage: Disk,
            vault: Vault,
            syncinator: Syncinator,
            modificationNumber: number,
        ) => {
            const modificationContent = `modification ${modificationNumber} from syncinator ${syncinator === syncinator1 ? "1" : "2"}`;
            const oldContent = await storage.readText(filepath);
            const chunks = computeDiff(oldContent, modificationContent);
            await storage.persistChunks(filepath, chunks);
            await syncinator.events.modify({
                path: filepath,
                vault: vault,
                parent: null,
                name: "concurrent.md",
            });
            await sleep(50);
        };

        for (let i = 1; i <= numberOfModifications; i++) {
            await performModification(storage1, vault1, syncinator1, i);
            await performModification(storage2, vault2, syncinator2, i);
        }

        await sleep(2_000);

        // Verify final state
        const finalContent1 = await storage1.readText(filepath);
        const cacheState1 = syncinator1.cacheDump();

        const finalContent2 = await storage2.readText(filepath);
        const cacheState2 = syncinator2.cacheDump();

        // Assertions to verify synchronization worked properly
        assert.equal(cacheState1.length, 1);
        assert.equal(cacheState2.length, 1);
        assert.equal(cacheState1[0].content, finalContent1);
        assert.equal(cacheState2[0].content, finalContent2);

        // Both syncinator should have the same final content
        assert.equal(cacheState1[0].content, cacheState2[0].content);
        assert.equal(finalContent1, finalContent2);
        assert.notEqual(finalContent1, initialContent);

        // Verify server state matches client state
        const fileContent = await apiClient1.fetchFile(file.id);
        assert.equal(fileContent.content, finalContent1);
    });
});
