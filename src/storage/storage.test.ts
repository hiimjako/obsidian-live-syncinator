import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, mock, it as test } from "node:test";
import type { Vault } from "obsidian";
import { computeDiff } from "../diff/diff";
import { Disk } from "../storage/storage";
import { CreateVaultMock } from "../storage/storage.mock";

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
                await d.write(fileName, tt.initialContent);

                assert.strictEqual(await d.exists(fileName), true);

                let content = "";
                for (const di of tt.diffs) {
                    content = await d.persistChunks(fileName, di);
                }

                const fileContent = await d.readText(fileName);
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

    test("should list files", async () => {
        const d = new Disk(v);

        const path1 = "folder/file1.md";
        const path2 = "folder/file2.png";
        const path3 = "anotherFolder/file1.md";
        await d.write(path1, "");
        await d.write(path2, "");
        await d.write(path3, "");

        /*@ts-ignore*/
        const listFilesNames = async (opts = {}): Promise<string[]> => {
            const files = await d.listFiles(opts);
            return files.map((file) => file.path);
        };

        assert.deepEqual(await listFilesNames(), [path3, path1, path2]);
        assert.deepEqual(await listFilesNames({ prefix: "folder" }), [path1, path2]);
        assert.deepEqual(await listFilesNames({ markdownOnly: true }), [path3, path1]);
        assert.deepEqual(await listFilesNames({ prefix: "folder", markdownOnly: true }), [path1]);
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

        await d.write(path, content);
        assert.strictEqual(createFolderMock.mock.callCount(), 2);
        assert.strictEqual(existsMock.mock.callCount(), 3);
        assert.strictEqual(writeMock.mock.callCount(), 1);

        // read object
        const fileContent = await d.readText(path);
        assert.deepStrictEqual(fileContent, content);

        assert.strictEqual(getFileByPath.mock.callCount(), 1);
        assert.strictEqual(cachedRead.mock.callCount(), 1);

        // delete object
        await d.delete(path);
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

        test("should handle folder path", async () => {
            const path = "./foo/bar/";
            const splitted = new Disk(v).getIncrementalDirectories(path);

            assert.deepEqual(splitted, ["./foo/", "./foo/bar/"]);
        });
    });
});
