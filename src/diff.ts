import { diffChars } from "diff";

export enum Operation {
	DiffRemove = -1,
	DiffAdd = 1,
}

export type DiffChunk = {
	type: Operation;
	position: number;
	text: string;
	len: number;
};

export function computeDiff(oldStr: string, newStr: string): DiffChunk[] {
	const charDifferences = diffChars(oldStr, newStr);
	const diffs: DiffChunk[] = [];
	let position = 0;

	for (const change of charDifferences) {
		const changeLength = change.value.length;

		if (change.added) {
			diffs.push({
				type: Operation.DiffAdd,
				len: changeLength,
				text: change.value,
				position,
			});
			position += changeLength;
		} else if (change.removed) {
			diffs.push({
				type: Operation.DiffRemove,
				len: changeLength,
				text: change.value,
				position,
			});
		} else {
			position += changeLength;
		}
	}

	return diffs;
}

export function applyDiff(text: string, diff: DiffChunk): string {
	switch (diff.type) {
		case Operation.DiffAdd:
			if (text === "") {
				return diff.text;
			}

			if (diff.position === 0) {
				return diff.text + text;
			}

			return (
				text.slice(0, diff.position) + diff.text + text.slice(diff.position)
			);

		case Operation.DiffRemove:
			if (text === "") {
				return "";
			}

			if (diff.position === 0) {
				return text.slice(diff.len);
			}

			return (
				text.slice(0, diff.position) + text.slice(diff.position + diff.len)
			);

		default:
			throw new Error("Invalid operation type");
	}
}
