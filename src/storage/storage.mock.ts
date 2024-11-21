import { kMaxLength } from "node:buffer";
import { promises as fs, readdirSync, statSync } from "node:fs";
import path, { basename } from "node:path";
import type { TFolder, Vault, DataWriteOptions, Stat, TFile } from "obsidian";

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
			async stat(normalizedPath): Promise<Stat | null> {
				const vaultPath = fullPath(normalizedPath);

				try {
					await fs.access(vaultPath);
					const stat = await fs.stat(vaultPath);
					return {
						type: stat.isFile() ? "file" : "folder",
						size: stat.size,
						ctime: stat.ctime.getTime(),
						mtime: stat.mtime.getTime(),
					} as Stat;
				} catch {
					return null;
				}
			},
			rename(normalizedPath, normalizedNewPath) {
				fs.rename(normalizedPath, normalizedNewPath);
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
		async process(file, fn, _options) {
			const vaultPath = fullPath(file.path);
			const data = await fs.readFile(vaultPath, "utf8");
			const newData = fn(data);
			await fs.writeFile(vaultPath, newData, { encoding: "utf8" });
			return newData;
		},
		getFiles() {
			const vaultPath = basepath;
			const filenames: TFile[] = [];

			let subGetFiles: (basepath: string, subPath: string) => void = () => {};
			subGetFiles = (basepath: string, subPath: string) => {
				const items = readdirSync(path.join(basepath, subPath));

				for (const item of items) {
					const vaultPath = path.join(subPath, item);
					const itemPath = path.join(basepath, vaultPath);
					const stat = statSync(itemPath);
					if (stat.isDirectory()) {
						subGetFiles(basepath, vaultPath);
					} else {
						filenames.push({
							path: vaultPath,
							vault: v,
							stat: {
								size: stat.size,
								ctime: stat.ctime.getTime(),
								mtime: stat.mtime.getTime(),
							},
							name: path.basename(vaultPath, path.extname(vaultPath)),
							basename: path.basename(vaultPath),
							parent: null,
							extension: path.extname(vaultPath),
						});
					}
				}
			};

			subGetFiles(vaultPath, "");

			return filenames;
		},
		getMarkdownFiles() {
			const filenames: TFile[] = [];

			let subGetFiles: (basepath: string, subPath: string) => void = () => {};
			subGetFiles = (basepath: string, subPath: string) => {
				const items = readdirSync(path.join(basepath, subPath));

				for (const item of items) {
					const vaultPath = path.join(subPath, item);
					const itemPath = path.join(basepath, vaultPath);
					const stat = statSync(itemPath);
					if (stat.isDirectory()) {
						subGetFiles(basepath, vaultPath);
					} else if (vaultPath.endsWith(".md")) {
						filenames.push({
							path: vaultPath,
							vault: v,
							stat: {
								size: stat.size,
								ctime: stat.ctime.getTime(),
								mtime: stat.mtime.getTime(),
							},
							name: path.basename(vaultPath, path.extname(vaultPath)),
							basename: path.basename(vaultPath),
							parent: null,
							extension: path.extname(vaultPath),
						});
					}
				}
			};

			subGetFiles(basepath, "");

			return filenames;
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
			const vaultPath = fullPath(file.path);
			const data = await fs.readFile(vaultPath, "utf8");
			return data;
		},
		async delete(file, force) {
			const vaultPath = fullPath(file.path);
			await fs.rm(vaultPath, { force: force });
		},
	} as Vault;

	return v;
}
