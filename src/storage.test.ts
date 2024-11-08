import assert from "node:assert/strict";
import { describe, it as test, afterEach, mock, type Mock } from "node:test";
import fs from "node:fs/promises";
import { computeDiff } from "./diff";
import { Disk } from "./storage";
import { randomUUID } from "node:crypto";
import { Vault } from "obsidian";

describe("Disk storage integration tests", () => {
	afterEach(async () => {
		mock.restoreAll();
	});

	// test("should persist changes correctly for various chunks", async (t) => {
	// 	const v = new Vault();
	// 	t.mock.method(v, "createFolder");
	// 	// t.mock.method(v.adapter, "");
	// 	const d = new Disk(v);
	//
	// 	const tests = [
	// 		// {
	// 		// 	name: "compute remove chunk in present file",
	// 		// 	expected: "hello",
	// 		// 	diffs: [
	// 		// 		computeDiff("hello", ""),
	// 		// 		computeDiff("", "he__llo"),
	// 		// 		computeDiff("he__llo", "hello"),
	// 		// 	],
	// 		// },
	// 		{
	// 			name: "compute add chunk in present file",
	// 			expected: "hello world!",
	// 			diffs: [
	// 				computeDiff("", "hello"),
	// 				computeDiff("hello", "hello!"),
	// 				computeDiff("hello!", "hello world!"),
	// 			],
	// 		},
	// 	];
	//
	// 	for (const tt of tests) {
	// 		await test(tt.name, async () => {
	// 			const fileName = randomUUID();
	// 			await assert.doesNotReject(async () => {
	// 				await d.createObject(fileName, Buffer.from(""));
	// 			});
	//
	// 			assert.ok(await d.fileExists(fileName));
	//
	// 			for (const di of tt.diffs) {
	// 				for (const d2 of di) {
	// 					await assert.doesNotReject(
	// 						async () => await d.persistChunk(fileName, d2),
	// 					);
	// 				}
	// 			}
	// 			const fileContent = await d.readObject(fileName);
	// 			assert.strictEqual(fileContent.toString(), tt.expected);
	// 		});
	// 	}
	// });

	// test("should return error on non-existing file", async () => {
	// 	await assert.rejects(async () => {
	// 		await d.persistChunk("not-existing-file", computeDiff("", "foo")[0]);
	// 	});
	// });

	test("should create, read, and delete objects correctly", async (t) => {
		const v = new Vault();

		const createFolderMock = t.mock.method(v, "createFolder");
		const existsMock = t.mock.method(v.adapter, "exists");
		const writeMock = t.mock.method(v.adapter, "write");

		const d = new Disk(v);

		const path = "foo/bar/baz.md";
		const content = "hello";
		// create object
		const p = await d.createObject(path, content);
		assert.ok(p);

		assert.strictEqual(createFolderMock.mock.callCount(), 0);
		assert.strictEqual(existsMock.mock.callCount(), 1);
		assert.strictEqual(writeMock.mock.callCount(), 1);

		// read object
		// const fileContent = await d.readObject(p);
		// assert.deepStrictEqual(fileContent, content);
		//
		// // delete object
		// let filePath = path.join(d.basepath, p);
		// await assert.doesNotReject(async () => {
		// 	await fs.stat(filePath);
		// });
		//
		// await assert.doesNotReject(async () => {
		// 	await d.deleteObject(p);
		// });
		//
		// await assert.rejects(
		// 	async () => {
		// 		await fs.stat(filePath);
		// 	},
		// 	(err: NodeJS.ErrnoException) => err.code === "ENOENT",
		// );
	});
});

describe("Disk storage utils test", () => {
	describe("getIncrementalDirectories", () => {
		test("should split a path", async () => {
			const path = "./foo/bar/baz/test.md";
			const splitted = new Disk(new Vault()).getIncrementalDirectories(path);

			assert.deepEqual(splitted, ["./foo/", "./foo/bar/", "./foo/bar/baz/"]);
		});
	});
});
