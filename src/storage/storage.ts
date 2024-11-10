import * as path from "node:path";
import { Operation, type DiffChunk } from "../diff";

import type { TAbstractFile, Vault } from "obsidian";

export class Disk {
	private vault: Vault;

	constructor(vault: Vault) {
		vault.createFolder;
		this.vault = vault;
	}

	async exists(vaultPath: string): Promise<boolean> {
		return this.vault.adapter.exists(vaultPath, true);
	}

	async createObject(vaultPath: string, content: string): Promise<void> {
		const exists = await this.exists(vaultPath);
		if (exists) {
			throw new Error("File already exists");
		}

		const dirs = this.getIncrementalDirectories(vaultPath);
		for (const dir of dirs) {
			const exists = await this.exists(dir);
			if (!exists) {
				await this.vault.createFolder(dir);
			}
		}

		await this.vault.adapter.write(vaultPath, content);
	}

	async deleteObject(vaultPath: string): Promise<void> {
		const file = this.vault.getFileByPath(vaultPath);
		const folder = this.vault.getFolderByPath(vaultPath);

		const toDelete: TAbstractFile | null = file ?? folder;
		if (toDelete == null) {
			throw new Error("File already exists");
		}

		await this.vault.delete(toDelete, true);
	}

	async readObject(vaultPath: string): Promise<string> {
		const file = this.vault.getFileByPath(vaultPath);
		if (file == null) {
			throw new Error("File doesn't exists");
		}
		const v = await this.vault.cachedRead(file);
		return v;
	}

	async persistChunks(vaultPath: string, chunks: DiffChunk[]): Promise<void> {
		for (const chunk of chunks) {
			await this.persistChunk(vaultPath, chunk);
		}
	}

	async persistChunk(vaultPath: string, chunk: DiffChunk): Promise<void> {
		switch (chunk.type) {
			case Operation.DiffAdd:
				await this.addBytesToFile(vaultPath, chunk.position, chunk.text);
				break;
			case Operation.DiffRemove:
				await this.removeBytesFromFile(vaultPath, chunk.position, chunk.len);
				break;
			default:
				throw new Error(`Diff type ${chunk.type} not supported`);
		}
	}

	private async addBytesToFile(
		vaultPath: string,
		start: number,
		str: string,
	): Promise<void> {
		const file = this.vault.getFileByPath(vaultPath);
		if (file == null) {
			throw new Error("File doesn't exists");
		}

		await this.vault.process(file, (data) => {
			return data.slice(0, start) + str + data.slice(start);
		});
	}

	private async removeBytesFromFile(
		vaultPath: string,
		start: number,
		length: number,
	): Promise<void> {
		const file = this.vault.getFileByPath(vaultPath);
		if (file == null) {
			throw new Error("File doesn't exists");
		}

		await this.vault.process(file, (data) => {
			return data.slice(0, start) + data.slice(length + start);
		});
	}

	getIncrementalDirectories(filePath: string) {
		let currentPath = filePath;

		const directories = [];
		while (currentPath !== path.dirname(currentPath)) {
			directories.unshift(currentPath + path.sep);
			currentPath = path.dirname(currentPath);
		}

		directories.pop();

		return directories;
	}
}
