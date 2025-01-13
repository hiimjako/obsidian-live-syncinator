import assert from "node:assert";
import { describe, test } from "node:test";
import { base64ToArrayBuffer } from "./base64Utils";
import { Multipart } from "./multipart";

describe("Multipart", () => {
    test("should create multipart", () => {
        const multipart = new Multipart()
            .createFormField("field", "foo")
            .createFormFile("image", "image.png", base64ToArrayBuffer("ZHVtbXk="))
            .createFormFile("file", "file.md", "content");

        const output = multipart.build();
        const contentType = multipart.contentType();

        assert.equal(
            output,
            `--${multipart.boundary}\r
Content-Disposition: form-data; name="field"\r
\r
foo\r
--${multipart.boundary}\r
Content-Disposition: form-data; name="image"; filename="image.png"\r
Content-Type: application/octet-stream\r
Content-Transfer-Encoding: base64\r
\r
ZHVtbXk=\r
--${multipart.boundary}\r
Content-Disposition: form-data; name="file"; filename="file.md"\r
Content-Type: application/octet-stream\r
\r
content\r
--${multipart.boundary}--\r\n`,
        );

        assert.equal(contentType, `multipart/form-data; boundary=${multipart.boundary}`);
    });

    test("should parse multipart", () => {
        const boundary = "random-boundary";
        const rawMultipart = `--${boundary}\r
Content-Disposition: form-data; name="file"; filename="file.md"\r
Content-Type: application/octet-stream\r
Content-Transfer-Encoding: base64\r
\r
content\r
--${boundary}\r
Content-Disposition: form-data; name="text-file"; filename="file.md"\r
Content-Type: application/octet-stream\r
\r
content\r
--${boundary}\r
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
                value: new Uint8Array([0x72, 0x89, 0xed, 0x7a, 0x7b]).buffer,
            },
            {
                name: "text-file",
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
