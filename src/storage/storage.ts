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

	// async persistChunk(relativePath: string, chunk: DiffChunk): Promise<void> {
	// 	const diskPath = path.join(this.basepath, relativePath);

	// try {
	// 	await fs.stat(diskPath);
	// } catch (error) {
	// 	console.log(error);
	// }
	//
	// 	switch (chunk.type) {
	// 		case Operation.DiffAdd:
	// 			await this.addBytesToFile(diskPath, chunk.position, chunk.text);
	// 			break;
	// 		case Operation.DiffRemove:
	// 			await this.removeBytesFromFile(diskPath, chunk.position, chunk.len);
	// 			break;
	// 		default:
	// 			throw new Error(`Diff type ${chunk.type} not supported`);
	// 	}
	// }
	//
	// private async addBytesToFile(
	// 	filePath: string,
	// 	start: number,
	// 	str: string,
	// ): Promise<void> {
	// 	const file = await fs.open(filePath, "r+");
	// 	try {
	// 		const { buffer: remainder } = await file.read({
	// 			buffer: Buffer.alloc(1024), // Adjust buffer size as needed
	// 			position: start,
	// 			length: (await file.stat()).size - start,
	// 		});
	//
	// 		await file.write(Buffer.from(str), 0, str.length, start);
	//
	// 		await file.write(remainder, 0, remainder.length, start + str.length);
	// 	} finally {
	// 		await file.close();
	// 	}
	// }
	//
	// private async removeBytesFromFile(
	// 	filePath: string,
	// 	start: number,
	// 	length: number,
	// ): Promise<void> {
	// 	const file = await fs.open(filePath, "r+");
	// 	try {
	// 		const readPosition = start + length;
	// 		const fileSize = (await file.stat()).size;
	//
	// 		const { buffer: remainingData } = await file.read({
	// 			buffer: Buffer.alloc(fileSize - readPosition),
	// 			position: readPosition,
	// 		});
	//
	// 		await file.write(remainingData, 0, remainingData.length, start);
	//
	// 		await file.truncate(start + remainingData.length);
	// 	} finally {
	// 		await file.close();
	// 	}
	// }
	//
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
