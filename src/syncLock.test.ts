import assert from "node:assert";
import { describe, test } from "node:test";
import { SyncLock } from "./syncLock";

describe("SyncLock", () => {
    test("acquireChunkLock blocks waitForChunk until released", async () => {
        const lock = new SyncLock();
        const release = lock.acquireChunkLock(1);

        let resolved = false;
        const waiting = lock.waitForChunk(1).then(() => {
            resolved = true;
        });

        // give microtask a chance to resolve
        await new Promise((r) => setTimeout(r, 10));
        assert.equal(resolved, false);

        release();
        await waiting;
        assert.equal(resolved, true);
    });

    test("acquireModifyLock blocks waitForModify until released", async () => {
        const lock = new SyncLock();
        const release = lock.acquireModifyLock(1);

        let resolved = false;
        const waiting = lock.waitForModify(1).then(() => {
            resolved = true;
        });

        await new Promise((r) => setTimeout(r, 10));
        assert.equal(resolved, false);

        release();
        await waiting;
        assert.equal(resolved, true);
    });

    test("waitForChunk resolves immediately when no lock held", async () => {
        const lock = new SyncLock();
        await lock.waitForChunk(1);
    });

    test("waitForModify resolves immediately when no lock held", async () => {
        const lock = new SyncLock();
        await lock.waitForModify(1);
    });

    test("locks are per-fileId", async () => {
        const lock = new SyncLock();
        const release = lock.acquireChunkLock(1);

        // file 2 should not be blocked
        await lock.waitForChunk(2);

        release();
    });

    test("suppressModify and consumeSuppression", () => {
        const lock = new SyncLock();

        assert.equal(lock.consumeSuppression("a.md"), false);

        lock.suppressModify("a.md");
        assert.equal(lock.consumeSuppression("a.md"), true);

        // second consume should return false
        assert.equal(lock.consumeSuppression("a.md"), false);
    });

    test("suppress is per-path", () => {
        const lock = new SyncLock();
        lock.suppressModify("a.md");

        assert.equal(lock.consumeSuppression("b.md"), false);
        assert.equal(lock.consumeSuppression("a.md"), true);
    });
});
