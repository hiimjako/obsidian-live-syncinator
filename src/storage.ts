import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Operation, type DiffChunk } from "./diff";
import type { Vault } from "obsidian";

export class Disk {
	private vault: Vault;

	constructor(vault: Vault) {
		this.vault = vault;
	}

	async exists(vaultPath: string): Promise<boolean> {
		return this.vault.adapter.exists(vaultPath, true);
	}

	async createObject(vaultPath: string, content: string): Promise<void> {
		if (await this.exists(vaultPath)) {
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

	// async deleteObject(relativePath: string): Promise<void> {
	// 	const diskPath = path.join(this.basepath, relativePath);
	//
	// 	try {
	// 		await fs.stat(diskPath);
	// 	} catch (err: unknown) {
	// 		if (
	// 			err instanceof Error &&
	// 			(err as NodeJS.ErrnoException).code !== "ENOENT"
	// 		) {
	// 			throw err;
	// 		}
	// 	}
	//
	// 	await fs.unlink(diskPath);
	// }
	//
	// async readObject(relativePath: string): Promise<Buffer> {
	// 	const diskPath = path.join(this.basepath, relativePath);
	// 	return fs.readFile(diskPath);
	// }

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
