import { StatusCodes } from "http-status-codes";
import type { HttpClient } from "./http";

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
		const res = await this.client.get<FileWithContent>(
			`/v1/api/file/${fileId}`,
		);

		if (res.status !== StatusCodes.OK) {
			throw new Error(`error while fetching file content ${res.data}`);
		}

		return res.data;
	}

	async createFile(path: string, content: string): Promise<File> {
		const body: CreateFile = { path, content };

		const res = await this.client.post<File>("/v1/api/file", body);

		if (res.status !== StatusCodes.CREATED) {
			throw new Error(`error while creating file: ${res.data}`);
		}

		return res.data ?? {};
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
