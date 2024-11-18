import type { TAbstractFile } from "obsidian";
import type { ApiClient, FileWithContent } from "./api";
import { computeDiff, Operation } from "./diff";
import type { Disk } from "./storage/storage";
import type { ChunkMessage, EventMessage, WsClient } from "./ws";

export interface Events {
	create(file: TAbstractFile): Promise<void>;
	modify(file: TAbstractFile): Promise<void>;
	delete(file: TAbstractFile): Promise<void>;
	rename(file: TAbstractFile, oldPath: string): Promise<void>;
}

export class RealTimePlugin {
	private storage: Disk;
	private filePathToId: Map<string, number> = new Map();
	private fileIdToFile: Map<number, FileWithContent> = new Map();
	private apiClient: ApiClient;
	private wsClient: WsClient;
	events: Events;

	constructor(storage: Disk, apiClient: ApiClient, wsClient: WsClient) {
		this.storage = storage;
		this.apiClient = apiClient;
		this.wsClient = wsClient;

		this.wsClient.registerOnMessage(
			this.onChunkMessage.bind(this),
			this.onEventMessage.bind(this),
		);
		this.wsClient.registerOnError(this.onError.bind(this));
		this.wsClient.registerOnClose(async (event) => {
			if (!event.wasClean) {
				console.error("WebSocket closed unexpectedly");
			}
		});

		this.events = {
			create: this.create.bind(this),
			delete: this.delete.bind(this),
			modify: this.modify.bind(this),
			rename: this.rename.bind(this),
		};
	}

	async init() {
		const files = await this.apiClient.fetchFiles();

		for (const file of files) {
			this.filePathToId.set(file.workspacePath, file.id);

			const exists = await this.storage.exists(file.workspacePath);
			const fileWithContent = await this.apiClient.fetchFile(file.id);

			if (!exists) {
				await this.storage.writeObject(
					file.workspacePath,
					fileWithContent.content,
				);
			} else {
				const currentContent = await this.storage.readObject(
					file.workspacePath,
				);
				const diffs = computeDiff(currentContent, fileWithContent.content);

				if (diffs.some((diff) => diff.type === Operation.DiffRemove)) {
					// FIXME: in case we have deletion we should handle it, maybe asking to the
					// user?
					// For now we just let win the most recent version
					const stat = await this.storage.stat(file.workspacePath);
					const localFileMtime = new Date(stat?.mtime ?? 0);
					const remoteFileMtime = new Date(fileWithContent.updatedAt);

					console.log(remoteFileMtime, localFileMtime);

					if (remoteFileMtime >= localFileMtime) {
						await this.storage.writeObject(
							file.workspacePath,
							fileWithContent.content,
							{ force: true },
						);
					}
				} else {
					// in case of only add we can safely add the text to the local verison
					const content = await this.storage.persistChunks(
						file.workspacePath,
						diffs,
					);
					fileWithContent.content = content;
				}
			}

			this.fileIdToFile.set(file.id, fileWithContent);
		}
		console.log(`fetched ${this.filePathToId.size} files from remote`);
	}

	async onChunkMessage(data: ChunkMessage) {
		console.log("chunk", data);
		const { fileId, chunks } = data;

		const file = this.fileIdToFile.get(fileId);
		if (file == null) {
			console.error(`file '${fileId}' not found`);
			return;
		}

		const content = await this.storage.persistChunks(
			file.workspacePath,
			chunks,
		);

		file.content = content;

		this.fileIdToFile.set(file.id, file);
	}

	async onEventMessage(data: EventMessage) {
		console.log("event", data);
	}

	async onError(event: Event) {
		console.error(event);
	}

	private async create(file: TAbstractFile) {
		if (this.filePathToId.has(file.path)) {
			return;
		}

		try {
			const fileApi = await this.apiClient.createFile(file.path, "");
			this.filePathToId.set(fileApi.workspacePath, fileApi.id);
			this.fileIdToFile.set(fileApi.id, {
				...fileApi,
				content: "",
			});
		} catch (error) {
			console.error(error);
		}
	}

	private async modify(file: TAbstractFile) {
		const fileId = this.filePathToId.get(file.path);
		if (fileId == null) {
			console.error(`file '${file.path}' not found`);
			return;
		}

		const currentFile = this.fileIdToFile.get(fileId);
		if (currentFile == null) {
			console.error(`file '${file.path}' not found`);
			return;
		}

		const newContent = await this.storage.readObject(file.path);
		const chunks = computeDiff(currentFile.content, newContent);

		const oldContent = currentFile.content;
		currentFile.content = newContent;
		this.fileIdToFile.set(fileId, currentFile);

		if (chunks.length > 0) {
			console.log("modify", { fileId, chunks, oldContent, newContent });
			this.wsClient.sendMessage({ fileId, chunks });
		}
	}

	private async delete(file: TAbstractFile) {
		const fileId = this.filePathToId.get(file.path);
		if (!fileId) {
			console.error(`missing file for deletion: ${file.path}`);
			return;
		}

		try {
			await this.apiClient.deleteFile(fileId);
			this.filePathToId.delete(file.path);
		} catch (error) {
			console.error(error);
		}
	}

	private async rename(file: TAbstractFile, oldPath: string) {
		const oldFileId = this.filePathToId.get(oldPath);
		if (!oldFileId) {
			console.error(`missing file for rename: ${oldPath}`);
			return;
		}

		try {
			this.filePathToId.delete(oldPath);
			this.fileIdToFile.delete(oldFileId);
			await this.apiClient.deleteFile(oldFileId);
		} catch (error) {
			console.error(error);
		}

		await this.create(file);
	}

	getFilePathToId(): Map<string, number> {
		return new Map(this.filePathToId);
	}

	getFileIdToFile(): Map<number, FileWithContent> {
		return new Map(this.fileIdToFile);
	}
}
