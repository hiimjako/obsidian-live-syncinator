import type { MarkdownView } from "obsidian";
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

        bus.on("remote-curosr-update", async (data) => {
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
            cursor?.updatePosition(data.left, data.bottom);
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

    constructor(path: string, label: string, color: `#${string}`) {
        this.path = path;

        this.cursorElement = document.createElement("div");
        this.cursorElement.classList.add("cursor-name-box");
        this.cursorElement.textContent = label;
        this.cursorElement.style.color = color;

        document.body.appendChild(this.cursorElement);
    }

    updatePosition(left: number, top: number) {
        if (this.cursorElement) {
            this.cursorElement.style.left = `${left}px`;
            this.cursorElement.style.top = `${top}px`;
        }
    }

    destroy() {
        if (this.cursorElement?.parentNode) {
            this.cursorElement.parentNode.removeChild(this.cursorElement);
            this.cursorElement = null;
        }
    }
}
