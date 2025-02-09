import assert from "node:assert";
import { afterEach, beforeEach, describe, test } from "node:test";
import getPort from "get-port";
import WebSocket from "ws";
import { Operation } from "../diff/diff";
import { sleep } from "../utils/sleep";
import { MessageType, WsClient } from "./ws";
import type { ChunkMessage } from "./ws";

describe("WsClient with real WebSocket server", () => {
    let server: WebSocket.Server;
    let wsClient: WsClient;
    let port: number;

    beforeEach(async () => {
        port = await getPort();
        server = new WebSocket.Server({ port });
        wsClient = new WsClient("ws", `127.0.0.1:${port}`, {
            maxReconnectAttempts: 0,
        });

        wsClient.connect();
    });

    afterEach(async () => {
        wsClient.close(true);
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    test("should connect to the WebSocket server", (_, done) => {
        server.on("connection", (ws) => {
            assert.ok(ws);
            done();
        });
    });

    test("should send a message to the WebSocket server", async () => {
        const message: ChunkMessage = {
            fileId: 123,
            type: MessageType.Chunk,
            chunks: [{ type: Operation.Add, position: 0, len: 0, text: "" }],
            version: 1,
        };

        const p = new Promise<void>((resolve) => {
            server.on("connection", (ws) => {
                ws.on("message", (data) => {
                    const receivedData = JSON.parse(data.toString());
                    assert.deepStrictEqual(receivedData, message);
                    resolve();
                });
            });
        });

        wsClient.sendMessage(message);
        await Promise.race([p, sleep(2_000)]);
    });

    test("should receive a message from the WebSocket server", async () => {
        const message: ChunkMessage = {
            fileId: 123,
            type: MessageType.Chunk,
            chunks: [],
            version: 1,
        };

        server.on("connection", (ws) => {
            ws.send(JSON.stringify(message));
        });

        const p = new Promise<void>((resolve) => {
            wsClient.onChunkMessage(async (msg: ChunkMessage) => {
                assert.deepStrictEqual(msg, message);
                resolve();
            });
        });

        await Promise.race([p, sleep(2_000)]);
    });

    test("should handle server error", async () => {
        server.on("connection", () => {});
        server.close();

        const p = new Promise<void>((resolve) => {
            wsClient.onError((err) => {
                assert.ok(err);
                resolve();
            });
        });

        await Promise.race([p, sleep(2_000)]);
    });
});

describe("message retry tests", () => {
    let server: WebSocket.Server;
    let wsClient: WsClient;
    let port: number;

    beforeEach(async () => {
        port = await getPort();
        server = new WebSocket.Server({ port });
        wsClient = new WsClient("ws", `127.0.0.1:${port}`, {
            maxReconnectAttempts: 2,
            maxRetryAttempts: 3,
            retryIntervalMs: 100,
            reconnectIntervalMs: 1000,
        });

        await new Promise<void>((resolve) => {
            server.once("connection", async () => {});
            wsClient.onOpen(() => resolve());
            wsClient.connect();
        });
    });

    afterEach(async () => {
        wsClient.close(true);
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    test("should queue message when disconnected and retry after reconnection", async () => {
        const receivedMessages: ChunkMessage[] = [];
        const message: ChunkMessage = {
            fileId: 456,
            type: MessageType.Chunk,
            chunks: [{ type: Operation.Add, position: 0, len: 0, text: "test" }],
            version: 1,
        };

        const p = new Promise<void>((resolve) => {
            server.once("connection", (ws) => {
                ws.on("message", (data) => {
                    const receivedData = JSON.parse(data.toString());
                    receivedMessages.push(receivedData);
                    resolve();
                });
            });
        });

        for (const client of server.clients) {
            client.close();
        }
        await sleep(500);

        // sending a message after disconnection
        wsClient.sendMessage(message);

        const queueStatus = wsClient.getRetryQueueStatus();
        assert.equal(queueStatus.queueLength, 1);

        await Promise.race([p, sleep(2_000)]);

        assert.equal(receivedMessages.length, 1);
        assert.deepStrictEqual(receivedMessages[0], message);
    });

    test("should maintain message order during retries", async () => {
        const receivedMessages: ChunkMessage[] = [];
        const messages: ChunkMessage[] = [
            {
                fileId: 1,
                type: MessageType.Chunk,
                chunks: [{ type: Operation.Add, position: 0, len: 0, text: "1" }],
                version: 1,
            },
            {
                fileId: 2,
                type: MessageType.Chunk,
                chunks: [{ type: Operation.Add, position: 0, len: 0, text: "2" }],
                version: 1,
            },
        ];

        const p = new Promise<void>((resolve) => {
            server.once("connection", (ws) => {
                ws.on("message", (data) => {
                    const receivedData = JSON.parse(data.toString());
                    receivedMessages.push(receivedData);
                    resolve();
                });
            });
        });

        for (const client of server.clients) {
            client.close();
        }
        await sleep(500);

        // sending a message after disconnection
        for (const message of messages) {
            wsClient.sendMessage(message);
        }
        const queueStatus = wsClient.getRetryQueueStatus();
        assert.equal(queueStatus.queueLength, 2);

        await Promise.race([p, sleep(2_000)]);

        assert.equal(receivedMessages.length, 2);
        assert.deepStrictEqual(receivedMessages, messages);
    });
});
