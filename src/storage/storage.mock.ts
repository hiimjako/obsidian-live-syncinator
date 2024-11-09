import { promises as fs } from "node:fs";
import path from "node:path";
import type { TFolder, Vault, DataWriteOptions } from "obsidian";

export function CreateVaultMock(basepath: string): Vault {
	const fullPath = (p: string): string => {
		return path.join(basepath, p);
	};

	const v = {
		adapter: {
			async exists(
				normalizedPath: string,
				_sensitive?: boolean,
			): Promise<boolean> {
				const vaultPath = fullPath(normalizedPath);

				try {
					await fs.access(vaultPath);
					return true;
				} catch {
					return false;
				}
			},
			async write(
				normalizedPath: string,
				data: string,
				_options?: DataWriteOptions,
			): Promise<void> {
				const vaultPath = fullPath(normalizedPath);
				await fs.writeFile(vaultPath, data, { encoding: "utf8" });
			},
		},
		async createFolder(normalizedPath): Promise<TFolder> {
			const vaultPath = fullPath(normalizedPath);
			await fs.mkdir(vaultPath, { recursive: true });
			return {
				children: [],
				vault: v,
				parent: null,
				isRoot() {
					return normalizedPath === basepath;
				},
				name: path.basename(normalizedPath),
				path: normalizedPath,
			};
		},
		getFileByPath(normalizedPath) {
			return {
				vault: v,
				name: path.basename(normalizedPath, path.extname(normalizedPath)),
				extension: path.extname(normalizedPath),
				path: normalizedPath,
				parent: null,
				basename: path.basename(normalizedPath),
				stat: {
					size: 1,
					ctime: new Date().getTime(),
					mtime: new Date().getTime(),
				},
			};
		},
		getFolderByPath(normalizedPath) {
			return {
				vault: v,
				isRoot() {
					return normalizedPath === basepath;
				},
				name: path.basename(normalizedPath),
				path: normalizedPath,
				parent: null,
			};
		},
		async cachedRead(file) {
			const path = fullPath(file.path);
			const data = await fs.readFile(path, "utf8");
			return data;
		},
		async delete(file, force) {
			const vaultPath = fullPath(file.path);
			await fs.rm(vaultPath, { force: force });
		},
	} as Vault;

	return v;
}
