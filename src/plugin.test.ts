import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { Syncinator } from "./plugin";
import { Disk } from "./storage/storage";
import { CreateVaultMock } from "./storage/storage.mock";
import fs from "node:fs/promises";
import { ApiClient, type FileWithContent, type File } from "./api";
import { HttpClient } from "./http";
import { type EventMessage, MessageType, WsClient } from "./ws";
import type { Vault } from "obsidian";
import assert from "node:assert";
import { computeDiff } from "./diff";

describe("Plugin integration tests", () => {
	let vaultRootDir: string;
	let vault: Vault;
	let storage: Disk;
	let apiClient: ApiClient;
	let plugin: Syncinator;
	let wsClient: WsClient;

	beforeEach(async () => {
		vaultRootDir = await fs.mkdtemp("/tmp/storage_test");
		vault = CreateVaultMock(vaultRootDir);
		storage = new Disk(vault);
		const httpClient = new HttpClient("http", "localhost", {});
		apiClient = new ApiClient(httpClient);
		wsClient = new WsClient("localhost");

		// to remove logs on tests
		test.mock.method(wsClient, "registerOnError", () => { });

		plugin = new Syncinator(storage, apiClient, wsClient);
	});

	afterEach(async () => {
		await fs.rm(vaultRootDir, { recursive: true, force: true });
		mock.restoreAll();
	});

	test("should load files on init", async (t) => {
		const oldTimeDate = new Date();
		oldTimeDate.setDate(oldTimeDate.getDate() - 1);
		const oldTime = oldTimeDate.toString();

		const fetchFiles = t.mock.method(apiClient, "fetchFiles", (): File[] => {
			return [
				{
					id: 1,
					workspacePath: "files/newFile.md",
					diskPath: "",
					hash: "",
					createdAt: oldTime,
					updatedAt: oldTime,
					mimeType: "",
					workspaceId: 1,
				},
				{
					id: 2,
					workspacePath: "files/alreadyInWorkspace.md",
					diskPath: "",
					hash: "",
					createdAt: oldTime,
					updatedAt: oldTime,
					mimeType: "",
					workspaceId: 1,
				},
			];
		});

		const fetchFile2 = t.mock.method(
			apiClient,
			"fetchFile",
			(): FileWithContent => ({
				id: 2,
				workspacePath: "files/alreadyInWorkspace.md",
				content: "lorem ipsum",
				diskPath: "",
				hash: "",
				createdAt: oldTime,
				updatedAt: oldTime,
				mimeType: "",
				workspaceId: 1,
			}),
			{
				times: 1,
			},
		);

		const fetchFile1 = t.mock.method(
			apiClient,
			"fetchFile",
			(): FileWithContent => ({
				id: 1,
				workspacePath: "files/newFile.md",
				content: "foo",
				diskPath: "",
				hash: "",
				createdAt: oldTime,
				updatedAt: oldTime,
				mimeType: "",
				workspaceId: 1,
			}),
			{
				times: 1,
			},
		);

		// inizializing a file in vault, to simulate misalignment
		storage.writeObject("files/alreadyInWorkspace.md", "lorem baz");

		await plugin.init();

		assert.deepEqual(
			plugin.getFilePathToId(),
			new Map([
				["files/newFile.md", 1],
				["files/alreadyInWorkspace.md", 2],
			]),
		);

		assert.deepEqual(
			plugin.getFileIdToFile(),
			new Map([
				[
					1,
					{
						content: "foo",
						createdAt: oldTime,
						diskPath: "",
						hash: "",
						id: 1,
						mimeType: "",
						updatedAt: oldTime,
						workspaceId: 1,
						workspacePath: "files/newFile.md",
					},
				],
				[
					2,
					{
						content: "lorem ipsum",
						createdAt: oldTime,
						diskPath: "",
						hash: "",
						id: 2,
						mimeType: "",
						updatedAt: oldTime,
						workspaceId: 1,
						workspacePath: "files/alreadyInWorkspace.md",
					},
				],
			]),
		);
		assert.strictEqual(fetchFiles.mock.callCount(), 1);
		assert.strictEqual(fetchFile1.mock.callCount(), 1);
		assert.strictEqual(fetchFile2.mock.callCount(), 1);
	});

	test("should create a file on obsidian event 'create'", async (t) => {
		const now = new Date().toString();
		const createFile = t.mock.method(apiClient, "createFile", (): File => {
			return {
				id: 1,
				workspacePath: "files/newFile.md",
				diskPath: "",
				hash: "",
				createdAt: now,
				updatedAt: now,
				mimeType: "",
				workspaceId: 1,
			};
		});
		const sendMessage = t.mock.method(wsClient, "sendMessage", () => { });
		await storage.writeObject("files/newFile.md", "test")

		 await plugin.events.create({
			name: "newFile.md",
			path: "files/newFile.md",
			vault,
			parent: null,
		});

		// this should not trigger a call, since we already have the file in map
		await plugin.events.create({
			name: "newFile.md",
			path: "files/newFile.md",
			vault,
			parent: null,
		});

		assert.deepEqual(
			plugin.getFilePathToId(),
			new Map([["files/newFile.md", 1]]),
		);
		assert.deepEqual(
			plugin.getFileIdToFile(),
			new Map([
				[
					1,
					{
						content: "",
						createdAt: now,
						diskPath: "",
						hash: "",
						id: 1,
						mimeType: "",
						updatedAt: now,
						workspaceId: 1,
						workspacePath: "files/newFile.md",
					},
				],
			]),
		);
		assert.strictEqual(createFile.mock.callCount(), 1);
		assert.strictEqual(sendMessage.mock.callCount(), 1);
		assert.deepEqual(sendMessage.mock.calls[0].arguments[0], {
			type: MessageType.Create,
			objectType: "file",
			fileId: 1,
			workspacePath: "files/newFile.md",
		} as EventMessage);
	});

	test("should delete a file on obsidian event 'delete'", async (t) => {
		const deleteFile = t.mock.method(apiClient, "deleteFile", () => { });
		const createFile = t.mock.method(apiClient, "createFile", (): File => {
			return {
				id: 1,
				workspacePath: "files/newFile.md",
				diskPath: "",
				hash: "",
				createdAt: new Date().toString(),
				updatedAt: new Date().toString(),
				mimeType: "",
				workspaceId: 1,
			};
		});
		const sendMessage = t.mock.method(wsClient, "sendMessage", () => { });
		await storage.writeObject("files/newFile.md", "test")

		await plugin.events.create({
			name: "newFile.md",
			path: "files/newFile.md",
			vault,
			parent: null,
		});

		assert.deepEqual(
			plugin.getFilePathToId(),
			new Map([["files/newFile.md", 1]]),
		);

		await plugin.events.delete({
			name: "newFile.md",
			path: "files/newFile.md",
			vault,
			parent: null,
		});

		assert.deepEqual(plugin.getFilePathToId(), new Map());
		assert.strictEqual(deleteFile.mock.callCount(), 1);
		assert.strictEqual(createFile.mock.callCount(), 1);
		// one call for create and the second for delete
		assert.strictEqual(sendMessage.mock.callCount(), 2);
		assert.deepEqual(sendMessage.mock.calls[1].arguments[0], {
			type: MessageType.Delete,
			objectType: "file",
			fileId: 1,
			workspacePath: "files/newFile.md",
		} as EventMessage);
	});

	test("should delete a folder on obsidian event 'delete'", async (t) => {
		const deleteFile = t.mock.method(apiClient, "deleteFile", () => { });
		const createFile = t.mock.method(
			apiClient,
			"createFile",
			(): File => {
				return {
					id: 1,
					workspacePath: "files/anotherFile.md",
					diskPath: "",
					hash: "",
					createdAt: new Date().toString(),
					updatedAt: new Date().toString(),
					mimeType: "",
					workspaceId: 1,
				};
			},
			{ times: 1 },
		);
		const createFile2 = t.mock.method(
			apiClient,
			"createFile",
			(): File => {
				return {
					id: 2,
					workspacePath: "files/newFile.md",
					diskPath: "",
					hash: "",
					createdAt: new Date().toString(),
					updatedAt: new Date().toString(),
					mimeType: "",
					workspaceId: 1,
				};
			},
			{ times: 1 },
		);
		const createFile3 = t.mock.method(
			apiClient,
			"createFile",
			(): File => {
				return {
					id: 3,
					workspacePath: "files.md",
					diskPath: "",
					hash: "",
					createdAt: new Date().toString(),
					updatedAt: new Date().toString(),
					mimeType: "",
					workspaceId: 1,
				};
			},
			{ times: 1 },
		);

		const sendMessage = t.mock.method(wsClient, "sendMessage", () => { });
		
		await storage.writeObject("files.md", "test")
		await storage.writeObject("files/newFile.md", "test")
		await storage.writeObject("files/anotherFile.md", "test")

		await plugin.events.create({
			name: "files.md",
			path: "files.md",
			vault,
			parent: null,
		});

		await plugin.events.create({
			name: "newFile.md",
			path: "files/newFile.md",
			vault,
			parent: null,
		});

		await plugin.events.create({
			name: "anotherFile.md",
			path: "files/anotherFile.md",
			vault,
			parent: null,
		});

		assert.deepEqual(
			plugin.getFilePathToId(),
			new Map([
				["files/anotherFile.md", 1],
				["files/newFile.md", 2],
				["files.md", 3],
			]),
		);

		await plugin.events.delete({
			name: "files",
			path: "files",
			vault,
			parent: null,
		});

		assert.deepEqual(plugin.getFilePathToId(), new Map([["files.md", 3]]));
		assert.equal(plugin.getFileIdToFile().has(3), true);
		assert.strictEqual(deleteFile.mock.callCount(), 2);
		assert.strictEqual(createFile.mock.callCount(), 1);
		assert.strictEqual(createFile2.mock.callCount(), 1);
		assert.strictEqual(createFile3.mock.callCount(), 1);
		// one call for create and the second for delete
		assert.strictEqual(sendMessage.mock.callCount(), 6);

		const expectedMessages = [
			{ type: 1, fileId: 3, objectType: "file", workspacePath: "files.md" },
			{
				type: 1,
				fileId: 2,
				objectType: "file",
				workspacePath: "files/newFile.md",
			},
			{
				type: 1,
				fileId: 1,
				objectType: "file",
				workspacePath: "files/anotherFile.md",
			},
			{ type: 2, fileId: 2, objectType: "file", workspacePath: "files" },
			{ type: 2, fileId: 1, objectType: "file", workspacePath: "files" },
			{ type: 2, fileId: 0, objectType: "folder", workspacePath: "files" },
		];

		for (let i = 0; i < sendMessage.mock.calls.length; i++) {
			const call = sendMessage.mock.calls[i];
			assert.deepEqual(call.arguments[0], expectedMessages[i], `message ${i}`);
		}
	});

	test("should rename a file on obsidian event 'rename'", async (t) => {
		const now = new Date().toString();
		const renameFile = t.mock.method(apiClient, "updateFile", () => { });
		const createOldFile = t.mock.method(
			apiClient,
			"createFile",
			(): File => {
				return {
					id: 1,
					workspacePath: "files/oldName.md",
					diskPath: "",
					hash: "",
					createdAt: now,
					updatedAt: now,
					mimeType: "",
					workspaceId: 1,
				};
			},
			{ times: 1 },
		);
		const sendMessage = t.mock.method(wsClient, "sendMessage", () => { });
		await storage.writeObject("files/oldName.md", "test")

		await plugin.events.create({
			name: "newFile.md",
			path: "files/oldName.md",
			vault,
			parent: null,
		});

		assert.deepEqual(
			plugin.getFilePathToId(),
			new Map([["files/oldName.md", 1]]),
		);

		await plugin.events.rename(
			{
				name: "newName.md",
				path: "files/newName.md",
				vault,
				parent: null,
			},
			"files/oldName.md",
		);

		assert.deepEqual(
			plugin.getFilePathToId(),
			new Map([["files/newName.md", 1]]),
		);
		assert.deepEqual(
			plugin.getFileIdToFile(),
			new Map([
				[
					1,
					{
						content: "",
						createdAt: now,
						diskPath: "",
						hash: "",
						id: 1,
						mimeType: "",
						updatedAt: now,
						workspaceId: 1,
						workspacePath: "files/newName.md",
					},
				],
			]),
		);
		assert.strictEqual(renameFile.mock.callCount(), 1);
		assert.deepEqual(renameFile.mock.calls[0].arguments, [
			1,
			"files/newName.md",
		]);

		assert.strictEqual(createOldFile.mock.callCount(), 1);
		assert.strictEqual(sendMessage.mock.callCount(), 2);
		// ignore the first for creation
		assert.deepEqual(sendMessage.mock.calls[1].arguments[0], {
			type: MessageType.Rename,
			objectType: "file",
			fileId: 1,
			workspacePath: "files/oldName.md",
		} as EventMessage);
	});

	test("should rename a folder on obsidian event 'rename'", async (t) => {
		const now = new Date().toString();
		const createOldFile = t.mock.method(
			apiClient,
			"createFile",
			(): File => {
				return {
					id: 1,
					workspacePath: "oldFolder/file.md",
					diskPath: "",
					hash: "",
					createdAt: now,
					updatedAt: now,
					mimeType: "",
					workspaceId: 1,
				};
			},
			{ times: 1 },
		);
		const renameFile = t.mock.method(
			apiClient,
			"updateFile",
			(): File => {
				return {
					id: 1,
					workspacePath: "newFolder/file.md",
					diskPath: "",
					hash: "",
					createdAt: now,
					updatedAt: now,
					mimeType: "",
					workspaceId: 1,
				};
			},
			{ times: 1 },
		);

		const sendMessage = t.mock.method(wsClient, "sendMessage", () => { });
		await storage.writeObject("oldFolder/file.md", "test")

		await plugin.events.create({
			name: "file.md",
			path: "oldFolder/file.md",
			vault,
			parent: null,
		});

		assert.deepEqual(
			plugin.getFilePathToId(),
			new Map([["oldFolder/file.md", 1]]),
		);

		await plugin.events.rename(
			{
				name: "newFolder",
				path: "newFolder",
				vault,
				parent: null,
			},
			"oldFolder",
		);

		assert.deepEqual(
			plugin.getFilePathToId(),
			new Map([["newFolder/file.md", 1]]),
		);
		assert.deepEqual(
			plugin.getFileIdToFile(),
			new Map([
				[
					1,
					{
						content: "",
						createdAt: now,
						diskPath: "",
						hash: "",
						id: 1,
						mimeType: "",
						updatedAt: now,
						workspaceId: 1,
						workspacePath: "newFolder/file.md",
					},
				],
			]),
		);
		assert.strictEqual(renameFile.mock.callCount(), 1);
		assert.deepEqual(renameFile.mock.calls[0].arguments, [
			1,
			"newFolder/file.md",
		]);

		assert.strictEqual(createOldFile.mock.callCount(), 1);
		assert.strictEqual(renameFile.mock.callCount(), 1);
		assert.strictEqual(sendMessage.mock.callCount(), 2);
		// ignore the first for creation
		assert.deepEqual(sendMessage.mock.calls[1].arguments[0], {
			type: MessageType.Rename,
			objectType: "folder",
			fileId: 0,
			workspacePath: "oldFolder",
		} as EventMessage);
	});

	test("should write a new chunk coming from ws", async (t) => {
		const now = new Date().toString();
		const createFile = t.mock.method(apiClient, "createFile", (): File => {
			return {
				id: 1,
				workspacePath: "files/modifiedByWs.md",
				diskPath: "",
				hash: "",
				createdAt: now,
				updatedAt: now,
				mimeType: "",
				workspaceId: 1,
			};
		});

		await storage.writeObject("files/modifiedByWs.md", "lorem ipsum");
		await plugin.events.create({
			name: "modifiedByWs.md",
			path: "files/modifiedByWs.md",
			vault,
			parent: null,
		});

		assert.deepEqual(
			plugin.getFilePathToId(),
			new Map([["files/modifiedByWs.md", 1]]),
		);

		await plugin.onChunkMessage({
			type: MessageType.Chunk,
			fileId: 1,
			chunks: computeDiff("lorem ipsum", "lorem bar ipsum"),
		});

		assert.deepEqual(
			plugin.getFileIdToFile().get(1)?.content,
			"lorem bar ipsum",
		);
		assert.strictEqual(createFile.mock.callCount(), 1);
	});
});
