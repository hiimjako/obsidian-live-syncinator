import path from "path-browserify";
import { Operation, type DiffChunk } from "../diff";

import type { TAbstractFile, TFile, Vault } from "obsidian";
import { assert } from "src/utils/assert";

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

	async listFiles(markdownOnly = false): Promise<TFile[]> {
		if (markdownOnly) {
			return this.vault.getMarkdownFiles();
		}
		return this.vault.getFiles();
	}

	async readObject(vaultPath: string): Promise<string> {
		const file = this.vault.getFileByPath(vaultPath);

		if (file == null) {
			throw new Error("File doesn't exists");
		}

		const v = await this.vault.cachedRead(file);
		return v;
	}

	async persistChunks(vaultPath: string, chunks: DiffChunk[]): Promise<string> {
		assert(chunks !== null, `chunks for ${vaultPath} are null`);

		let content = "";

		for (const chunk of chunks) {
			content = await this.persistChunk(vaultPath, chunk);
		}

		return content;
	}

	async persistChunk(vaultPath: string, chunk: DiffChunk): Promise<string> {
		switch (chunk.type) {
			case Operation.DiffAdd:
				return await this.addBytesToFile(vaultPath, chunk.position, chunk.text);
			case Operation.DiffRemove:
				return await this.removeBytesFromFile(
					vaultPath,
					chunk.position,
					chunk.len,
				);
			default:
				throw new Error(`Diff type ${chunk.type} not supported`);
		}
	}

	private async addBytesToFile(
		vaultPath: string,
		start: number,
		str: string,
	): Promise<string> {
		const file = this.vault.getFileByPath(vaultPath);
		if (file == null) {
			throw new Error("File doesn't exists");
		}

		return await this.vault.process(file, (data) => {
			return data.slice(0, start) + str + data.slice(start);
		});
	}

	private async removeBytesFromFile(
		vaultPath: string,
		start: number,
		length: number,
	): Promise<string> {
		const file = this.vault.getFileByPath(vaultPath);
		if (file == null) {
			throw new Error("File doesn't exists");
		}

		return await this.vault.process(file, (data) => {
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
