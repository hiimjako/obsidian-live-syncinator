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
}

type Options = {
    maxReconnectAttempts?: number;
    reconnectIntervalMs?: number;
};

export class WsClient {
    private ws: WebSocket | null = null;
    private domain = "";
    private scheme: "ws" | "wss" = "ws";
    private jwtToken = "";
    private isConnected = false;
    private reconnectAttempts = 0;
    private ignoreReconnections = false;
    private options: Options = {
        maxReconnectAttempts: -1,
        reconnectIntervalMs: 1000,
    };
    private onOpenHandler?: () => void;
    private onCloseHandler?: () => void;
    private onErrorHandler?: (e: globalThis.Event) => void;
    private onChunkMessageHandler: (_: ChunkMessage) => Promise<void> =
        async () => {};
    private onEventMessageHandler: (_: EventMessage) => Promise<void> =
        async () => {};

    private chunkMessageQueue = new AsyncMessageQueue<ChunkMessage>(
        async (message) => {
            await this.onChunkMessageHandler(message);
        },
    );
    private eventMessageQueue = new AsyncMessageQueue<EventMessage>(
        async (msg) => {
            await this.onEventMessageHandler(msg);
        },
    );

    constructor(scheme: "ws" | "wss", domain: string, options: Options = {}) {
        this.options = { ...this.options, ...options };
        this.scheme = scheme;
        this.domain = domain;
    }

    private url() {
        return `${this.scheme}://${this.domain}/v1/sync${this.jwtToken ? `?jwt=${this.jwtToken}` : ""}`;
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
        this.jwtToken = token;
    }

    connect() {
        if (this.ws) {
            log.warn("WebSocket connection already exists.");
            return;
        }

        this.ws = new WebSocket(this.url());

        this.ws.onopen = () => {
            this.isConnected = true;
            this.reconnectAttempts = 0;
            if (this.onOpenHandler) this.onOpenHandler();
            log.info("WebSocket connected");
        };

        this.ws.onclose = (event) => {
            this.isConnected = false;
            this.ws = null;
            if (!event.wasClean) {
                log.error("WebSocket closed unexpectedly");
            }
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

        this.ws.onmessage = (event: MessageEvent<string>) => {
            try {
                const msg: ChunkMessage | EventMessage = JSON.parse(event.data);

                log.debug("[ws] received message", msg);
                switch (msg.type) {
                    case MessageType.Chunk:
                        this.chunkMessageQueue.enqueue(msg as ChunkMessage);
                        break;
                    case MessageType.Create:
                    case MessageType.Delete:
                    case MessageType.Rename:
                        this.eventMessageQueue.enqueue(msg as EventMessage);
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
        if (this.ws !== null && this.isConnected === false) {
            log.warn("already connected");
        }
        const mra = this.options?.maxReconnectAttempts ?? -1;
        const attemptsAllowed = this.reconnectAttempts < mra || mra === -1;

        if (attemptsAllowed && !this.ignoreReconnections) {
            setTimeout(() => {
                if (this.ignoreReconnections) {
                    return;
                }
                log.info("Reconnecting WebSocket...");
                this.reconnectAttempts++;
                this.connect();
            }, this.options.reconnectIntervalMs);
        } else {
            log.error("WebSocket max reconnect attempts reached.");
        }
    }

    close(stopReconnect = false) {
        this.isConnected = false;
        if (stopReconnect && this.ignoreReconnections === false) {
            this.ignoreReconnections = stopReconnect;
        }
        if (this.ws) {
            this.ws.close(1000);
            this.ws = null;
        }
    }

    sendMessage(msg: ChunkMessage | EventMessage) {
        if (!this.isConnected) {
            log.warn("WebSocket is not connected. Unable to send data.");
            return;
        }
        log.debug("[ws] sending message", msg);

        const msgJson = JSON.stringify(msg);
        this.ws?.send(msgJson);
    }
}

type QueueItem<T> = {
    data: T;
    timestamp: number;
};

class AsyncMessageQueue<T> {
    private queue: QueueItem<T>[] = [];
    private isProcessing = false;

    constructor(private readonly processor: (data: T) => Promise<void>) {}

    enqueue(data: T): void {
        const queueItem: QueueItem<T> = {
            data,
            timestamp: Date.now(),
        };

        this.queue.push(queueItem);

        if (!this.isProcessing) {
            this.processQueue();
        }
    }

    size(): number {
        return this.queue.length;
    }

    clear(): void {
        this.queue = [];
    }

    private async processQueue(): Promise<void> {
        if (this.queue.length === 0) {
            this.isProcessing = false;
            return;
        }

        this.isProcessing = true;

        try {
            const item = this.queue[0];
            await this.processor(item.data);
        } catch (error) {
            log.error("Error processing queue item:", error);
        }
        this.queue.shift();
        await this.processQueue();
    }
}
