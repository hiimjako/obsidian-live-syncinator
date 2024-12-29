import { log } from "src/logger/logger";

export function assert(contidion: boolean, msg: string) {
	if (!contidion) {
		log.error(`Assertion failed ${msg}`);
	}
}
