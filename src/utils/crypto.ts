export async function generateSHA256Hash(input: string | ArrayBuffer): Promise<string> {
    const data =
        typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);

    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
