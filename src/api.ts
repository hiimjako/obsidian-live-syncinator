import { StatusCodes } from "http-status-codes";
import type { HttpClient } from "./http";
import path from "path-browserify";
import { Multipart } from "./multipart";

export declare interface File {
	id: number;
	diskPath: string;
	workspacePath: string;
	mimeType: string;
	hash: string;
	createdAt: string;
	updatedAt: string;
	workspaceId: number;
}

export declare interface FileWithContent extends File {
	content: string;
}

declare interface CreateFile {
	path: string;
	content: string;
}

declare interface UpdateFile {
	path: string;
}

interface WorkspaceCredentials {
	name: string;
	password: string;
}

interface AuthToken {
	token: string;
}

export class ApiClient {
	private client: HttpClient;
	constructor(client: HttpClient) {
		this.client = client;
	}

	async fetchFiles(): Promise<File[]> {
		const res = await this.client.get<File[]>("/v1/api/file");

		if (res.status !== StatusCodes.OK) {
			throw new Error(`error while fetching files: ${res.data}`);
		}

		return res.data ?? [];
	}

	async fetchFile(fileId: number): Promise<FileWithContent> {
		const res = await this.client.get<ArrayBuffer>(`/v1/api/file/${fileId}`);

		if (res.status !== StatusCodes.OK) {
			throw new Error(`error while fetching file content ${res.data}`);
		}

		const contentType = res.headers.get("Content-Type");
		if (!contentType || !contentType.startsWith("multipart/mixed")) {
			throw new Error("Unexpected Content-Type, expected multipart/mixed");
		}

		const multipart = new Multipart().parseParts(contentType, res.data);
		const filePart = multipart.files?.[0] ?? null;
		const metadataPart = multipart.fileds.find(
			(field) => field.name === "metadata",
		);

		if (!metadataPart || !filePart) {
			throw new Error("Incomplete multipart response");
		}

		// Extract and parse the metadata
		const metadata: File = JSON.parse(metadataPart.value);

		// Extract the file content (as a Blob)
		const fileBlob = new Blob([filePart.value], { type: metadata.mimeType });

		// TODO: optimize this using streams
		const fileWithContent: FileWithContent = {
			...metadata,
			content: await fileBlob.text(),
		};

		return fileWithContent;
	}

	async createFile(filepath: string, content: string): Promise<File> {
		const multipart = new Multipart()
			.createFormFile("file", path.basename(filepath), content)
			.createFormField("path", filepath);

		const body = multipart.build();
		const res = await this.client.post<File>("/v1/api/file", body, {
			"Content-Type": multipart.contentType(),
			"Content-Length": `${body.length}`,
		});
		if (res.status !== StatusCodes.CREATED) {
			throw new Error(`error while creating file: ${res.data}`);
		}

		return res.data ?? {};
	}

	async updateFile(fileId: number, path: string): Promise<void> {
		const body: UpdateFile = { path };

		const res = await this.client.patch<void>(`/v1/api/file/${fileId}`, body);

		if (res.status !== StatusCodes.NO_CONTENT) {
			throw new Error(`error while updating file: ${res.data}`);
		}
	}

	async deleteFile(fileId: number): Promise<void> {
		const res = await this.client.delete(`/v1/api/file/${fileId}`);

		if (res.status !== StatusCodes.NO_CONTENT) {
			throw new Error(`error while deleting file: ${res.data}`);
		}
	}

	async login(name: string, password: string): Promise<AuthToken> {
		const wc: WorkspaceCredentials = { name, password };

		const res = await this.client.post<AuthToken>("/v1/auth/login", wc);

		if (res.status !== StatusCodes.OK) {
			throw new Error(
				`invalid credentials for workspace ${wc.name}: ${res.data}`,
			);
		}

		return res.data;
	}

	async refreshToken(name: string, password: string) {
		const res = await this.login(name, password);
		this.client.setAuthorizationHeader(res.token);
	}
}

function randomBoundary(): string {
	let boundary =
		Math.random().toString(36).substring(2) + Date.now().toString(36);

	const specialChars = `()<>@,;:\\\"/[]?= `;

	if (new RegExp(`[${specialChars}]`).test(boundary)) {
		boundary = `"${boundary}"`;
	}

	return boundary;
}
