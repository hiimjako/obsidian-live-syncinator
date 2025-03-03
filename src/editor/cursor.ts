import type { Editor, MarkdownView } from "obsidian";
import { log } from "src/logger/logger";
import type { CursorEventMap, EventBus } from "src/utils/eventBus";

export class CursorEnv {
    private cursors = new Map<string, UserCursor>();
    private cursorTimers = new Map<string, number>();
    private inactivityTimeoutMs: number;

    constructor(
        bus: EventBus<CursorEventMap>,
        getActiveEditor: () => MarkdownView | null,
        inactivityTimeoutMs: number,
    ) {
        this.inactivityTimeoutMs = inactivityTimeoutMs;

        bus.on("remote-cursor-update", async (data) => {
            console.log(data);
            const activeEditor = getActiveEditor();
            if (activeEditor === null) {
                log.error("impossible retrive current active editor");
                return;
            }

            if (activeEditor.file?.path !== data.path) {
                this.removeCursor(data.id);
                return;
            }

            if (!this.cursors.has(data.id)) {
                this.cursors.set(data.id, new UserCursor(data.path, data.label, data.color));
            }

            const cursor = this.cursors.get(data.id);

            cursor?.positionAtTextCoordinates(activeEditor.editor, data.line, data.ch);

            // cursor?.updatePosition(data.left, data.bottom);
            this.resetCursorTimer(data.id);
        });

        bus.on("local-cursor-update", async (data) => {
            const keys = this.cursors.keys();
            for (const key of keys) {
                const cursor = this.cursors.get(key);
                if (!cursor || cursor.path === data.path) {
                    continue;
                }
                cursor.destroy();
                this.cursors.delete(key);
            }
        });
    }

    private resetCursorTimer(cursorId: string) {
        if (this.cursorTimers.has(cursorId)) {
            window.clearTimeout(this.cursorTimers.get(cursorId));
        }

        const timerId = window.setTimeout(() => {
            this.removeCursor(cursorId);
        }, this.inactivityTimeoutMs);

        this.cursorTimers.set(cursorId, timerId);
    }

    private removeCursor(cursorId: string) {
        log.debug(`deleting cursor: ${cursorId}`);
        if (this.cursorTimers.has(cursorId)) {
            window.clearTimeout(this.cursorTimers.get(cursorId));
            this.cursorTimers.delete(cursorId);
        }

        const cursor = this.cursors.get(cursorId);
        if (cursor) {
            cursor.destroy();
            this.cursors.delete(cursorId);
        }
    }

    close() {
        for (const timerId of this.cursorTimers.values()) {
            window.clearTimeout(timerId);
        }

        for (const cursor of this.cursors.values()) {
            cursor.destroy();
        }

        this.cursorTimers.clear();
        this.cursors.clear();

        log.debug("CursorEnv closed, all resources cleaned up");
    }
}

export class UserCursor {
    cursorElement: HTMLElement | null = null;
    path: string;
    private editorContainer: HTMLElement | null = null;

    constructor(path: string, label: string, color: `#${string}`) {
        this.path = path;

        this.cursorElement = document.createElement("div");
        this.cursorElement.classList.add("cursor-name-box");
        this.cursorElement.textContent = label;
        this.cursorElement.style.color = color;

        // Find the editor container - this is more reliable than body
        this.editorContainer =
            document.querySelector(".workspace-leaf.mod-active .cm-editor") ||
            document.querySelector(".workspace-leaf.mod-active .CodeMirror");

        if (this.editorContainer && this.cursorElement) {
            this.editorContainer.appendChild(this.cursorElement);
        } else {
            log.error("missing container for cursors");
        }
    }

    positionAtTextCoordinates(editor: Editor, line: number, ch: number): boolean {
        if (!this.cursorElement) return false;

        try {
            // Get the active editor element
            const editorElement =
                document.querySelector(".workspace-leaf.mod-active .cm-editor") ||
                document.querySelector(".workspace-leaf.mod-active .CodeMirror");

            // Safety check - can't position without an editor
            if (!editorElement) return false;

            // In newer Obsidian, we need to use different API methods
            // Instead of directly using coordsAtPos, use the editor's posAtCoords method first

            // Get the editor's view
            // @ts-ignore - Use internal Obsidian APIs
            const view = editor.cm;
            if (!view) {
                console.error("Cannot access CodeMirror instance");
                return false;
            }

            // Get document position for the cursor
            // Instead of trying to convert coordinates, let's use a different approach
            // Manually position the cursor by getting the actual DOM elements

            // Find the line element in the DOM
            const lineElements = editorElement.querySelectorAll(".cm-line");
            if (line >= lineElements.length) {
                console.error("Line out of range");
                return false;
            }

            const lineElement = lineElements[line];
            if (!lineElement) {
                console.error("Could not find line element");
                return false;
            }

            // Get the line element's position
            const lineRect = lineElement.getBoundingClientRect();
            const editorRect = editorElement.getBoundingClientRect();

            // Position at the beginning of the requested line (safer approach)
            const relativeLeft = lineRect.left - editorRect.left + ch * 8; // Approximate char width
            const relativeTop = lineRect.top - editorRect.top + lineRect.height;

            // Position the element
            this.cursorElement.style.position = "absolute";
            this.cursorElement.style.left = `${relativeLeft}px`;
            this.cursorElement.style.top = `${relativeTop}px`;

            // Make sure cursor is in the right container
            // const cmContent = editorElement.querySelector(".cm-content") || editorElement;
            // if (this.cursorElement.parentElement !== cmContent) {
            //     if (this.cursorElement.parentElement) {
            //         this.cursorElement.parentElement.removeChild(this.cursorElement);
            //     }
            //     cmContent.appendChild(this.cursorElement);
            // }
            //
            return true;
        } catch (error) {
            console.error("Failed to position cursor:", error);
            return false;
        }
    }

    destroy() {
        if (this.cursorElement?.parentNode) {
            this.cursorElement.parentNode.removeChild(this.cursorElement);
            this.cursorElement = null;
        }
    }
}
