import type { DiffChunk } from "./diff";

export type DiffChunkMessage = {
	fileId: number;
	chunks: DiffChunk[];
};

interface WsEvents {
	onMessage: (_: DiffChunkMessage) => Promise<void>;
	onError: (_: Event) => Promise<void>;
}

export class WsClient {
	private ws: WebSocket;

	constructor(domain: string, events: WsEvents) {
		this.ws = new WebSocket(`ws://${domain}/v1/sync`);

		this.ws.addEventListener("error", events.onError);

		this.ws.addEventListener("close", (event) => {
			if (!event.wasClean) {
				events.onError(new Event("WebSocket closed unexpectedly"));
			}
		});

		this.ws.addEventListener(
			"message",
			async function message(event: MessageEvent<DiffChunkMessage>) {
				try {
					const msg = JSON.parse(event.data.toString());
					await events.onMessage(msg);
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
