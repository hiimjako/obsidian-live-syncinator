import assert from "node:assert";
import test, { describe } from "node:test";
import { shallowEqualStrict } from "./comparison";

describe("shallowEqualStrict", () => {
	test("equal objects", () => {
		const obj1 = {
			foo: 1,
			bar: "foo",
		};

		const obj2 = {
			bar: "foo",
			foo: 1,
		};

		assert.equal(shallowEqualStrict(obj1, obj2), true);
	});
});
