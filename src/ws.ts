import type { DiffChunk } from "./diff";

export type DiffChunkMessage = {
	fileId: number;
	chunks: DiffChunk[];
};

export class WsClient {
	private ws: WebSocket;

	constructor(domain: string) {
		this.ws = new WebSocket(`ws://${domain}/v1/sync`);
	}

	registerOnClose(fn: (_: CloseEvent) => Promise<void>) {
		this.ws.addEventListener("close", fn);
	}

	registerOnError(fn: (_: Event) => Promise<void>) {
		this.ws.addEventListener("error", fn);
	}

	registerOnMessage(fn: (_: DiffChunkMessage) => Promise<void>) {
		this.ws.addEventListener(
			"message",
			async function message(event: MessageEvent<DiffChunkMessage>) {
				try {
					const msg = JSON.parse(event.data.toString());
					await fn(msg);
				} catch (err) {
					console.error(err);
				}
			},
		);
	}

	sendMessage(msg: DiffChunkMessage) {
		const msgJson = JSON.stringify(msg);
		this.ws.send(msgJson);
	}

	close() {
		this.ws.close(1000);
	}
}
