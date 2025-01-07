import test, { describe } from "node:test";
import { FileCache } from "./cache";
import assert from "node:assert";
import type { FileWithContent } from "./api/api";
import { version } from "node:os";

describe("FileCache", () => {
    const testFile: FileWithContent = {
        id: 1,
        diskPath: "",
        workspacePath: "foo.md",
        mimeType: "",
        hash: "",
        createdAt: "",
        updatedAt: "",
        workspaceId: 1,
        content: "",
        version: 1,
    };

    test("create", () => {
        const fc = new FileCache();

        fc.create(testFile);

        assert.deepEqual(fc.dump(), [
            {
                id: 1,
                diskPath: "",
                workspacePath: "foo.md",
                mimeType: "",
                hash: "",
                createdAt: "",
                updatedAt: "",
                workspaceId: 1,
                content: "",
                version: 1,
            },
        ]);
    });

    test("basic operations", () => {
        const fc = new FileCache();

        fc.create(testFile);

        // get
        assert.deepEqual(fc.getById(1), testFile);
        assert.deepEqual(fc.getById(2), undefined);

        assert.deepEqual(fc.getByPath("foo.md"), testFile);
        assert.deepEqual(fc.getByPath(""), undefined);

        // has
        assert.deepEqual(fc.hasById(1), true);
        assert.deepEqual(fc.hasById(2), false);

        assert.deepEqual(fc.hasByPath("foo.md"), true);
        assert.deepEqual(fc.hasByPath(""), false);

        // delete
        fc.deleteById(1);
        assert.deepEqual(fc.dump(), []);

        fc.create(testFile);
        assert.deepEqual(fc.hasById(1), true);

        fc.deleteByPath("foo.md");
        assert.deepEqual(fc.dump(), []);
    });

    test("find", () => {
        const fc = new FileCache();

        fc.create(testFile);
        fc.create({ ...testFile, id: 2, workspacePath: "bar.md" });

        const files = fc.find((v) => v.id === 1);

        assert.deepEqual(files, [testFile]);
    });

    test("update path", () => {
        const fc = new FileCache();

        fc.create(testFile);

        fc.setPath(testFile.id, "newPath.md");

        assert.deepEqual(fc.hasByPath("foo.md"), false);

        assert.deepEqual(fc.getById(1), {
            ...testFile,
            workspacePath: "newPath.md",
        });
        assert.deepEqual(fc.getByPath("newPath.md"), {
            ...testFile,
            workspacePath: "newPath.md",
        });
    });
});
