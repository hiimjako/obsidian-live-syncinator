import { describe, test } from "node:test";
import assert from "node:assert";
import { Multipart } from "./multipart";

describe("Multipart", () => {
	test("should create multipart", () => {
		const multipart = new Multipart()
			.createFormField("field", "foo")
			.createFormFile("file", "file.md", "content");

		const output = multipart.build();
		const contentType = multipart.contentType();

		assert.equal(
			output,
			`--${multipart.boundary}\r
Content-Disposition: form-data; name="file"; filename="file.md"\r
Content-Type: application/octet-stream\r
\r
content--${multipart.boundary}\r
Content-Disposition: form-data; name="field"\r
\r
foo\r
--${multipart.boundary}--\r\n`,
		);

		assert.equal(
			contentType,
			`multipart/form-data; boundary=${multipart.boundary}`,
		);
	});

	test("should parse multipart", () => {
		const boundary = "random-boundary";
		const rawMultipart = `--${boundary}\r
Content-Disposition: form-data; name="file"; filename="file.md"\r
Content-Type: application/octet-stream\r
\r
content--${boundary}\r
Content-Disposition: form-data; name="field"\r
\r
foo\r
--${boundary}--\r\n`;

		const encoder = new TextEncoder();
		const multipart = new Multipart().parseParts(
			`multipart/form-data; boundary=${boundary}`,
			encoder.encode(rawMultipart).buffer,
		);

		assert.deepEqual(multipart.files, [
			{
				name: "file",
				filename: "file.md",
				value: "content",
			},
		]);
		assert.deepEqual(multipart.fileds, [
			{
				name: "field",
				value: "foo",
			},
		]);
	});
});
