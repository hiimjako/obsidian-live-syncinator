import type { ChunkMessage } from "./api/ws";
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
