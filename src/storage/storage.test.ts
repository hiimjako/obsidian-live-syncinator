import assert from "node:assert/strict";
import { describe, it as test, afterEach, mock, beforeEach } from "node:test";
import fs from "node:fs/promises";
import { computeDiff } from "../diff";
import { Disk } from "../storage/storage";
import { CreateVaultMock } from "../storage/storage.mock";
import type { Vault } from "obsidian";
import { randomUUID } from "node:crypto";

describe("Disk storage integration tests", () => {
	let v: Vault;
	let vaultRootDir: string;

	beforeEach(async () => {
		vaultRootDir = await fs.mkdtemp("/tmp/storage_test");
		v = CreateVaultMock(vaultRootDir);
	});

	afterEach(async () => {
		await fs.rm(vaultRootDir, { recursive: true, force: true });
		mock.restoreAll();
	});

	test("should persist changes correctly for various chunks", async () => {
		const d = new Disk(v);

		const tests = [
			{
				name: "compute remove chunk in present file",
				initialContent: "",
				expected: "hello",
				diffs: [
					computeDiff("hello", ""),
					computeDiff("", "he__llo"),
					computeDiff("he__llo", "hello"),
				],
			},
			{
				name: "compute add chunk in present file",
				initialContent: "",
				expected: "hello world!",
				diffs: [
					computeDiff("", "hello"),
					computeDiff("hello", "hello!"),
					computeDiff("hello!", "hello world!"),
				],
			},
			{
				name: "handles new lines",
				initialContent: "",
				expected: `hello!
                         newline`,
				diffs: [
					computeDiff(
						"",
						`hello 
                         world`,
					),
					computeDiff(
						`hello 
                         world`,
						"hello!",
					),
					computeDiff(
						"hello!",
						`hello!
                         newline`,
					),
				],
			},
		];

		for (const tt of tests) {
			await test(tt.name, async () => {
				const fileName = randomUUID();
				await d.writeObject(fileName, tt.initialContent);

				assert.strictEqual(await d.exists(fileName), true);

				let content = "";
				for (const di of tt.diffs) {
					content = await d.persistChunks(fileName, di);
				}

				const fileContent = await d.readObject(fileName);
				assert.strictEqual(fileContent.toString(), tt.expected);
				assert.strictEqual(content, tt.expected);
			});
		}
	});

	test("should return error on non-existing file", async () => {
		const d = new Disk(v);

		await assert.rejects(async () => {
			await d.persistChunk("not-existing-file", computeDiff("", "foo")[0]);
		});
	});

	test("should create, read, and delete objects correctly", async (t) => {
		const createFolderMock = t.mock.method(v, "createFolder");
		const getFileByPath = t.mock.method(v, "getFileByPath");
		const getFolderByPath = t.mock.method(v, "getFolderByPath");
		const cachedRead = t.mock.method(v, "cachedRead");
		const del = t.mock.method(v, "delete");
		const existsMock = t.mock.method(v.adapter, "exists");
		const writeMock = t.mock.method(v.adapter, "write");

		const d = new Disk(v);

		const path = "foo/bar/baz.md";
		const content = "hello";

		await d.writeObject(path, content);
		assert.strictEqual(createFolderMock.mock.callCount(), 2);
		assert.strictEqual(existsMock.mock.callCount(), 3);
		assert.strictEqual(writeMock.mock.callCount(), 1);

		// read object
		const fileContent = await d.readObject(path);
		assert.deepStrictEqual(fileContent, content);

		assert.strictEqual(getFileByPath.mock.callCount(), 1);
		assert.strictEqual(cachedRead.mock.callCount(), 1);

		// delete object
		await d.deleteObject(path);
		assert.strictEqual(getFileByPath.mock.callCount(), 2);
		assert.strictEqual(getFolderByPath.mock.callCount(), 1);
		assert.strictEqual(del.mock.callCount(), 1);

		assert.strictEqual(await d.exists(path), false);
	});

	describe("getIncrementalDirectories", () => {
		test("should split a path", async () => {
			const path = "./foo/bar/baz/test.md";
			const splitted = new Disk(v).getIncrementalDirectories(path);

			assert.deepEqual(splitted, ["./foo/", "./foo/bar/", "./foo/bar/baz/"]);
		});
	});
});
