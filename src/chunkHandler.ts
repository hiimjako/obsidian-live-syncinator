import type { File, Operation } from "./api/api";
import type { ChunkMessage } from "./api/ws";
import { applyDiff, type DiffChunk, invertDiff, transform } from "./diff/diff";
import { shallowEqualStrict } from "./utils/comparison";

export function isSameChunkMessage(fromWs: ChunkMessage, fromDeque: ChunkMessage): boolean {
    if (fromWs.chunks.length !== fromDeque.chunks.length) {
        return false;
    }

    for (let i = 0; i < fromWs.chunks.length; i++) {
        if (!shallowEqualStrict(fromWs.chunks[i], fromDeque.chunks[i])) {
            return false;
        }
    }

    // +1 because this the server acks the message with a +1 version
    const sameVersion = fromWs.version === fromDeque.version + 1;
    const sameType = fromWs.type === fromDeque.type;

    return sameVersion && sameType;
}

export function revertOptimisticChunks(messages: ChunkMessage[], initialContent: string): string {
    let content = initialContent;
    for (let i = messages.length - 1; i >= 0; i--) {
        const cm = messages[i];
        const appliedChunks: DiffChunk[] = [];

        for (let j = cm.chunks.length - 1; j >= 0; j--) {
            const chunk = cm.chunks[j];

            let inverse = invertDiff(chunk);

            for (const appliedChunk of appliedChunks) {
                inverse = transform(appliedChunk, inverse);
            }

            content = applyDiff(content, inverse);

            appliedChunks.unshift(inverse);
        }
    }

    return content;
}

export async function getChunksToPersist(
    data: ChunkMessage,
    file: File,
    apiClient: { fetchOperations(fileId: number, fromVersion: number): Promise<Operation[]> },
): Promise<DiffChunk[]> {
    const { fileId, chunks, version } = data;
    const chunksToPersist: DiffChunk[] = [];

    if (file.version + 1 !== version) {
        const operations = await apiClient.fetchOperations(fileId, file.version);

        let currVersion = file.version;
        for (const operation of operations) {
            if (operation.version >= version) {
                break;
            }

            if (currVersion + 1 !== operation.version) {
                throw new Error(
                    `Missing operation in history for file ${file.workspacePath} ${fileId}`,
                );
            }

            chunksToPersist.push(...operation.operation);
            currVersion = operation.version;
        }
    }

    chunksToPersist.push(...chunks);
    return chunksToPersist;
}
