import { StatusCodes } from "http-status-codes";
import type { HttpClient } from "./http";

declare interface File {
	id: number;
	disk_path: string;
	workspace_path: string;
	mime_type: string;
	hash: string;
	created_at: string;
	updated_at: string;
	workspace_id: number;
}

declare interface FileWithContent extends File {
	content: string;
}

declare interface CreateFile {
	path: string;
	content: string;
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

		return res.data;
	}

	// async fetchFile(name: string, password: string): Promise<FileWithContent> {
	// 	const wc: WorkspaceCredentials = { name, password };
	//
	// 	const res = await this.client.post<AuthToken>("/v1/auth/login", wc);
	//
	// 	console.log(res);
	// 	if (res.status !== StatusCodes.OK) {
	// 		throw new Error(`invalid credentials for workspace ${wc.name}`);
	// 	}
	//
	// 	return res.data;
	// }

	async createFile(path: string, content: string): Promise<File> {
		const body: CreateFile = { path, content };

		const res = await this.client.post<File>("/v1/api/file", body);

		if (res.status !== StatusCodes.CREATED) {
			throw new Error(`error while creating file: ${res.data}`);
		}

		return res.data;
	}

	async deleteFile(fileId: number): Promise<void> {
		const res = await this.client.delete(`/v1/api/file/${fileId}`);

		if (res.status !== StatusCodes.OK) {
			throw new Error(`error while deleting file: ${res.data}`);
		}
	}
}
