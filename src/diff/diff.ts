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

export function applyDiffs(text: string, diffs: DiffChunk[]): string {
    let updatedText = text;
    for (let i = 0; i < diffs.length; i++) {
        updatedText = applyDiff(updatedText, diffs[i]);
    }
    return updatedText;
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

export function transform(lastOp: DiffChunk, opToTransform: DiffChunk): DiffChunk {
    const transformed: DiffChunk = { ...opToTransform };

    switch (lastOp.type) {
        case Operation.Add:
            switch (opToTransform.type) {
                case Operation.Add:
                    if (lastOp.position <= opToTransform.position) {
                        transformed.position += lastOp.len;
                    }
                    break;
                case Operation.Remove:
                    if (lastOp.position <= opToTransform.position) {
                        transformed.position += lastOp.len;
                    }
                    break;
            }
            break;
        case Operation.Remove:
            switch (opToTransform.type) {
                case Operation.Add:
                    if (lastOp.position < opToTransform.position) {
                        transformed.position -= Math.min(
                            lastOp.len,
                            opToTransform.position - lastOp.position,
                        );
                    }
                    break;
                case Operation.Remove:
                    if (
                        lastOp.position < opToTransform.position + opToTransform.len &&
                        lastOp.position + lastOp.len > opToTransform.position
                    ) {
                        const startOverlap = Math.max(lastOp.position, opToTransform.position);
                        const endOverlap = Math.min(
                            lastOp.position + lastOp.len,
                            opToTransform.position + opToTransform.len,
                        );
                        const overlapStartInOpToTransform = startOverlap - opToTransform.position;
                        const overlapEndInOpToTransform = endOverlap - opToTransform.position;

                        // Use Array.from to properly handle Unicode characters
                        const opToTransformChars = Array.from(opToTransform.text);
                        const opToTransformTextParts = [
                            ...opToTransformChars.slice(0, overlapStartInOpToTransform),
                            ...opToTransformChars.slice(overlapEndInOpToTransform),
                        ];

                        transformed.position = Math.min(opToTransform.position, lastOp.position);
                        transformed.len -= endOverlap - startOverlap;
                        transformed.text = opToTransformTextParts.join("");
                    } else if (lastOp.position <= opToTransform.position) {
                        transformed.position -= lastOp.len;
                    }
                    break;
            }
            break;
    }

    return transformed;
}

export function transformMultiple(opList1: DiffChunk[], opList2: DiffChunk[]): DiffChunk[] {
    const transformedOps: DiffChunk[] = [...opList2];

    for (let i = 0; i < opList1.length; i++) {
        for (let j = 0; j < transformedOps.length; j++) {
            transformedOps[j] = transform(opList1[i], transformedOps[j]);
        }
    }

    return transformedOps;
}
