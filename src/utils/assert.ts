export function assert(contidion: boolean, msg: string) {
	if (!contidion) {
		console.error(`Assertion failed ${msg}`);
	}
}
