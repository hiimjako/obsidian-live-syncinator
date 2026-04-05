import assert from "node:assert";
import { describe, test } from "node:test";
import { EditorState } from "@codemirror/state";
import {
    clearStaleEffect,
    remoteCursorField,
    removeCursorEffect,
    updateCursorEffect,
} from "./cursorState";

function createState() {
    return EditorState.create({ extensions: [remoteCursorField] });
}

function cursorState(overrides: Record<string, unknown> = {}) {
    return {
        id: "user-1",
        path: "test.md",
        label: "Alice",
        color: "#ff0000",
        line: 0,
        ch: 0,
        lastUpdate: 1000,
        ...overrides,
    };
}

describe("remoteCursorField", () => {
    test("should start with empty cursor map", () => {
        const state = createState();
        const cursors = state.field(remoteCursorField);
        assert.equal(cursors.size, 0);
    });

    test("should add a cursor via updateCursorEffect", () => {
        const state = createState();
        const next = state.update({
            effects: updateCursorEffect.of(cursorState({ id: "user-1" })),
        }).state;

        const cursors = next.field(remoteCursorField);
        assert.equal(cursors.size, 1);
        assert.equal(cursors.get("user-1")?.label, "Alice");
    });

    test("should update an existing cursor", () => {
        let state = createState();
        state = state.update({
            effects: updateCursorEffect.of(cursorState({ id: "user-1", line: 0 })),
        }).state;
        state = state.update({
            effects: updateCursorEffect.of(cursorState({ id: "user-1", line: 5 })),
        }).state;

        const cursors = state.field(remoteCursorField);
        assert.equal(cursors.size, 1);
        assert.equal(cursors.get("user-1")?.line, 5);
    });

    test("should track multiple cursors independently", () => {
        let state = createState();
        state = state.update({
            effects: updateCursorEffect.of(cursorState({ id: "user-1", label: "Alice" })),
        }).state;
        state = state.update({
            effects: updateCursorEffect.of(cursorState({ id: "user-2", label: "Bob" })),
        }).state;

        const cursors = state.field(remoteCursorField);
        assert.equal(cursors.size, 2);
        assert.equal(cursors.get("user-1")?.label, "Alice");
        assert.equal(cursors.get("user-2")?.label, "Bob");
    });

    test("should remove a cursor via removeCursorEffect", () => {
        let state = createState();
        state = state.update({
            effects: updateCursorEffect.of(cursorState({ id: "user-1" })),
        }).state;
        state = state.update({
            effects: removeCursorEffect.of("user-1"),
        }).state;

        const cursors = state.field(remoteCursorField);
        assert.equal(cursors.size, 0);
    });

    test("should not change state when removing non-existent cursor", () => {
        let state = createState();
        state = state.update({
            effects: updateCursorEffect.of(cursorState({ id: "user-1" })),
        }).state;

        const before = state.field(remoteCursorField);
        state = state.update({
            effects: removeCursorEffect.of("non-existent"),
        }).state;
        const after = state.field(remoteCursorField);

        // same reference — no copy-on-write triggered
        assert.strictEqual(before, after);
    });

    test("should clear stale cursors by threshold", () => {
        let state = createState();
        state = state.update({
            effects: [
                updateCursorEffect.of(cursorState({ id: "old", lastUpdate: 100 })),
                updateCursorEffect.of(cursorState({ id: "recent", lastUpdate: 900 })),
            ],
        }).state;

        state = state.update({
            effects: clearStaleEffect.of(500),
        }).state;

        const cursors = state.field(remoteCursorField);
        assert.equal(cursors.size, 1);
        assert.ok(cursors.has("recent"));
        assert.ok(!cursors.has("old"));
    });

    test("should not change state when no cursors are stale", () => {
        let state = createState();
        state = state.update({
            effects: updateCursorEffect.of(cursorState({ id: "user-1", lastUpdate: 1000 })),
        }).state;

        const before = state.field(remoteCursorField);
        state = state.update({
            effects: clearStaleEffect.of(500),
        }).state;
        const after = state.field(remoteCursorField);

        assert.strictEqual(before, after);
    });
});
