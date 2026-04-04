import { isText } from "../storage/filetype";

export function isTextMime(contentType: string): boolean {
    return contentType.startsWith("text/");
}

export function isTextFile(file: { mimeType: string; workspacePath: string }): boolean {
    return isTextMime(file.mimeType) || isText(file.workspacePath);
}
