import assert from "node:assert";
import { describe, test } from "node:test";
import {
    Operation,
    applyDiff,
    computeDiff,
    invertDiff,
    transform,
    transformMultiple,
} from "../diff/diff";
import type { DiffChunk } from "../diff/diff";

describe("compute diff should be compliant with server implemenation", () => {
    const testCases = [
        {
            name: "compute remove chunk",
            text: "hello world!",
            update: "hello!",
            expected: [
                { position: 5, type: Operation.Remove, text: " world", len: 6 },
            ] as DiffChunk[],
        },
        {
            name: "compute remove chunk 2",
            text: " ",
            update: "",
            expected: [{ position: 0, type: Operation.Remove, text: " ", len: 1 }] as DiffChunk[],
        },
        {
            name: "compute add chunk",
            text: "hello!",
            update: "hello world!",
            expected: [{ position: 5, type: Operation.Add, text: " world", len: 6 }] as DiffChunk[],
        },
        {
            name: "compute add chunk 2",
            text: "h",
            update: "he",
            expected: [{ position: 1, type: Operation.Add, text: "e", len: 1 }] as DiffChunk[],
        },
        {
            name: "handles newlines",
            text: `hello

			world`,
            update: "hello world",
            expected: [
                { len: 5, position: 5, text: "\n\n\t\t\t", type: -1 },
                { len: 1, position: 5, text: " ", type: 1 },
            ] as DiffChunk[],
        },
    ];

    for (const { name, text, update, expected } of testCases) {
        test(name, () => {
            assert.deepEqual(computeDiff(text, update), expected);
        });
    }
});

describe("applyDiff should modify text as expected", () => {
    const tests = [
        {
            name: "add a chunk",
            text: "hello!",
            expected: "hello world!",
        },
        {
            name: "add a chunk from empty string",
            text: "",
            expected: " world",
        },
        {
            name: "add a chunk from 0",
            text: "",
            expected: "test",
        },
        {
            name: "remove a chunk",
            text: "hello world!",
            expected: "helloworld!",
        },
        {
            name: "remove a chunk from 0",
            text: "test",
            expected: "",
        },
        {
            name: "add in middle of word",
            text: "wold",
            expected: "world",
        },
    ];

    for (const { name, text, expected } of tests) {
        test(name, () => {
            let resultText = text;
            const diffs = computeDiff(text, expected);

            for (const diff of diffs) {
                resultText = applyDiff(resultText, diff);
            }

            assert.strictEqual(resultText, expected);
        });
    }

    test("remove a chunk from empty string", () => {
        const emptyText = "";
        const diffToRemove = {
            type: Operation.Remove,
            len: 4,
            text: "test",
            position: 10,
        } as DiffChunk;

        assert.strictEqual(applyDiff(emptyText, diffToRemove), "");
    });
});

describe("inverseDiff", () => {
    const tests = [
        {
            name: "inverse add diff",
            text: "hello world!",
            update: "hello!",
            diff: {
                position: 5,
                type: Operation.Add,
                text: " world",
                len: 6,
            } as DiffChunk,
            expected: {
                position: 5,
                type: Operation.Remove,
                text: " world",
                len: 6,
            } as DiffChunk,
        },
        {
            name: "inverse remove diff",
            text: "hello!",
            update: "hello world!",
            diff: {
                position: 5,
                type: Operation.Remove,
                text: " world",
                len: 6,
            } as DiffChunk,
            expected: {
                position: 5,
                type: Operation.Add,
                text: " world",
                len: 6,
            } as DiffChunk,
        },
    ];

    for (const { name, text, update, expected } of tests) {
        test(name, () => {
            let resultText = text;
            const diffs = computeDiff(update, text);

            assert.equal(diffs.length, 1);

            const invert = invertDiff(diffs[0]);
            assert.deepEqual(invert, expected);

            resultText = applyDiff(resultText, invert);
            assert.strictEqual(resultText, update);
        });
    }
});

describe("transform", () => {
    const tests = [
        {
            name: "Insert before Insert",
            op1: { type: Operation.Add, position: 3, text: "abc", len: 3 } as DiffChunk,
            op2: { type: Operation.Add, position: 5, text: "xyz", len: 3 } as DiffChunk,
            expected: { type: Operation.Add, position: 8, text: "xyz", len: 3 } as DiffChunk,
        },
        {
            name: "Insert at same position",
            op1: { type: Operation.Add, position: 5, text: "abc", len: 3 } as DiffChunk,
            op2: { type: Operation.Add, position: 5, text: "xyz", len: 3 } as DiffChunk,
            expected: { type: Operation.Add, position: 8, text: "xyz", len: 3 } as DiffChunk,
        },
        {
            name: "Insert before Remove",
            op1: { type: Operation.Add, position: 3, text: "abc", len: 3 } as DiffChunk,
            op2: { type: Operation.Remove, position: 5, text: "xyz", len: 3 } as DiffChunk,
            expected: { type: Operation.Remove, position: 8, text: "xyz", len: 3 } as DiffChunk,
        },
        {
            name: "Remove before Insert",
            op1: { type: Operation.Remove, position: 3, text: "abc", len: 3 } as DiffChunk,
            op2: { type: Operation.Add, position: 6, text: "xyz", len: 3 } as DiffChunk,
            expected: { type: Operation.Add, position: 3, text: "xyz", len: 3 } as DiffChunk,
        },
        {
            name: "Remove overlapping Remove",
            op1: { type: Operation.Remove, position: 3, text: "bcd", len: 3 } as DiffChunk,
            op2: { type: Operation.Remove, position: 2, text: "abcd", len: 4 } as DiffChunk,
            expected: { type: Operation.Remove, position: 2, text: "a", len: 1 } as DiffChunk,
        },
        {
            name: "Remove non-overlapping Remove",
            op1: { type: Operation.Remove, position: 3, text: "abc", len: 3 } as DiffChunk,
            op2: { type: Operation.Remove, position: 6, text: "xyz", len: 3 } as DiffChunk,
            expected: { type: Operation.Remove, position: 3, text: "xyz", len: 3 } as DiffChunk,
        },
        {
            name: "Insert after Remove",
            op1: { type: Operation.Remove, position: 3, text: "abc", len: 3 } as DiffChunk,
            op2: { type: Operation.Add, position: 6, text: "xyz", len: 3 } as DiffChunk,
            expected: { type: Operation.Add, position: 3, text: "xyz", len: 3 } as DiffChunk,
        },
    ];

    for (const { name, op1, op2, expected } of tests) {
        test(name, () => {
            const result = transform(op1, op2);
            assert.deepEqual(result, expected);
        });
    }
});

describe("UTF-16 transform", () => {
    const tests = [
        {
            name: "Transform with emoji insertion",
            op1: { type: Operation.Add, position: 3, text: "👋", len: 1 } as DiffChunk,
            op2: { type: Operation.Add, position: 5, text: "world", len: 5 } as DiffChunk,
            expected: { type: Operation.Add, position: 6, text: "world", len: 5 } as DiffChunk,
        },
        {
            name: "Transform with combining characters",
            op1: { type: Operation.Add, position: 3, text: "é", len: 1 } as DiffChunk,
            op2: { type: Operation.Remove, position: 4, text: "test", len: 4 } as DiffChunk,
            expected: { type: Operation.Remove, position: 5, text: "test", len: 4 } as DiffChunk,
        },
        {
            name: "Transform with zero-width joiner sequence",
            op1: { type: Operation.Add, position: 3, text: "👨", len: 5 } as DiffChunk,
            op2: { type: Operation.Add, position: 4, text: "test", len: 4 } as DiffChunk,
            expected: { type: Operation.Add, position: 9, text: "test", len: 4 } as DiffChunk,
        },
    ];

    for (const { name, op1, op2, expected } of tests) {
        test(name, () => {
            const result = transform(op1, op2);
            assert.deepEqual(result, expected);
        });
    }
});

describe("transformMultiple", () => {
    const tests = [
        {
            name: "Add and Remove interleaved",
            text: "foo",
            result: "foobarbaz",
            opList1: [
                { type: Operation.Add, position: 0, text: "foo", len: 3 } as DiffChunk,
                { type: Operation.Add, position: 3, text: "bar", len: 3 } as DiffChunk,
            ],
            opList2: [
                { type: Operation.Remove, position: 0, text: "foo", len: 3 } as DiffChunk,
                { type: Operation.Add, position: 0, text: "baz", len: 3 } as DiffChunk,
            ],
            expected: [
                { type: Operation.Remove, position: 6, text: "foo", len: 3 } as DiffChunk,
                { type: Operation.Add, position: 6, text: "baz", len: 3 } as DiffChunk,
            ],
        },
    ];

    for (const { name, text, opList1, opList2, expected, result } of tests) {
        test(name, () => {
            const transformed = transformMultiple(opList1, opList2);
            assert.deepEqual(transformed, expected);

            // Apply operations and verify the result
            let currentText = text;

            // Apply opList1
            for (const op of opList1) {
                currentText = applyDiff(currentText, op);
            }

            // Apply transformed opList2
            for (const op of transformed) {
                currentText = applyDiff(currentText, op);
            }

            assert.strictEqual(currentText, result);
        });
    }
});
