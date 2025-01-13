import { diffChars } from "diff";

export enum Operation {
    Remove = -1,
    Add = 1,
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
                type: Operation.Add,
                len: changeLength,
                text: change.value,
                position,
            });
            position += changeLength;
        } else if (change.removed) {
            diffs.push({
                type: Operation.Remove,
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
        case Operation.Add:
            if (text === "") {
                return diff.text;
            }

            if (diff.position === 0) {
                return diff.text + text;
            }

            return text.slice(0, diff.position) + diff.text + text.slice(diff.position);

        case Operation.Remove:
            if (text === "") {
                return "";
            }

            if (diff.position === 0) {
                return text.slice(diff.len);
            }

            return text.slice(0, diff.position) + text.slice(diff.position + diff.len);

        default:
            throw new Error("Invalid operation type");
    }
}

// it returns the invert of a diff
export function invertDiff(diff: DiffChunk): DiffChunk {
    const inverted: DiffChunk = {
        type: diff.type === Operation.Add ? Operation.Remove : Operation.Add,
        len: diff.len,
        text: diff.text,
        position: diff.position,
    };

    return inverted;
}
