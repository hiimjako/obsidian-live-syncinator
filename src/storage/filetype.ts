import path from "path-browserify";
import textExtensions from "textextensions";
import binaryExtensions from "binaryextensions";

export function isText(filename: string): boolean {
    const parts = path.basename(filename).split(".").reverse();

    for (const extension of parts) {
        if (textExtensions.indexOf(extension) !== -1) {
            return true;
        }
        if (binaryExtensions.indexOf(extension) !== -1) {
            return false;
        }
    }

    // TODO: it should detect the type from the content as fallback
    return false;
}
