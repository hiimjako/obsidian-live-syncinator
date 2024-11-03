import { describe, test } from "node:test";
import assert from "node:assert";
import { applyDiff, computeDiff, Operation } from "./diff";
import type { DiffChunk } from "./diff";

describe("compute diff should be compliant with server implemenation", () => {
	const testCases = [
		{
			name: "compute remove chunk",
			text: "hello world!",
			update: "hello!",
			expected: [
				{ position: 5, type: Operation.DiffRemove, text: " world", len: 6 },
			] as DiffChunk[],
		},
		{
			name: "compute remove chunk 2",
			text: " ",
			update: "",
			expected: [
				{ position: 0, type: Operation.DiffRemove, text: " ", len: 1 },
			] as DiffChunk[],
		},
		{
			name: "compute add chunk",
			text: "hello!",
			update: "hello world!",
			expected: [
				{ position: 5, type: Operation.DiffAdd, text: " world", len: 6 },
			] as DiffChunk[],
		},
		{
			name: "compute add chunk 2",
			text: "h",
			update: "he",
			expected: [
				{ position: 1, type: Operation.DiffAdd, text: "e", len: 1 },
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
			type: Operation.DiffRemove,
			len: 4,
			text: "test",
			position: 10,
		} as DiffChunk;

		assert.strictEqual(applyDiff(emptyText, diffToRemove), "");
	});
});