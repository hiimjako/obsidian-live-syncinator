import WebSocket from "ws";

enum Operation {
	DiffRemove = -1,
	DiffAdd = 1,
}

type DiffChunk = {
	Type: Operation;
	Position: number;
	Text: string;
	Len: number;
};

type DiffChunkMessage = {
	fileId: string;
	chunks: DiffChunk[];
};

interface WsEvents {
	onMessage: (_: DiffChunkMessage) => void;
	onError: (_: Error) => void;
}

export class WsClient {
	private ws: WebSocket;

	constructor(domain: string, events: WsEvents) {
		this.ws = new WebSocket(`ws://${domain}/v1/sync`);

		this.ws.on("error", events.onError);

		this.ws.on("message", function message(data) {
			console.log("received: %s", data);
			const msg = JSON.parse(data.toString());
			events.onMessage(msg);
		});
	}

	sendMessage(msg: DiffChunkMessage) {
		const msgJson = JSON.stringify(msg);
		this.ws.send(msgJson);
	}

	close() {
		this.ws.close(1000);
	}
}
