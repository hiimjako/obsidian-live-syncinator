import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { Syncinator } from "./plugin";
import { Disk } from "./storage/storage";
import { CreateVaultMock } from "./storage/storage.mock";
import fs from "node:fs/promises";
import {
    ApiClient,
    type FileWithContent,
    type File,
    type WorkspaceCredentials,
} from "./api/api";
import { HttpClient } from "./api/http";
import { type EventMessage, MessageType, WsClient } from "./api/ws";
import type { Vault } from "obsidian";
import assert from "node:assert";
import { computeDiff } from "./diff";
import { execSync } from "node:child_process";
import { log, LogLevel } from "./logger/logger";
import { promisify } from "node:util";
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

    test("should create a file on obsidian event 'create'", async (t) => {
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

    // test("should delete a folder on obsidian event 'delete'", async (t) => {
    // 	const now = new Date().toISOString();
    // 	const deleteFile = t.mock.method(apiClient, "deleteFile", () => { });
    // 	const createFile = t.mock.method(
    // 		apiClient,
    // 		"createFile",
    // 		(): File => {
    // 			return {
    // 				id: 1,
    // 				workspacePath: "files/anotherFile.md",
    // 				diskPath: "",
    // 				hash: "",
    // 				createdAt: now,
    // 				updatedAt: now,
    // 				mimeType: "",
    // 				workspaceId: 1,
    // 			};
    // 		},
    // 		{ times: 1 },
    // 	);
    // 	const createFile2 = t.mock.method(
    // 		apiClient,
    // 		"createFile",
    // 		(): File => {
    // 			return {
    // 				id: 2,
    // 				workspacePath: "files/newFile.md",
    // 				diskPath: "",
    // 				hash: "",
    // 				createdAt: now,
    // 				updatedAt: now,
    // 				mimeType: "",
    // 				workspaceId: 1,
    // 			};
    // 		},
    // 		{ times: 1 },
    // 	);
    // 	const createFile3 = t.mock.method(
    // 		apiClient,
    // 		"createFile",
    // 		(): File => {
    // 			return {
    // 				id: 3,
    // 				workspacePath: "files.md",
    // 				diskPath: "",
    // 				hash: "",
    // 				createdAt: now,
    // 				updatedAt: now,
    // 				mimeType: "",
    // 				workspaceId: 1,
    // 			};
    // 		},
    // 		{ times: 1 },
    // 	);
    //
    // 	const sendMessage = t.mock.method(wsClient, "sendMessage", () => { });
    //
    // 	await storage.write("files.md", "test");
    // 	await storage.write("files/newFile.md", "test");
    // 	await storage.write("files/anotherFile.md", "test");
    //
    // 	await plugin.events.create({
    // 		name: "files.md",
    // 		path: "files.md",
    // 		vault,
    // 		parent: null,
    // 	});
    //
    // 	await plugin.events.create({
    // 		name: "newFile.md",
    // 		path: "files/newFile.md",
    // 		vault,
    // 		parent: null,
    // 	});
    //
    // 	await plugin.events.create({
    // 		name: "anotherFile.md",
    // 		path: "files/anotherFile.md",
    // 		vault,
    // 		parent: null,
    // 	});
    //
    // 	assert.deepEqual(plugin.cacheDump(), [
    // 		{
    // 			id: 3,
    // 			workspacePath: "files.md",
    // 			diskPath: "",
    // 			hash: "",
    // 			createdAt: now,
    // 			updatedAt: now,
    // 			mimeType: "",
    // 			workspaceId: 1,
    // 			content: "test",
    // 		},
    // 		{
    // 			id: 2,
    // 			workspacePath: "files/newFile.md",
    // 			diskPath: "",
    // 			hash: "",
    // 			createdAt: now,
    // 			updatedAt: now,
    // 			mimeType: "",
    // 			workspaceId: 1,
    // 			content: "test",
    // 		},
    // 		{
    // 			id: 1,
    // 			workspacePath: "files/anotherFile.md",
    // 			diskPath: "",
    // 			hash: "",
    // 			createdAt: now,
    // 			updatedAt: now,
    // 			mimeType: "",
    // 			workspaceId: 1,
    // 			content: "test",
    // 		},
    // 	]);
    //
    // 	await plugin.events.delete({
    // 		name: "files",
    // 		path: "files",
    // 		vault,
    // 		parent: null,
    // 	});
    //
    // 	assert.deepEqual(plugin.cacheDump(), [
    // 		{
    // 			id: 3,
    // 			workspacePath: "files.md",
    // 			diskPath: "",
    // 			hash: "",
    // 			createdAt: now,
    // 			updatedAt: now,
    // 			mimeType: "",
    // 			workspaceId: 1,
    // 			content: "test",
    // 		},
    // 	]);
    //
    // 	assert.strictEqual(deleteFile.mock.callCount(), 2);
    // 	assert.strictEqual(createFile.mock.callCount(), 1);
    // 	assert.strictEqual(createFile2.mock.callCount(), 1);
    // 	assert.strictEqual(createFile3.mock.callCount(), 1);
    // 	// one call for create and the second for delete
    // 	assert.strictEqual(sendMessage.mock.callCount(), 6);
    //
    // 	const expectedMessages = [
    // 		{ type: 1, fileId: 3, objectType: "file", workspacePath: "files.md" },
    // 		{
    // 			type: 1,
    // 			fileId: 2,
    // 			objectType: "file",
    // 			workspacePath: "files/newFile.md",
    // 		},
    // 		{
    // 			type: 1,
    // 			fileId: 1,
    // 			objectType: "file",
    // 			workspacePath: "files/anotherFile.md",
    // 		},
    // 		{ type: 2, fileId: 2, objectType: "file", workspacePath: "files" },
    // 		{ type: 2, fileId: 1, objectType: "file", workspacePath: "files" },
    // 		{ type: 2, fileId: 0, objectType: "folder", workspacePath: "files" },
    // 	];
    //
    // 	for (let i = 0; i < sendMessage.mock.calls.length; i++) {
    // 		const call = sendMessage.mock.calls[i];
    // 		assert.deepEqual(call.arguments[0], expectedMessages[i], `message ${i}`);
    // 	}
    // });
    //
    // test("should rename a file on obsidian event 'rename'", async (t) => {
    // 	const now = new Date().toISOString();
    // 	const renameFile = t.mock.method(apiClient, "updateFile", () => { });
    // 	const createOldFile = t.mock.method(
    // 		apiClient,
    // 		"createFile",
    // 		(): File => {
    // 			return {
    // 				id: 1,
    // 				workspacePath: "files/oldName.md",
    // 				diskPath: "",
    // 				hash: "",
    // 				createdAt: now,
    // 				updatedAt: now,
    // 				mimeType: "",
    // 				workspaceId: 1,
    // 			};
    // 		},
    // 		{ times: 1 },
    // 	);
    // 	const sendMessage = t.mock.method(wsClient, "sendMessage", () => { });
    // 	await storage.write("files/oldName.md", "test");
    //
    // 	await plugin.events.create({
    // 		name: "newFile.md",
    // 		path: "files/oldName.md",
    // 		vault,
    // 		parent: null,
    // 	});
    //
    // 	assert.deepEqual(plugin.cacheDump(), [
    // 		{
    // 			content: "test",
    // 			createdAt: now,
    // 			diskPath: "",
    // 			hash: "",
    // 			id: 1,
    // 			mimeType: "",
    // 			updatedAt: now,
    // 			workspaceId: 1,
    // 			workspacePath: "files/oldName.md",
    // 		},
    // 	]);
    //
    // 	await plugin.events.rename(
    // 		{
    // 			name: "newName.md",
    // 			path: "files/newName.md",
    // 			vault,
    // 			parent: null,
    // 		},
    // 		"files/oldName.md",
    // 	);
    //
    // 	assert.deepEqual(plugin.cacheDump(), [
    // 		{
    // 			content: "test",
    // 			createdAt: now,
    // 			diskPath: "",
    // 			hash: "",
    // 			id: 1,
    // 			mimeType: "",
    // 			updatedAt: now,
    // 			workspaceId: 1,
    // 			workspacePath: "files/newName.md",
    // 		},
    // 	]);
    // 	assert.strictEqual(renameFile.mock.callCount(), 1);
    // 	assert.deepEqual(renameFile.mock.calls[0].arguments, [
    // 		1,
    // 		"files/newName.md",
    // 	]);
    //
    // 	assert.strictEqual(createOldFile.mock.callCount(), 1);
    // 	assert.strictEqual(sendMessage.mock.callCount(), 2);
    // 	// ignore the first for creation
    // 	assert.deepEqual(sendMessage.mock.calls[1].arguments[0], {
    // 		type: MessageType.Rename,
    // 		objectType: "file",
    // 		fileId: 1,
    // 		workspacePath: "files/oldName.md",
    // 	} as EventMessage);
    // });
    //
    // test("should rename a folder on obsidian event 'rename'", async (t) => {
    // 	const now = new Date().toISOString();
    // 	const createOldFile = t.mock.method(
    // 		apiClient,
    // 		"createFile",
    // 		(): File => {
    // 			return {
    // 				id: 1,
    // 				workspacePath: "oldFolder/file.md",
    // 				diskPath: "",
    // 				hash: "",
    // 				createdAt: now,
    // 				updatedAt: now,
    // 				mimeType: "",
    // 				workspaceId: 1,
    // 			};
    // 		},
    // 		{ times: 1 },
    // 	);
    // 	const renameFile = t.mock.method(
    // 		apiClient,
    // 		"updateFile",
    // 		(): File => {
    // 			return {
    // 				id: 1,
    // 				workspacePath: "newFolder/file.md",
    // 				diskPath: "",
    // 				hash: "",
    // 				createdAt: now,
    // 				updatedAt: now,
    // 				mimeType: "",
    // 				workspaceId: 1,
    // 			};
    // 		},
    // 		{ times: 1 },
    // 	);
    //
    // 	const sendMessage = t.mock.method(wsClient, "sendMessage", () => { });
    // 	await storage.write("oldFolder/file.md", "test");
    //
    // 	await plugin.events.create({
    // 		name: "file.md",
    // 		path: "oldFolder/file.md",
    // 		vault,
    // 		parent: null,
    // 	});
    //
    // 	assert.deepEqual(plugin.cacheDump(), [
    // 		{
    // 			id: 1,
    // 			workspacePath: "oldFolder/file.md",
    // 			diskPath: "",
    // 			hash: "",
    // 			createdAt: now,
    // 			updatedAt: now,
    // 			mimeType: "",
    // 			workspaceId: 1,
    // 			content: "test",
    // 		},
    // 	]);
    //
    // 	await plugin.events.rename(
    // 		{
    // 			name: "newFolder",
    // 			path: "newFolder",
    // 			vault,
    // 			parent: null,
    // 		},
    // 		"oldFolder",
    // 	);
    //
    // 	assert.deepEqual(plugin.cacheDump(), [
    // 		{
    // 			content: "test",
    // 			createdAt: now,
    // 			diskPath: "",
    // 			hash: "",
    // 			id: 1,
    // 			mimeType: "",
    // 			updatedAt: now,
    // 			workspaceId: 1,
    // 			workspacePath: "newFolder/file.md",
    // 		},
    // 	]);
    // 	assert.strictEqual(renameFile.mock.callCount(), 1);
    // 	assert.deepEqual(renameFile.mock.calls[0].arguments, [
    // 		1,
    // 		"newFolder/file.md",
    // 	]);
    //
    // 	assert.strictEqual(createOldFile.mock.callCount(), 1);
    // 	assert.strictEqual(renameFile.mock.callCount(), 1);
    // 	assert.strictEqual(sendMessage.mock.callCount(), 2);
    // 	// ignore the first for creation
    // 	assert.deepEqual(sendMessage.mock.calls[1].arguments[0], {
    // 		type: MessageType.Rename,
    // 		objectType: "folder",
    // 		fileId: 0,
    // 		workspacePath: "oldFolder",
    // 	} as EventMessage);
    // });
    //
    // test("should write a new chunk coming from ws", async (t) => {
    // 	const now = new Date().toISOString();
    // 	const createFile = t.mock.method(apiClient, "createFile", (): File => {
    // 		return {
    // 			id: 1,
    // 			workspacePath: "files/modifiedByWs.md",
    // 			diskPath: "",
    // 			hash: "",
    // 			createdAt: now,
    // 			updatedAt: now,
    // 			mimeType: "",
    // 			workspaceId: 1,
    // 		};
    // 	});
    //
    // 	await storage.write("files/modifiedByWs.md", "lorem ipsum");
    // 	await plugin.events.create({
    // 		name: "modifiedByWs.md",
    // 		path: "files/modifiedByWs.md",
    // 		vault,
    // 		parent: null,
    // 	});
    //
    // 	assert.deepEqual(plugin.cacheDump(), [
    // 		{
    // 			id: 1,
    // 			workspacePath: "files/modifiedByWs.md",
    // 			diskPath: "",
    // 			hash: "",
    // 			createdAt: now,
    // 			updatedAt: now,
    // 			mimeType: "",
    // 			workspaceId: 1,
    // 			content: "lorem ipsum",
    // 		},
    // 	]);
    //
    // 	await plugin.onChunkMessage({
    // 		type: MessageType.Chunk,
    // 		fileId: 1,
    // 		chunks: computeDiff("lorem ipsum", "lorem bar ipsum"),
    // 	});
    //
    // 	assert.deepEqual(plugin.cacheDump(), [
    // 		{
    // 			id: 1,
    // 			workspacePath: "files/modifiedByWs.md",
    // 			diskPath: "",
    // 			hash: "",
    // 			createdAt: now,
    // 			updatedAt: now,
    // 			mimeType: "",
    // 			workspaceId: 1,
    // 			content: "lorem bar ipsum",
    // 		},
    // 	]);
    //
    // 	assert.strictEqual(createFile.mock.callCount(), 1);
    // });
});
