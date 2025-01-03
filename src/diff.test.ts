import { describe, test } from "node:test";
import assert from "node:assert";
import { applyDiff, computeDiff, invertDiff as inverseDiff, Operation } from "./diff";
import type { DiffChunk } from "./diff";

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
			expected: [
				{ position: 0, type: Operation.Remove, text: " ", len: 1 },
			] as DiffChunk[],
		},
		{
			name: "compute add chunk",
			text: "hello!",
			update: "hello world!",
			expected: [
				{ position: 5, type: Operation.Add, text: " world", len: 6 },
			] as DiffChunk[],
		},
		{
			name: "compute add chunk 2",
			text: "h",
			update: "he",
			expected: [
				{ position: 1, type: Operation.Add, text: "e", len: 1 },
			] as DiffChunk[],
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
			diff: { position: 5, type: Operation.Add, text: " world", len: 6 } as DiffChunk,
			expected: { position: 5, type: Operation.Remove, text: " world", len: 6 } as DiffChunk,
		},
		{
			name: "inverse remove diff",
			text: "hello!",
			update: "hello world!",
			diff: { position: 5, type: Operation.Remove, text: " world", len: 6 } as DiffChunk,
			expected: { position: 5, type: Operation.Add, text: " world", len: 6 } as DiffChunk,
		},
	];

	for (const { name, text, update, expected } of tests) {
		test(name, () => {
			let resultText = text;
			const diffs = computeDiff(update, text);

			assert.equal(diffs.length, 1)

			const invert = inverseDiff(diffs[0])
			assert.deepEqual(invert, expected)

			resultText = applyDiff(resultText, invert);
			assert.strictEqual(resultText, update);
		});
	}
});

