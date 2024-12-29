import type { TAbstractFile } from "obsidian";
import type { ApiClient, FileWithContent } from "./api/api";
import { computeDiff, Operation } from "./diff";
import type { Disk } from "./storage/storage";
import {
	MessageType,
	type ChunkMessage,
	type EventMessage,
	type WsClient,
} from "./api/ws";
import path from "path-browserify";
import { log } from "src/logger/logger";
import { isTextFile } from "./utils/mime";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Events {
	create(file: TAbstractFile): Promise<void>;
	modify(file: TAbstractFile): Promise<void>;
	delete(file: TAbstractFile): Promise<void>;
	rename(file: TAbstractFile, oldPath: string): Promise<void>;
}

export class Syncinator {
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
				log.error("WebSocket closed unexpectedly");
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

		log.info(files);
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
				if (typeof fileWithContent.content === "string") {
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

						log.info(remoteFileMtime, localFileMtime);

						if (remoteFileMtime >= localFileMtime) {
							await this.storage.writeObject(
								file.workspacePath,
								fileWithContent.content,
								{ force: true },
							);
						}
					} else {
						// in case of only add we can safely add the text to the local version
						const content = await this.storage.persistChunks(
							file.workspacePath,
							diffs,
						);
						fileWithContent.content = content;
					}
				} else {
					log.info(`file ${fileWithContent.workspacePath} is not a text file`);
				}
			}

			this.fileIdToFile.set(file.id, fileWithContent);
		}
		log.info(`fetched ${this.filePathToId.size} files from remote`);
	}

	async onChunkMessage(data: ChunkMessage) {
		log.info("chunk", data);
		const { fileId, chunks } = data;

		const file = this.fileIdToFile.get(fileId);
		if (file == null) {
			log.error(`file '${fileId}' not found`);
			return;
		}

		const content = await this.storage.persistChunks(
			file.workspacePath,
			chunks,
		);

		file.content = content;

		this.fileIdToFile.set(file.id, file);
	}

	async onEventMessage(event: EventMessage) {
		log.info("[socket] new event", event);

		// note the maps that keep track of the current files will be updated
		// in the create and delete events, as creating a file will trigger
		// this functions
		if (event.type === MessageType.Create) {
			if (event.objectType === "file") {
				const fileApi = await this.apiClient.fetchFile(event.fileId);
				this.filePathToId.set(fileApi.workspacePath, fileApi.id);
				this.fileIdToFile.set(fileApi.id, {
					...fileApi,
					content: "",
				});
				this.storage.writeObject(fileApi.workspacePath, fileApi.content);
			} else if (event.objectType === "folder") {
				this.storage.writeObject(event.workspacePath, "", { isDir: true });
			} else {
				log.error("[socket] unknown", event);
			}
		} else if (event.type === MessageType.Delete) {
			if (event.objectType === "file") {
				const file = this.fileIdToFile.get(event.fileId);
				if (!file) {
					log.warn(
						`[socket] cannot delete file ${event.fileId} as it is not present in current workspace`,
					);
					return;
				}
				this.storage.deleteObject(file.workspacePath, { force: true });
			} else if (event.objectType === "folder") {
				const files = await this.storage.listFiles({
					prefix: event.workspacePath,
				});
				if (files.length > 1) {
					// FIXME: check if it is only an edge case, given that it should
					// be the last event in a folder deletion.
					// The files should be already deleted.
					log.error("[soket] trying to delete not empty folder");
					return;
				}
				this.storage.deleteObject(event.workspacePath, { force: true });
			} else {
				log.error("[socket] unknown", event);
			}
		} else if (event.type === MessageType.Rename) {
			if (event.objectType === "file") {
				const file = this.fileIdToFile.get(event.fileId);
				if (!file) {
					log.warn(
						`[socket] cannot delete file ${event.fileId} as it is not present in current workspace`,
					);
					return;
				}

				const fileApi = await this.apiClient.fetchFile(event.fileId);
				const oldPath = file.workspacePath;
				this.filePathToId.delete(oldPath);
				this.filePathToId.set(fileApi.workspacePath, fileApi.id);

				const updatedFile = this.fileIdToFile.get(fileApi.id);
				if (updatedFile) {
					updatedFile.workspacePath = fileApi.workspacePath;
					this.fileIdToFile.set(fileApi.id, updatedFile);
				} else {
					log.error(
						`[socket] file ${oldPath} to ${fileApi.workspacePath} not found`,
					);
				}

				this.storage.rename(oldPath, fileApi.workspacePath);
			} else if (event.objectType === "folder") {
				const workspacePath = event.workspacePath + path.sep;
				const files = await this.storage.listFiles({
					prefix: workspacePath,
				});
				if (files.length === 0) {
					log.error("[socket] trying to rename not existing folder");
					return;
				}

				for (const file of files) {
					const fileId = this.filePathToId.get(file.path);
					if (!fileId) {
						continue;
					}
					const fileDesc = this.fileIdToFile.get(fileId);
					if (!fileDesc) {
						continue;
					}

					const fileApi = await this.apiClient.fetchFile(fileId);
					const oldPath = fileDesc.workspacePath;
					this.filePathToId.delete(oldPath);
					this.filePathToId.set(fileApi.workspacePath, fileApi.id);

					const updatedFile = this.fileIdToFile.get(fileApi.id);
					if (updatedFile) {
						updatedFile.workspacePath = fileApi.workspacePath;
						this.fileIdToFile.set(fileApi.id, updatedFile);
					} else {
						log.error(
							`[socket] file ${oldPath} to ${fileApi.workspacePath} not found`,
						);
					}

					this.storage.rename(oldPath, fileApi.workspacePath);
				}

				// give time to obsidian to update cache
				for (let i = 0; i < 10; i++) {
					const filesPostRename = await this.storage.listFiles({
						prefix: workspacePath,
					});
					if (filesPostRename.length === 0) {
						this.storage.deleteObject(event.workspacePath);
						break;
					}
					await sleep(100);
				}
			} else {
				log.error("[socket] unknown", event);
			}
		} else {
			log.error(`[socket] unknown event ${event}`);
		}
	}

	async onError(event: Event) {
		log.error(event);
	}

	// FIXME: avoid to trigger again create on ws event
	private async create(file: TAbstractFile) {
		log.info("[event]: create", file);
		if (this.filePathToId.has(file.path)) {
			return;
		}

		const stat = await this.storage.stat(file.path);
		if (stat?.type === "folder") {
			const msg: EventMessage = {
				type: MessageType.Create,
				fileId: 0,
				objectType: "folder",
				workspacePath: file.path,
			};
			this.wsClient.sendMessage(msg);
			return;
		}

		try {
			const currentContent = await this.storage.readBinary(file.path);
			const fileApi = await this.apiClient.createFile(
				file.path,
				currentContent,
			);
			this.filePathToId.set(fileApi.workspacePath, fileApi.id);
			this.fileIdToFile.set(fileApi.id, {
				...fileApi,
				content: "",
			});

			const msg: EventMessage = {
				type: MessageType.Create,
				fileId: fileApi.id,
				objectType: "file",
				workspacePath: fileApi.workspacePath,
			};
			this.wsClient.sendMessage(msg);
		} catch (error) {
			log.error(error);
		}
	}

	private async modify(file: TAbstractFile) {
		log.info("[event]: modify", file);
		const fileId = this.filePathToId.get(file.path);
		if (fileId == null) {
			log.error(`file '${file.path}' not found`);
			return;
		}

		const currentFile = this.fileIdToFile.get(fileId);
		if (currentFile == null) {
			log.error(`file '${file.path}' not found`);
			return;
		}

		if (
			!isTextFile(currentFile.mimeType) ||
			typeof currentFile.content !== "string"
		) {
			return;
		}

		const newContent = await this.storage.readObject(file.path);
		const chunks = computeDiff(currentFile.content, newContent);

		const oldContent = currentFile.content;
		currentFile.content = newContent;
		this.fileIdToFile.set(fileId, currentFile);

		if (chunks.length > 0) {
			log.info("modify", { fileId, chunks, oldContent, newContent });

			const msg: ChunkMessage = {
				type: MessageType.Chunk,
				fileId: fileId,
				chunks,
			};
			this.wsClient.sendMessage(msg);
		}
	}

	// FIXME: avoid to trigger again delete on ws event
	private async delete(file: TAbstractFile) {
		log.info("[event]: delete", file);

		const deleteFile = async (fileId: number) => {
			try {
				await this.apiClient.deleteFile(fileId);
				this.fileIdToFile.delete(fileId);
				this.filePathToId.delete(file.path);

				const msg: EventMessage = {
					type: MessageType.Delete,
					fileId: fileId,
					objectType: "file",
					workspacePath: file.path,
				};
				this.wsClient.sendMessage(msg);
			} catch (error) {
				log.error(error);
			}
		};

		const fileId = this.filePathToId.get(file.path);
		if (!fileId) {
			log.error(`missing file for deletion: "${file.path}", probably a folder`);

			for (const [filePath, fileId] of this.filePathToId.entries()) {
				if (filePath.startsWith(file.path + path.sep)) {
					this.filePathToId.delete(filePath);
					this.fileIdToFile.delete(fileId);
					await deleteFile(fileId);
				}
			}

			const msg: EventMessage = {
				type: MessageType.Delete,
				fileId: 0,
				objectType: "folder",
				workspacePath: file.path,
			};
			this.wsClient.sendMessage(msg);
			return;
		}

		await deleteFile(fileId);
	}

	// FIXME: avoid to trigger again rename on ws event
	private async rename(file: TAbstractFile, oldPath: string) {
		log.info("[event]: rename", oldPath, file);
		const fileId = this.filePathToId.get(oldPath);
		if (!fileId) {
			log.error(`missing file for rename: "${oldPath}", probably a folder`);

			const oldWorkspacePath = oldPath + path.sep;
			const folderFiles = await this.storage.listFiles({
				prefix: oldWorkspacePath,
			});
			if (folderFiles.length === 0) {
				log.error("[socket] trying to rename not existing folder");
				return;
			}

			for (const folderFile of folderFiles) {
				const fileId = this.filePathToId.get(folderFile.path);
				if (!fileId) {
					continue;
				}
				const fileDesc = this.fileIdToFile.get(fileId);
				if (!fileDesc) {
					continue;
				}

				const oldFilePath = fileDesc.workspacePath;
				// FIXME: to validate, if it is always safe
				const newFilePath = oldFilePath.replace(oldPath, file.path);

				try {
					await this.apiClient.updateFile(fileId, newFilePath);
				} catch (error) {
					log.error(error);
				}

				this.filePathToId.delete(oldFilePath);
				this.filePathToId.set(newFilePath, fileId);

				const updatedFile = this.fileIdToFile.get(fileId);
				if (updatedFile) {
					updatedFile.workspacePath = newFilePath;
					this.fileIdToFile.set(fileId, updatedFile);
				} else {
					log.error(`[socket] file ${oldFilePath} to ${newFilePath} not found`);
				}

				this.storage.rename(oldFilePath, newFilePath);
			}

			// give time to obsidian to update cache
			for (let i = 0; i < 10; i++) {
				const filesPostRename = await this.storage.listFiles({
					prefix: oldWorkspacePath,
				});
				if (filesPostRename.length === 0) {
					this.storage.deleteObject(oldPath, { force: true });
					break;
				}
				await sleep(100);
			}

			const msg: EventMessage = {
				type: MessageType.Rename,
				fileId: 0,
				objectType: "folder",
				workspacePath: oldPath,
			};
			this.wsClient.sendMessage(msg);

			return;
		}

		try {
			await this.apiClient.updateFile(fileId, file.path);

			this.filePathToId.delete(oldPath);
			this.filePathToId.set(file.path, fileId);

			const updatedFile = this.fileIdToFile.get(fileId);
			if (updatedFile) {
				updatedFile.workspacePath = file.path;
				this.fileIdToFile.set(fileId, updatedFile);
			} else {
				log.error(`file ${oldPath} to ${file.path} not found`);
			}

			// First we create the file so the other clients can fetch it on event
			const msg: EventMessage = {
				type: MessageType.Rename,
				fileId: fileId,
				objectType: "file",
				workspacePath: oldPath,
			};
			this.wsClient.sendMessage(msg);
		} catch (error) {
			log.error(error);
			return;
		}
	}

	getFilePathToId(): Map<string, number> {
		return new Map(this.filePathToId);
	}

	getFileIdToFile(): Map<number, FileWithContent> {
		return new Map(this.fileIdToFile);
	}
}
