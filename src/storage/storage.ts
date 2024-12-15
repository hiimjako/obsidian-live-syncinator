import path from "path-browserify";
import { Operation, type DiffChunk } from "../diff";

import type { TAbstractFile, TFile, Vault, Stat } from "obsidian";
import { assert } from "src/utils/assert";

export type WriteOptions = {
	force?: boolean;
	isDir?: boolean;
};

export class Disk {
	private vault: Vault;

	constructor(vault: Vault) {
		this.vault = vault;
	}

	async stat(vaultPath: string): Promise<Stat | null> {
		return this.vault.adapter.stat(vaultPath);
	}

	async exists(vaultPath: string): Promise<boolean> {
		return this.vault.adapter.exists(vaultPath, true);
	}

	async rename(oldVaultPath: string, newVaultPath: string): Promise<void> {
		const dirs = this.getIncrementalDirectories(newVaultPath);
		for (const dir of dirs) {
			const exists = await this.exists(dir);
			if (!exists) {
				await this.vault.createFolder(dir);
			}
		}

		return this.vault.adapter.rename(oldVaultPath, newVaultPath);
	}

	// writeObject creates and writes to file. If the files doesn't exists it will
	// throw an error. Use `force: true` to overwrite the file.
	async writeObject(
		vaultPath: string,
		content: string,
		opts: WriteOptions = { force: false, isDir: false },
	): Promise<void> {
		const { force, isDir } = opts;

		const exists = await this.exists(vaultPath);
		if (exists && !force) {
			throw new Error(`${isDir ? "Folder" : "File"} already exists`);
		}

		const dirs = this.getIncrementalDirectories(vaultPath);
		for (const dir of dirs) {
			const exists = await this.exists(dir);
			if (!exists) {
				await this.vault.createFolder(dir);
			}
		}

		if (isDir) {
			await this.vault.createFolder(vaultPath);
		} else {
			await this.vault.adapter.write(vaultPath, content);
		}
	}

	async deleteObject(
		vaultPath: string,
		{ force } = { force: false },
	): Promise<void> {
		const file = this.vault.getFileByPath(vaultPath);
		const folder = this.vault.getFolderByPath(vaultPath);

		const toDelete: TAbstractFile | null = file ?? folder;
		if (toDelete == null) {
			return;
		}

		await this.vault.delete(toDelete, force);
	}

	async listFiles({
		prefix = "",
		markdownOnly = false,
	} = {}): Promise<TFile[]> {
		let files: TFile[] = [];
		if (markdownOnly) {
			files = this.vault.getMarkdownFiles();
		} else {
			files = this.vault.getFiles();
		}

		if (prefix) {
			files = files.filter((file) => file.path.startsWith(prefix));
		}

		return files;
	}

	async readObject(vaultPath: string): Promise<string> {
		const file = this.vault.getFileByPath(vaultPath);

		if (file == null) {
			throw new Error(`file '${vaultPath}' doesn't exists`);
		}

		const v = await this.vault.cachedRead(file);
		return v;
	}

	async persistChunks(vaultPath: string, chunks: DiffChunk[]): Promise<string> {
		assert(chunks !== null, `chunks for '${vaultPath}' are null`);

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
			throw new Error(`file '${vaultPath}' doesn't exists`);
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
			throw new Error(`file '${vaultPath}' doesn't exists`);
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

		if (filePath.endsWith(path.sep)) {
			directories.push(filePath);
		}

		return directories;
	}
}
