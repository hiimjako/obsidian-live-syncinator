export function isTextMime(contentType: string): boolean {
    return contentType.startsWith("text/");
}
