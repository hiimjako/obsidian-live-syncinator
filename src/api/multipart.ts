import { arrayBufferToBase64, base64ToArrayBuffer } from "../utils/base64Utils";

type FormField = {
    name: string;
    value: string;
};

type FormFile = {
    name: string;
    filename: string;
    value: string | ArrayBuffer;
    isBase64?: boolean;
};

export class Multipart {
    private _files: FormFile[] = [];
    private _fields: FormField[] = [];
    private _boundary = "";

    constructor() {
        this._boundary = this.randomBoundary();
    }

    public get boundary(): string {
        return this._boundary;
    }

    public get files(): FormFile[] {
        return this._files;
    }

    public get fileds(): FormField[] {
        return this._fields;
    }

    createFormFile(fieldname: string, filename: string, value: string | ArrayBuffer): Multipart {
        let isBase64 = false;
        let stringValue: string;
        if (value instanceof ArrayBuffer) {
            stringValue = arrayBufferToBase64(value);
            isBase64 = true;
        } else {
            stringValue = value;
        }
        this._files.push({
            name: fieldname,
            filename,
            value: stringValue,
            isBase64,
        });

        return this;
    }

    createFormField(filedname: string, value: string): Multipart {
        this._fields.push({
            name: filedname,
            value,
        });
        return this;
    }

    build(): string {
        let body = "";

        for (let i = 0; i < this._fields.length; i++) {
            const field = this._fields[i];
            body += `--${this._boundary}\r\n`;
            body += `Content-Disposition: form-data; name="${field.name}"\r\n\r\n`;
            body += `${field.value}`;
        }

        if (this._files.length > 0) {
            body += "\r\n";
        }

        for (let i = 0; i < this._files.length; i++) {
            const file = this._files[i];
            body += `--${this._boundary}\r\n`;
            body += `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n`;
            body += "Content-Type: application/octet-stream\r\n";
            if (file.isBase64) {
                body += "Content-Transfer-Encoding: base64\r\n";
            }
            body += "\r\n";
            body += file.value;
            if (i !== this._files.length - 1) {
                body += "\r\n";
            }
        }

        body += `\r\n--${this._boundary}--\r\n`;

        return body;
    }

    contentType(): string {
        return `multipart/form-data; boundary=${this._boundary}`;
    }

    private randomBoundary(): string {
        let boundary = Math.random().toString(36).substring(2) + Date.now().toString(36);

        const specialChars = `()<>@,;:\\\"/[]?= `;

        if (new RegExp(`[${specialChars}]`).test(boundary)) {
            boundary = `"${boundary}"`;
        }

        return boundary;
    }

    parseParts(contentType: string, encoded: AllowSharedBufferSource): Multipart {
        const isMultipart =
            contentType?.startsWith("multipart/mixed") ||
            contentType?.startsWith("multipart/form-data");
        if (!isMultipart) {
            throw new Error("Unexpected Content-Type, expected multipart/mixed");
        }

        const boundary = contentType.split("boundary=")[1];
        if (!boundary) {
            throw new Error("Boundary not found in Content-Type header");
        }

        this._files = [];
        this._fields = [];

        const decoder = new TextDecoder();
        const textData = decoder.decode(encoded);

        const rawParts = textData.split(`--${boundary}`);

        for (let i = 0; i < rawParts.length; i++) {
            const rawPart = rawParts[i];

            if (rawPart.length === 0) {
                continue;
            }

            const components = rawPart.split("\r\n");

            const part = {
                value: "" as string | ArrayBuffer,
                name: "",
                contentType: "",
                filename: "",
                isBase64: false,
            };

            let lastIndexProcessed = 0;
            // parsing headers
            for (let j = 0; j < components.length; j++) {
                const component = components[j];

                if (component.startsWith("Content-Type:")) {
                    part.contentType = component.substring("Content-Type:".length).trim();
                    lastIndexProcessed = j;
                }

                if (component.startsWith("Content-Disposition:")) {
                    const nameMatch = component.match(/name="([^"]*)"/);
                    const filenameMatch = component.match(/filename="([^"]*)"/);

                    part.name = nameMatch ? nameMatch[1].trim() : "";
                    part.filename = filenameMatch ? filenameMatch[1].trim() : "";
                    lastIndexProcessed = j;
                }

                if (component.startsWith("Content-Transfer-Encoding:")) {
                    part.isBase64 =
                        component.substring("Content-Transfer-Encoding:".length).trim() ===
                        "base64";
                    lastIndexProcessed = j;
                }
            }

            // parsing value
            for (let j = components.length - 1; j > lastIndexProcessed; j--) {
                const component = components[j];

                if (component.length !== 0) {
                    if (part.isBase64) {
                        part.value = base64ToArrayBuffer(component.trim());
                    } else {
                        part.value = component.trim();
                    }
                    break;
                }
            }

            // invalid part
            if (part.name === "") {
                continue;
            }

            if (part.filename === "") {
                this.fileds.push({
                    name: part.name,
                    value: part.value as string,
                });
            } else {
                this.files.push({
                    name: part.name,
                    value: part.value,
                    filename: part.filename,
                });
            }
        }

        return this;
    }
}
