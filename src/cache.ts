import type { FileWithContent } from "./api/api";

export class FileCache {
	private filepathToId: Map<string, number> = new Map();
	private idToFile: Map<number, FileWithContent> = new Map();

	create(file: FileWithContent) {
		this.filepathToId.set(file.workspacePath, file.id);
		this.idToFile.set(file.id, file);
	}

	getById(id: number): FileWithContent | undefined {
		return this.idToFile.get(id);
	}

	getByPath(filepath: string): FileWithContent | undefined {
		const fileId = this.filepathToId.get(filepath);
		if (fileId === undefined) {
			return undefined;
		}
		return this.idToFile.get(fileId);
	}

	hasById(id: number): boolean {
		return this.idToFile.has(id);
	}

	hasByPath(filepath: string): boolean {
		const fileId = this.filepathToId.get(filepath);
		if (fileId === undefined) {
			return false;
		}
		return this.idToFile.has(fileId);
	}

	setById(id: number, file: FileWithContent) {
		this.idToFile.set(id, file);
	}

	setByPath(filepath: string, file: FileWithContent) {
		const fileId = this.filepathToId.get(filepath);
		if (fileId === undefined) {
			return undefined;
		}
		this.idToFile.set(fileId, file);
	}

	setPath(id: number, newPath: string) {
		const file = this.idToFile.get(id);
		if (file === undefined) {
			return;
		}

		this.filepathToId.delete(file.workspacePath);

		file.workspacePath = newPath;

		this.idToFile.set(id, file);
		this.filepathToId.set(newPath, id);
	}

	setVersion(id: number, version: number) {
		const file = this.idToFile.get(id);
		if (file === undefined) {
			return;
		}

		file.version = version;
		this.idToFile.set(id, file);
	}

	private delete(id: number) {
		const file = this.idToFile.get(id);
		if (file !== undefined) {
			this.filepathToId.delete(file.workspacePath);
		}

		this.idToFile.delete(id);
	}

	deleteById(id: number) {
		this.delete(id);
	}

	deleteByPath(filepath: string) {
		const fileId = this.filepathToId.get(filepath);
		if (fileId !== undefined) {
			this.delete(fileId);
		}
	}

	find(predicate: (value: FileWithContent) => boolean): FileWithContent[] {
		const items: FileWithContent[] = [];

		for (const file of this.idToFile.values()) {
			if (predicate(file)) {
				items.push(file);
			}
		}

		return items;
	}

	dump() {
		const output = [];
		for (const file of this.idToFile.values()) {
			output.push({ ...file });
		}
		return output;
	}
}
