type FormField = {
	name: string;
	value: string;
};

type FormFile = {
	name: string;
	filename: string;
	value: string;
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

	createFormFile(
		fieldname: string,
		filename: string,
		value: string,
	): Multipart {
		this._files.push({
			name: fieldname,
			filename,
			value,
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

		for (let i = 0; i < this._files.length; i++) {
			const file = this._files[i];
			body += `--${this._boundary}\r\n`;
			body += `Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n`;
			body += "Content-Type: application/octet-stream\r\n\r\n";
			body += file.value;
		}

		for (let i = 0; i < this._fields.length; i++) {
			const field = this._fields[i];
			body += `--${this._boundary}\r\n`;
			body += `Content-Disposition: form-data; name="${field.name}"\r\n\r\n`;
			body += `${field.value}`;
		}

		body += `\r\n--${this._boundary}--\r\n`;

		return body;
	}

	contentType(): string {
		return `multipart/form-data; boundary=${this._boundary}`;
	}

	private randomBoundary(): string {
		let boundary =
			Math.random().toString(36).substring(2) + Date.now().toString(36);

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
				value: "",
				name: "",
				contentType: "",
				filename: "",
			};
			// parsing headers
			for (let j = 0; j < components.length; j++) {
				const component = components[j];

				if (component.startsWith("Content-Type:")) {
					part.contentType = component.substring("Content-Type:".length).trim();
				}

				if (component.startsWith("Content-Disposition:")) {
					const nameMatch = component.match(/name="([^"]*)"/);
					const filenameMatch = component.match(/filename="([^"]*)"/);

					part.name = nameMatch ? nameMatch[1].trim() : "";
					part.filename = filenameMatch ? filenameMatch[1].trim() : "";
				}
			}

			// parsing value
			for (let j = components.length - 1; j >= 0; j--) {
				const component = components[j];

				if (component.length !== 0) {
					part.value = component.trim();
					break;
				}
			}

			// invalid part
			if (part.name === "") {
				continue;
			}

			if (part.contentType === "application/octet-stream") {
				this.files.push({
					name: part.name,
					value: part.value,
					filename: part.filename,
				});
			} else {
				this.fileds.push({
					name: part.name,
					value: part.value,
				});
			}
		}

		return this;
	}
}
