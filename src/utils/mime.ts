export function isTextFile(contentType: string): boolean {
	return contentType.startsWith("text/");
}
