import { describe, test, afterEach, beforeEach } from "node:test";
import assert from "node:assert";
import WebSocket from "ws";
import { WsClient } from "./ws";
import getPort from "get-port";
import type { DiffChunkMessage } from "./ws";
import { Operation } from "./diff";

describe("WsClient with real WebSocket server", () => {
	let server: WebSocket.Server;
	let wsClient: WsClient;
	let lastMessage: DiffChunkMessage | null;
	let lastError: Event | null;

	beforeEach(async () => {
		const port = await getPort();
		server = new WebSocket.Server({ port });
		lastMessage = null;
		lastError = null;
		wsClient = new WsClient(`127.0.0.1:${port}`);
		wsClient.registerOnMessage(async (msg: DiffChunkMessage) => {
			lastMessage = msg;
		});
		wsClient.registerOnError(async (err: Event) => {
			lastError = err;
		});
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
		const message: DiffChunkMessage = {
			fileId: 123,
			chunks: [{ type: Operation.DiffAdd, position: 0, len: 0, text: "" }],
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
		const message: DiffChunkMessage = {
			fileId: 123,
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
		server.on("connection", () => { });
		server.close();

		setTimeout(() => {
			assert.ok(lastError);
			done();
		}, 50);
	});
});
