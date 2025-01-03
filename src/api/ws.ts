import { log } from "src/logger/logger";
import type { DiffChunk } from "../diff";

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
	version: number;
}

export interface EventMessage extends MessageHeader {
	workspacePath: string;
	objectType: "file" | "folder";
	fetchFromRemote?: boolean;
}

type Options = {
	maxReconnectAttempts?: number;
	reconnectIntervalMs?: number;
};

export class WsClient {
	private ws: WebSocket;
	private domain = ""
	private scheme: "ws" | "wss" = "ws"
	private jwtToken: string;
	private isConnected = false;
	private reconnectAttempts = 0;
	private options: Options = {
		maxReconnectAttempts: -1,
		reconnectIntervalMs: 1000,
	};
	private onOpenHandler?: () => void;
	private onCloseHandler?: () => void;
	private onErrorHandler?: (e: globalThis.Event) => void;
	private onChunkMessageHandler?: (_: ChunkMessage) => Promise<void>;
	private onEventMessageHandler?: (_: EventMessage) => Promise<void>;

	constructor(scheme: "ws" | "wss", domain: string, options: Options = {}) {
		this.options = { ...this.options, ...options };
		this.scheme = scheme
		this.domain = domain
	}

	private url() {
		if (this.jwtToken !== "") {
			return `${this.scheme}://${this.domain}/v1/sync?jwt=${this.jwtToken}`;
		}
		return `${this.scheme}://${this.domain}/v1/sync`;
	}

	onOpen(handler: () => void) {
		this.onOpenHandler = handler;
	}

	onClose(handler: () => void) {
		this.onCloseHandler = handler;
	}

	onError(handler: (e: globalThis.Event) => void) {
		this.onErrorHandler = handler;
	}

	onChunkMessage(handler: (_: ChunkMessage) => Promise<void>) {
		this.onChunkMessageHandler = handler;
	}

	onEventMessage(handler: (_: EventMessage) => Promise<void>) {
		this.onEventMessageHandler = handler;
	}

	setAuthorization(token: string) {
		this.jwtToken = token
	}

	connect() {
		this.ws = new WebSocket(this.url());

		this.ws.onopen = () => {
			this.isConnected = true;
			this.reconnectAttempts = 0;
			if (this.onOpenHandler) this.onOpenHandler();
			log.info("WebSocket connected")
		};

		this.ws.onclose = (event) => {
			if (!event.wasClean) {
				log.error("WebSocket closed unexpectedly");
			}
			this.isConnected = false;
			if (this.onCloseHandler) this.onCloseHandler();
			this.reconnect();
		};

		this.ws.onerror = (error) => {
			log.error("WebSocket error:", error);
			if (this.onErrorHandler) this.onErrorHandler(error);
			if (this.isConnected) {
				this.close();
			}
		};

		this.ws.onmessage = async (event: MessageEvent<string>) => {
			try {
				const msg: ChunkMessage | EventMessage = JSON.parse(
					event.data.toString(),
				);

				switch (msg.type) {
					case MessageType.Chunk:
						if (this.onChunkMessageHandler) {
							await this.onChunkMessageHandler(msg as ChunkMessage);
						}
						break;
					case MessageType.Create:
					case MessageType.Delete:
					case MessageType.Rename:
						if (this.onEventMessageHandler) {
							await this.onEventMessageHandler(msg as EventMessage);
						}
						break;
					default:
						log.error("message type:", msg.type, "not supported");
				}
			} catch (err) {
				log.error(err);
			}
		};
	}

	reconnect() {
		const mra = this.options?.maxReconnectAttempts ?? -1;
		const attempts = this.reconnectAttempts < mra || mra === -1;

		if (attempts) {
			setTimeout(() => {
				log.info("Reconnecting ws...");
				this.reconnectAttempts++;
				this.connect();
			}, this.options.reconnectIntervalMs);
		} else {
			log.error("WebSocket max reconnect attempts reached.");
		}
	}

	close() {
		this.isConnected = false
		this.ws.close(1000);
	}

	sendMessage(msg: ChunkMessage | EventMessage) {
		if (!this.isConnected) {
			log.warn("WebSocket is not connected. Unable to send data.");
			return;
		}

		const msgJson = JSON.stringify(msg);
		this.ws.send(msgJson);
	}
}
