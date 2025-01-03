import type { TAbstractFile } from "obsidian";
import type { ApiClient } from "./api/api";
import { computeDiff, invertDiff, type DiffChunk } from "./diff";
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
import { isText } from "./storage/filetype";
import { FileCache } from "./cache";
import { DequeRegistry } from "./messageQueue";
import { shallowEqualStrict } from "./utils/comparison";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Events {
	create(file: TAbstractFile): Promise<void>;
	modify(file: TAbstractFile): Promise<void>;
	delete(file: TAbstractFile): Promise<void>;
	rename(file: TAbstractFile, oldPath: string): Promise<void>;
}

export type ConflictResolution = "remote" | "local" | "auto";
export interface Options {
	conflictResolution: ConflictResolution;
}

export class Syncinator {
	private storage: Disk;
	private fileCache: FileCache = new FileCache();
	private apiClient: ApiClient;
	private wsClient: WsClient;
	private messageQueueRegistry = new DequeRegistry<number, ChunkMessage>();
	private options: Options = {
		conflictResolution: "remote",
	};
	private lockedFiles = new Set<number>();

	events: Events;

	constructor(
		storage: Disk,
		apiClient: ApiClient,
		wsClient: WsClient,
		opts: Options,
	) {
		this.storage = storage;
		this.apiClient = apiClient;
		this.wsClient = wsClient;

		this.wsClient.onChunkMessage(this.onChunkMessage.bind(this));
		this.wsClient.onEventMessage(this.onEventMessage.bind(this));
		this.wsClient.connect();

		this.events = {
			create: this.create.bind(this),
			delete: this.delete.bind(this),
			modify: this.modify.bind(this),
			rename: this.rename.bind(this),
		};

		this.options = opts;
	}

	async init() {
		await this.fetchRemoteFiles();
		await this.pushLocalFiles();
	}

	/**
	 * Publish to the server the local unsynchronized files
	 */
	async pushLocalFiles() {
		const files = await this.storage.listFiles();

		for (const file of files) {
			if (this.fileCache.hasByPath(file.path)) {
				continue;
			}

			let currentContent: string | ArrayBuffer;
			if (isText(file.path)) {
				currentContent = await this.storage.readText(file.path);
			} else {
				currentContent = await this.storage.readBinary(file.path);
			}
			const fileApi = await this.apiClient.createFile(
				file.path,
				currentContent,
			);
			this.fileCache.create({ ...fileApi, content: currentContent });

			const msg: EventMessage = {
				type: MessageType.Create,
				fileId: fileApi.id,
				objectType: "file",
				workspacePath: fileApi.workspacePath,
			};
			this.wsClient.sendMessage(msg);
		}
	}

	/**
	 * Publish to the server the local unsynchronized files
	 */
	async fetchRemoteFiles() {
		const files = await this.apiClient.fetchFiles();

		log.debug(`fetched ${files.length} files from remote`, files);
		for (const file of files) {
			const exists = await this.storage.exists(file.workspacePath);
			const fileWithContent = await this.apiClient.fetchFile(file.id);

			this.fileCache.create(fileWithContent);
			if (!exists) {
				await this.storage.write(file.workspacePath, fileWithContent.content);
			} else {
				// Conflict

				if (
					!isText(file.workspacePath) ||
					typeof fileWithContent.content !== "string"
				) {
					// TODO: it should check for binary files that changed with same workspacePath
					continue;
				}
				const localContent = await this.storage.readText(file.workspacePath);
				if (fileWithContent.content === localContent) {
					continue;
				}

				const stat = await this.storage.stat(file.workspacePath);
				const localFileMtime = new Date(stat?.mtime ?? stat?.ctime ?? 0);
				const remoteFileMtime = new Date(fileWithContent.updatedAt);

				const shouldRemote =
					this.options.conflictResolution === "auto" &&
					remoteFileMtime >= localFileMtime;

				const shouldLocal =
					this.options.conflictResolution === "auto" &&
					remoteFileMtime < localFileMtime;

				if (this.options.conflictResolution === "remote" || shouldRemote) {
					log.debug(
						`handling conflic on file ${file.workspacePath}, overwriting local copy`,
					);
					this.fileCache.setById(file.id, {
						...file,
						content: fileWithContent.content,
					});
					await this.storage.write(
						file.workspacePath,
						fileWithContent.content,
						{
							force: true,
						},
					);
				} else if (this.options.conflictResolution === "local" || shouldLocal) {
					// target is local content
					const chunks = computeDiff(fileWithContent.content, localContent);
					if (chunks.length === 0) {
						continue;
					}

					log.debug(
						`handling conflic on file ${file.workspacePath}, overwriting remote copy`,
					);
					this.fileCache.setById(file.id, {
						...file,
						updatedAt: new Date(stat?.mtime ?? "").toISOString(),
						content: localContent,
					});
					const msg: ChunkMessage = {
						type: MessageType.Chunk,
						fileId: fileWithContent.id,
						chunks,
						version: fileWithContent.version,
					};
					this.wsClient.sendMessage(msg);
				} else {
					log.warn(`conflict on file ${file.workspacePath} not solved`);
				}
			}
		}
	}

	async onChunkMessage(data: ChunkMessage) {
		const { fileId, chunks, version } = data;

		const file = this.fileCache.getById(fileId);
		if (file == null) {
			log.error(`file '${fileId}' not found`);
			return;
		}

		if (this.lockedFiles.has(fileId)) {
			log.error(`file ${fileId} already locked!`);
		}
		this.lockedFiles.add(fileId);

		try {
			const deque = this.messageQueueRegistry.getDeque(fileId);
			if (!deque.isEmpty() && isSameChunkMessage(data, deque.peekFront())) {
				// it is an ack
				log.debug(
					`[onChunkMessage] ack message ${file.workspacePath} ${file.id}`,
				);
				file.version = version;
				this.fileCache.setById(file.id, file);
				deque.removeFront();
				return;
			}

			if (!deque.isEmpty()) {
				log.debug(
					`[onChunkMessage] out of sync ${file.workspacePath} ${file.id}`,
				);

				// we are out of sync, we must revert the changes and apply it from server
				while (!deque.isEmpty()) {
					const cm = deque.removeFront();
					for (let i = 0; i < cm.chunks.length; i++) {
						const inverse = invertDiff(cm.chunks[i]);
						await this.storage.persistChunk(file.workspacePath, inverse);
					}
				}
			}

			const chunksToPersist: DiffChunk[] = [];
			if (file.version + 1 !== version) {
				log.debug(
					`[onChunkMessage] missing intermidiate msg ${file.workspacePath} ${file.id}`,
				);
				const operations = await this.apiClient.fetchOperations(
					fileId,
					file.version,
				);

				let currVersion = file.version;
				for (const operation of operations) {
					if (operation.version >= data.version) {
						// TODO: we need all the operation till the current, we need to
						// add another parameter to API
						break;
					}

					if (currVersion + 1 !== operation.version) {
						log.error(
							`missing operation in history for file ${file.workspacePath} ${fileId}`,
						);
						return;
					}

					chunksToPersist.push(...operation.operation);
					currVersion = operation.version;
				}
			}

			chunksToPersist.push(...chunks);
			const content = await this.storage.persistChunks(
				file.workspacePath,
				chunksToPersist,
			);

			file.version = version;
			file.content = content;

			this.fileCache.setById(file.id, file);
		} catch (error) {
			log.error(`Error processing chunk message for file '${fileId}':`, error);
		} finally {
			this.lockedFiles.delete(fileId);
		}
	}

	async onEventMessage(event: EventMessage) {
		// note the maps that keep track of the current files will be updated
		// in the create and delete events, as creating a file will trigger
		// this functions
		if (event.type === MessageType.Create) {
			if (event.objectType === "file") {
				const fileApi = await this.apiClient.fetchFile(event.fileId);
				this.fileCache.create(fileApi);
				this.storage.write(fileApi.workspacePath, fileApi.content);
			} else if (event.objectType === "folder") {
				this.storage.write(event.workspacePath, "", { isDir: true });
			} else {
				log.error("[socket] unknown", event);
			}
		} else if (event.type === MessageType.Delete) {
			if (event.objectType === "file") {
				const file = this.fileCache.getById(event.fileId);
				if (!file) {
					log.warn(
						`[socket] cannot delete file ${event.fileId} as it is not present in current workspace`,
					);
					return;
				}
				this.storage.delete(file.workspacePath, { force: true });
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
				this.storage.delete(event.workspacePath, { force: true });
			} else {
				log.error("[socket] unknown", event);
			}
		} else if (event.type === MessageType.Rename) {
			if (event.objectType === "file") {
				const file = this.fileCache.getById(event.fileId);
				if (!file) {
					log.warn(
						`[socket] cannot rename file ${event.fileId}. Fetching from remote`,
					);

					const fileApi = await this.apiClient.fetchFile(event.fileId);
					this.fileCache.create(fileApi);
					await this.storage.write(fileApi.workspacePath, fileApi.content);

					return;
				}

				const fileApi = await this.apiClient.fetchFile(event.fileId);
				const oldPath = file.workspacePath;
				const newPath = fileApi.workspacePath;
				this.fileCache.setPath(file.id, newPath);

				this.storage.rename(oldPath, newPath);
			} else if (event.objectType === "folder") {
				const workspacePath = event.workspacePath + path.sep;
				const files = await this.storage.listFiles({ prefix: workspacePath });
				if (files.length === 0) {
					log.error("[socket] trying to rename not existing folder");
					return;
				}

				for (const file of files) {
					const fileDesc = this.fileCache.getByPath(file.path);
					if (!fileDesc) {
						continue;
					}

					const fileApi = await this.apiClient.fetchFile(fileDesc.id);
					const oldPath = fileDesc.workspacePath;
					const newPath = fileApi.workspacePath;

					if (oldPath !== newPath) {
						this.fileCache.setPath(fileDesc.id, newPath);
						this.storage.rename(oldPath, fileApi.workspacePath);
					}
				}

				// give time to obsidian to update cache
				for (let i = 0; i < 10; i++) {
					const filesPostRename = await this.storage.listFiles({
						prefix: workspacePath,
					});
					if (filesPostRename.length === 0) {
						this.storage.delete(event.workspacePath);
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

	// FIXME: avoid to trigger again create on ws event
	private async create(file: TAbstractFile) {
		log.debug("[event]: create", file);
		if (this.fileCache.hasByPath(file.path)) {
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
			let currentContent: string | ArrayBuffer;
			if (isText(file.path)) {
				currentContent = await this.storage.readText(file.path);
			} else {
				currentContent = await this.storage.readBinary(file.path);
			}
			const fileApi = await this.apiClient.createFile(
				file.path,
				currentContent,
			);
			this.fileCache.create({ ...fileApi, content: currentContent });

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
		log.debug("[event]: modify", file);
		const currentFile = this.fileCache.getByPath(file.path);
		if (currentFile == null) {
			log.error(`file '${file.path}' not found`);
			return;
		}
		const fileId = currentFile.id;

		if (this.lockedFiles.has(fileId)) {
			// FIXME: with this method if another client continues to write I will never
			// acquire the lock
			return;
		}

		if (
			!isTextFile(currentFile.mimeType) ||
			typeof currentFile.content !== "string"
		) {
			return;
		}

		const newContent = await this.storage.readText(file.path);
		const chunks = computeDiff(currentFile.content, newContent);

		const oldContent = currentFile.content;
		currentFile.content = newContent;
		this.fileCache.setById(fileId, currentFile);

		if (chunks.length > 0) {
			log.debug("modify", { fileId, chunks, oldContent, newContent });

			const msg: ChunkMessage = {
				type: MessageType.Chunk,
				fileId,
				chunks,
				version: currentFile.version,
			};
			this.messageQueueRegistry.getDeque(fileId).addBack(msg);
			this.wsClient.sendMessage(msg);
		}
	}

	// FIXME: avoid to trigger again delete on ws event
	private async delete(file: TAbstractFile) {
		log.debug("[event]: delete", file);

		const deleteFile = async (fileId: number) => {
			try {
				await this.apiClient.deleteFile(fileId);
				this.fileCache.deleteById(fileId);

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

		const fileToDelete = this.fileCache.getByPath(file.path);
		if (fileToDelete === undefined) {
			log.error(`missing file for deletion: "${file.path}", probably a folder`);

			const files = this.fileCache.find((f) =>
				f.workspacePath.startsWith(file.path + path.sep),
			);
			for (const fileToDelete of files) {
				this.fileCache.deleteById(fileToDelete.id);
				await deleteFile(fileToDelete.id);
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

		await deleteFile(fileToDelete.id);
	}

	// FIXME: avoid to trigger again rename on ws event
	private async rename(file: TAbstractFile, oldPath: string) {
		log.debug("[event]: rename", oldPath, file);
		const fileToRename = this.fileCache.getByPath(oldPath);
		if (fileToRename === undefined) {
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
				const fileDesc = this.fileCache.getByPath(folderFile.path);
				if (!fileDesc) {
					continue;
				}

				const oldFilePath = fileDesc.workspacePath;
				// FIXME: to validate, if it is always safe
				const newFilePath = oldFilePath.replace(oldPath, file.path);

				try {
					await this.apiClient.updateFile(fileDesc.id, newFilePath);
				} catch (error) {
					log.error(error);
				}

				this.fileCache.setPath(fileDesc.id, newFilePath);
				this.storage.rename(oldFilePath, newFilePath);
			}

			// give time to obsidian to update cache
			for (let i = 0; i < 10; i++) {
				const filesPostRename = await this.storage.listFiles({
					prefix: oldWorkspacePath,
				});
				if (filesPostRename.length === 0) {
					this.storage.delete(oldPath, { force: true });
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
			await this.apiClient.updateFile(fileToRename.id, file.path);
			this.fileCache.setPath(fileToRename.id, file.path);

			// First we create the file so the other clients can fetch it on event
			const msg: EventMessage = {
				type: MessageType.Rename,
				fileId: fileToRename.id,
				objectType: "file",
				workspacePath: oldPath,
			};
			this.wsClient.sendMessage(msg);
		} catch (error) {
			log.error(error);
			return;
		}
	}

	cacheDump() {
		return this.fileCache.dump();
	}
}

function isSameChunkMessage(
	fromWs: ChunkMessage,
	fromDeque: ChunkMessage,
): boolean {
	if (fromWs.chunks.length !== fromDeque.chunks.length) {
		return false;
	}

	for (let i = 0; i < fromWs.chunks.length; i++) {
		if (!shallowEqualStrict(fromWs.chunks[i], fromDeque.chunks[i])) {
			return false;
		}
	}

	// +1 because this the server acks the message with a +1 version
	const sameVersion = fromWs.version === fromDeque.version + 1;
	const sameType = fromWs.type === fromDeque.type;

	return sameVersion && sameType;
}
