export type ArrayBufferToBase64 = (buffer: ArrayBuffer) => string;
export type Base64ToArrayBuffer = (base64: string) => ArrayBuffer;

let arrayBufferToBase64: ArrayBufferToBase64;
let base64ToArrayBuffer: Base64ToArrayBuffer;

try {
	const obsidian = require("obsidian");

	// Ensure the functions exist in the external library
	if (
		typeof obsidian.arrayBufferToBase64 === "function" &&
		typeof obsidian.base64ToArrayBuffer === "function"
	) {
		arrayBufferToBase64 = obsidian.arrayBufferToBase64;
		base64ToArrayBuffer = obsidian.base64ToArrayBuffer;
	} else {
		throw new Error("Functions not found in external library");
	}
} catch (error) {
	// Polyfill implementation
	arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
		const binary = String.fromCharCode(...new Uint8Array(buffer));
		return Buffer.from(binary, "binary").toString("base64");
	};

	base64ToArrayBuffer = (base64: string): ArrayBuffer => {
		const binary = Buffer.from(base64, "base64").toString("binary");
		const arrayBuffer = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			arrayBuffer[i] = binary.charCodeAt(i);
		}
		return arrayBuffer.buffer;
	};
}

export { arrayBufferToBase64, base64ToArrayBuffer };
