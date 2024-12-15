import type { DiffChunk } from "./diff";

export enum MessageType {
	Chunk = 0,
	Create = 1,
	Delete = 2,
	Rename = 3,
}

export interface MessageHeader {
	fileId: number;
	type: MessageType;
}

export interface ChunkMessage extends MessageHeader {
	chunks: DiffChunk[];
}

export interface EventMessage extends MessageHeader {
	workspacePath: string;
	objectType: "file" | "folder";
	fetchFromRemote?: boolean;
}

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

	registerOnMessage(
		chunkMessage: (_: ChunkMessage) => Promise<void>,
		eventMessage: (_: EventMessage) => Promise<void>,
	) {
		this.ws.addEventListener(
			"message",
			async function message(event: MessageEvent<string>) {
				try {
					const msg: ChunkMessage | EventMessage = JSON.parse(
						event.data.toString(),
					);

					switch (msg.type) {
						case MessageType.Chunk:
							await chunkMessage(msg as ChunkMessage);
							break;
						case MessageType.Create:
						case MessageType.Delete:
						case MessageType.Rename:
							await eventMessage(msg as EventMessage);
							break;
						default:
							console.log("message type:", msg.type, "not supported");
					}
				} catch (err) {
					console.error(err);
				}
			},
		);
	}

	sendMessage(msg: ChunkMessage | EventMessage) {
		const msgJson = JSON.stringify(msg);
		this.ws.send(msgJson);
	}

	close() {
		this.ws.close(1000);
	}
}
