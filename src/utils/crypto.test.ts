import assert from "node:assert";
import test from "node:test";
import { generateSHA256Hash } from "./crypto";

test("generateSHA256Hash", async () => {
    const tests = [
        {
            input: "test",
            expected: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
        },
    ];

    for (const tt of tests) {
        const actual = await generateSHA256Hash(tt.input);
        assert.strictEqual(actual, tt.expected);
    }
});
