import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { RealTimePlugin } from "./plugin";
import { Disk } from "./storage/storage";
import { CreateVaultMock } from "./storage/storage.mock";
import fs from "node:fs/promises";
import { ApiClient, type FileWithContent, type File } from "./api";
import { HttpClient } from "./http";
import { WsClient } from "./ws";
import type { Vault } from "obsidian";
import assert from "node:assert";

describe("Plugin integration tests", () => {
	let vaultRootDir: string;
	let vault: Vault;
	let storage: Disk;
	let apiClient: ApiClient;
	let plugin: RealTimePlugin;
	let wsClient: WsClient;

	beforeEach(async () => {
		vaultRootDir = await fs.mkdtemp("/tmp/storage_test");
		vault = CreateVaultMock(vaultRootDir);
		storage = new Disk(vault);
		const httpClient = new HttpClient("http", "localhost", {});
		apiClient = new ApiClient(httpClient);
		wsClient = new WsClient("localhost");

		// to remove logs on tests
		test.mock.method(wsClient, "registerOnError", () => {});

		plugin = new RealTimePlugin(storage, apiClient, wsClient);
	});

	afterEach(async () => {
		await fs.rm(vaultRootDir, { recursive: true, force: true });
		mock.restoreAll();
	});

	test("should load files on init", async (t) => {
		const now = new Date().toString();
		const fetchFiles = t.mock.method(apiClient, "fetchFiles", (): File[] => {
			return [
				{
					id: 1,
					workspace_path: "files/newFile.md",
					disk_path: "",
					hash: "",
					created_at: now,
					updated_at: now,
					mime_type: "",
					workspace_id: 1,
				},
				{
					id: 2,
					workspace_path: "files/alreadyInWorkspace.md",
					disk_path: "",
					hash: "",
					created_at: now,
					updated_at: now,
					mime_type: "",
					workspace_id: 1,
				},
			];
		});

		const fetchFile2 = t.mock.method(
			apiClient,
			"fetchFile",
			(): FileWithContent => ({
				id: 2,
				workspace_path: "files/alreadyInWorkspace.md",
				content: "lorem ipsum",
				disk_path: "",
				hash: "",
				created_at: now,
				updated_at: now,
				mime_type: "",
				workspace_id: 1,
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
				workspace_path: "files/newFile.md",
				content: "foo",
				disk_path: "",
				hash: "",
				created_at: now,
				updated_at: now,
				mime_type: "",
				workspace_id: 1,
			}),
			{
				times: 1,
			},
		);

		// inizializing a file in vault, to simulate misalignment
		storage.createObject("files/alreadyInWorkspace.md", "lorem baz");

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
						created_at: now,
						disk_path: "",
						hash: "",
						id: 1,
						mime_type: "",
						updated_at: now,
						workspace_id: 1,
						workspace_path: "files/newFile.md",
					},
				],
				[
					2,
					{
						content: "lorem ipsum",
						created_at: now,
						disk_path: "",
						hash: "",
						id: 2,
						mime_type: "",
						updated_at: now,
						workspace_id: 1,
						workspace_path: "files/alreadyInWorkspace.md",
					},
				],
			]),
		);
		assert.strictEqual(fetchFiles.mock.callCount(), 1);
		assert.strictEqual(fetchFile1.mock.callCount(), 1);
		assert.strictEqual(fetchFile2.mock.callCount(), 1);
	});

	test("should create a file on 'create'", async (t) => {
		const now = new Date().toString();
		const createFile = t.mock.method(apiClient, "createFile", (): File => {
			return {
				id: 1,
				workspace_path: "files/newFile.md",
				disk_path: "",
				hash: "",
				created_at: now,
				updated_at: now,
				mime_type: "",
				workspace_id: 1,
			};
		});

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
						created_at: now,
						disk_path: "",
						hash: "",
						id: 1,
						mime_type: "",
						updated_at: now,
						workspace_id: 1,
						workspace_path: "files/newFile.md",
					},
				],
			]),
		);
		assert.strictEqual(createFile.mock.callCount(), 1);
	});

	test("should delete a file on 'delete'", async (t) => {
		const deleteFile = t.mock.method(apiClient, "deleteFile", () => {});
		const createFile = t.mock.method(apiClient, "createFile", (): File => {
			return {
				id: 1,
				workspace_path: "files/newFile.md",
				disk_path: "",
				hash: "",
				created_at: new Date().toString(),
				updated_at: new Date().toString(),
				mime_type: "",
				workspace_id: 1,
			};
		});

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
	});

	test("should rename a file on 'rename'", async (t) => {
		const deleteFile = t.mock.method(apiClient, "deleteFile", () => {});
		const createOldFile = t.mock.method(
			apiClient,
			"createFile",
			(): File => {
				return {
					id: 1,
					workspace_path: "files/oldName.md",
					disk_path: "",
					hash: "",
					created_at: new Date().toString(),
					updated_at: new Date().toString(),
					mime_type: "",
					workspace_id: 1,
				};
			},
			{ times: 1 },
		);

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

		const now = new Date().toString();
		const createNewFile = t.mock.method(
			apiClient,
			"createFile",
			(): File => {
				return {
					id: 1,
					workspace_path: "files/newName.md",
					disk_path: "",
					hash: "",
					created_at: now,
					updated_at: now,
					mime_type: "",
					workspace_id: 1,
				};
			},
			{ times: 1 },
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
						created_at: now,
						disk_path: "",
						hash: "",
						id: 1,
						mime_type: "",
						updated_at: now,
						workspace_id: 1,
						workspace_path: "files/newName.md",
					},
				],
			]),
		);
		assert.strictEqual(deleteFile.mock.callCount(), 1);
		assert.strictEqual(createOldFile.mock.callCount(), 1);
		assert.strictEqual(createNewFile.mock.callCount(), 1);
	});
});
