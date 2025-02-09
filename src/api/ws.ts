import { log } from "src/logger/logger";
import { sleep } from "../utils/sleep";
import type { DiffChunk } from "../diff/diff";

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
    maxRetryAttempts?: number;
    retryIntervalMs?: number;
};

type RetryQueueItem = {
    message: ChunkMessage | EventMessage;
    attempts: number;
    timestamp: number;
};

export class WsClient {
    private ws: WebSocket | null = null;
    private domain = "";
    private scheme: "ws" | "wss" = "ws";
    private jwtToken = "";
    private isConnected = false;
    private reconnectAttempts = 1;
    private ignoreReconnections = false;
    private options: Options = {
        maxReconnectAttempts: -1,
        reconnectIntervalMs: 250,
    };
    private retryQueue: RetryQueueItem[] = [];
    private onOpenHandler?: () => void;
    private onCloseHandler?: () => void;
    private onErrorHandler?: (e: globalThis.Event) => void;
    private onChunkMessageHandler: (_: ChunkMessage) => Promise<void> = async () => {};
    private onEventMessageHandler: (_: EventMessage) => Promise<void> = async () => {};

    private chunkMessageQueue = new AsyncMessageQueue<ChunkMessage>(async (message) => {
        await this.onChunkMessageHandler(message);
    });
    private eventMessageQueue = new AsyncMessageQueue<EventMessage>(async (msg) => {
        await this.onEventMessageHandler(msg);
    });

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
            this.reconnectAttempts = 1;
            if (this.onOpenHandler) this.onOpenHandler();
            log.info("WebSocket connected");
            this.retryQueuedMessages();
        };

        this.ws.onclose = async (event) => {
            this.isConnected = false;
            this.ws = null;
            if (!event.wasClean) {
                log.error("WebSocket closed unexpectedly");
            }
            if (this.onCloseHandler) this.onCloseHandler();
            await this.reconnect();
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

    async reconnect() {
        if (this.ws !== null && this.isConnected === true) {
            log.warn("already connected");
            return;
        }

        if (this.ignoreReconnections) return;

        const mra = this.options.maxReconnectAttempts ?? -1;
        const rMs = this.options.reconnectIntervalMs ?? 250;
        const attemptsAllowed = this.reconnectAttempts < mra || mra === -1;

        if (attemptsAllowed) {
            const backoffMs = Math.min(rMs * this.reconnectAttempts, 5_000);
            log.info(
                `Reconnecting WebSocket in ${backoffMs}ms, attempt: ${this.reconnectAttempts}`,
            );
            await sleep(backoffMs);
            this.reconnectAttempts++;
            this.connect();
        } else {
            log.error("WebSocket max reconnect attempts reached.");
        }
    }

    private async retryQueuedMessages() {
        if (this.retryQueue.length === 0) return;

        log.info(`Retrying ${this.retryQueue.length} queued messages`);

        const currentQueue = [...this.retryQueue];
        this.retryQueue = [];

        for (const item of currentQueue) {
            try {
                if (item.attempts < (this.options.maxRetryAttempts ?? 3)) {
                    await this.sendMessageWithRetry(item.message, item.attempts);
                } else {
                    log.error(
                        `Message dropped after ${item.attempts} retry attempts:`,
                        item.message,
                    );
                }
            } catch (error) {
                log.error("Error retrying message:", error);
            }
        }
    }

    close(stopReconnect = false) {
        this.isConnected = false;
        if (stopReconnect) {
            this.ignoreReconnections = stopReconnect;
        }
        if (this.ws) {
            this.ws.close(1000);
            this.ws = null;
        }
    }

    private async sendMessageWithRetry(
        msg: ChunkMessage | EventMessage,
        previousAttempts = 0,
    ): Promise<void> {
        if (!this.isConnected) {
            const queueItem: RetryQueueItem = {
                message: msg,
                attempts: previousAttempts + 1,
                timestamp: Date.now(),
            };

            this.retryQueue.push(queueItem);
            log.warn(
                `WebSocket is not connected. Message queued for retry. Attempt ${queueItem.attempts}`,
            );
            return;
        }

        try {
            const msgJson = JSON.stringify(msg);
            this.ws?.send(msgJson);
            log.debug("[ws] message sent successfully:", msg);
        } catch (error) {
            log.error("Error sending message:", error);
            throw error;
        }
    }

    getRetryQueueStatus() {
        return {
            queueLength: this.retryQueue.length,
            oldestMessage: this.retryQueue[0]?.timestamp,
            messagesByType: this.retryQueue.reduce(
                (acc, item) => {
                    const type = MessageType[item.message.type];
                    acc[type] = (acc[type] || 0) + 1;
                    return acc;
                },
                {} as Record<string, number>,
            ),
        };
    }

    sendMessage(msg: ChunkMessage | EventMessage) {
        this.sendMessageWithRetry(msg, 0).catch((error) => {
            log.error("Failed to send or queue message:", error);
        });
    }

    clearRetryQueue() {
        const clearedCount = this.retryQueue.length;
        this.retryQueue = [];
        log.info(`Cleared ${clearedCount} messages from retry queue`);
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
