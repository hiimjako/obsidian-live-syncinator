import { describe, test, afterEach, beforeEach } from "node:test";
import assert from "node:assert";
import WebSocket from "ws";
import { MessageType, WsClient } from "./ws";
import getPort from "get-port";
import type { ChunkMessage } from "./ws";
import { Operation } from "../diff";

describe("WsClient with real WebSocket server", () => {
    let server: WebSocket.Server;
    let wsClient: WsClient;
    let lastMessage: ChunkMessage | null;
    let lastError: Event | null;

    beforeEach(async () => {
        const port = await getPort();
        server = new WebSocket.Server({ port });
        lastMessage = null;
        lastError = null;
        wsClient = new WsClient("ws", `127.0.0.1:${port}`, {
            maxReconnectAttempts: 0,
        });

        wsClient.onError((err: Event) => {
            lastError = err;
        });

        wsClient.onChunkMessage(async (msg: ChunkMessage) => {
            lastMessage = msg;
        });

        wsClient.connect();
    });

    afterEach(() => {
        wsClient.close();
        server.close();
    });

    test("should connect to the WebSocket server", (_, done) => {
        server.on("connection", (ws) => {
            assert.ok(ws);
            done();
        });
    });

    test("should send a message to the WebSocket server", (_, done) => {
        const message: ChunkMessage = {
            fileId: 123,
            type: MessageType.Chunk,
            chunks: [{ type: Operation.Add, position: 0, len: 0, text: "" }],
        };

        server.on("connection", (ws) => {
            ws.on("message", (data) => {
                const receivedData = JSON.parse(data.toString());
                assert.deepStrictEqual(receivedData, message);
                done();
            });
        });

        setTimeout(() => {
            wsClient.sendMessage(message);
        }, 50);
    });

    test("should receive a message from the WebSocket server", (_, done) => {
        const message: ChunkMessage = {
            fileId: 123,
            type: MessageType.Chunk,
            chunks: [],
        };

        server.on("connection", (ws) => {
            ws.send(JSON.stringify(message));
        });

        setTimeout(() => {
            assert.deepStrictEqual(lastMessage, message);
            done();
        }, 50);
    });

    test("should handle server error", (_, done) => {
        server.on("connection", () => {});
        server.close();

        setTimeout(() => {
            assert.ok(lastError);
            done();
        }, 50);
    });
});
