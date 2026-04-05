import { type Extension, RangeSetBuilder } from "@codemirror/state";
import {
    Decoration,
    type DecorationSet,
    type EditorView,
    ViewPlugin,
    type ViewUpdate,
    WidgetType,
} from "@codemirror/view";
import { editorInfoField } from "obsidian";
import { log } from "src/logger/logger";
import type { CursorEventMap, EventBus } from "src/utils/eventBus";
import {
    clearStaleEffect,
    remoteCursorField,
    removeCursorEffect,
    updateCursorEffect,
} from "./cursorState";

export {
    type CursorState,
    clearStaleEffect,
    remoteCursorField,
    removeCursorEffect,
    updateCursorEffect,
} from "./cursorState";

class RemoteCursorWidget extends WidgetType {
    constructor(
        readonly label: string,
        readonly color: string,
    ) {
        super();
    }

    toDOM(): HTMLElement {
        const el = document.createElement("span");
        el.className = "cursor-name-box";
        el.setAttribute("contenteditable", "false");
        el.textContent = this.label;
        el.style.color = this.color;
        return el;
    }

    eq(other: RemoteCursorWidget): boolean {
        return this.label === other.label && this.color === other.color;
    }

    get estimatedHeight(): number {
        return -1;
    }

    ignoreEvent(): boolean {
        return true;
    }
}

function buildDecorations(view: EditorView): DecorationSet {
    const cursors = view.state.field(remoteCursorField);
    const widgets: { pos: number; widget: RemoteCursorWidget }[] = [];

    for (const cursor of cursors.values()) {
        const doc = view.state.doc;
        if (cursor.line + 1 > doc.lines) continue;

        const docLine = doc.line(cursor.line + 1);
        const clampedCh = Math.min(cursor.ch, docLine.length);
        const pos = docLine.from + clampedCh;

        if (pos > doc.length) continue;

        widgets.push({ pos, widget: new RemoteCursorWidget(cursor.label, cursor.color) });
    }

    widgets.sort((a, b) => a.pos - b.pos);

    const builder = new RangeSetBuilder<Decoration>();
    for (const { pos, widget } of widgets) {
        builder.add(pos, pos, Decoration.widget({ widget, side: 1 }));
    }
    return builder.finish();
}

// Active EditorViews tracked by the ViewPlugin, keyed by file path.
// CursorEnv dispatches effects to these views without needing editor.cm.
const activeViews = new Map<EditorView, string>();

function getViewForPath(path: string): EditorView | undefined {
    for (const [view, viewPath] of activeViews) {
        if (viewPath === path) return view;
    }
    return undefined;
}

const remoteCursorPlugin = ViewPlugin.fromClass(
    class {
        decorations: DecorationSet;

        constructor(readonly view: EditorView) {
            this.decorations = buildDecorations(view);
            this.trackView();
        }

        update(update: ViewUpdate) {
            this.trackView();

            if (
                update.docChanged ||
                update.transactions.some((tr) =>
                    tr.effects.some(
                        (e) =>
                            e.is(updateCursorEffect) ||
                            e.is(removeCursorEffect) ||
                            e.is(clearStaleEffect),
                    ),
                )
            ) {
                this.decorations = buildDecorations(update.view);
            }
        }

        destroy() {
            activeViews.delete(this.view);
        }

        private trackView() {
            const info = this.view.state.field(editorInfoField);
            const path = info?.file?.path ?? "";
            activeViews.set(this.view, path);
        }
    },
    { decorations: (v) => v.decorations },
);

export const remoteCursorExtension: Extension = [remoteCursorField, remoteCursorPlugin];

export class CursorEnv {
    private inactivityTimer: number | undefined;

    constructor(bus: EventBus<CursorEventMap>, inactivityTimeoutMs: number) {
        bus.on("remote-cursor-update", async (data) => {
            const view = getViewForPath(data.path);
            if (!view) return;

            view.dispatch({
                effects: updateCursorEffect.of({
                    ...data,
                    lastUpdate: Date.now(),
                }),
            });
            this.resetInactivityTimer(inactivityTimeoutMs);
        });

        bus.on("local-cursor-update", async (data) => {
            // Remove cursors that belong to files other than the current one
            for (const [view] of activeViews) {
                const cursors = view.state.field(remoteCursorField);
                for (const [id, cursor] of cursors) {
                    if (cursor.path !== data.path) {
                        view.dispatch({ effects: removeCursorEffect.of(id) });
                    }
                }
            }
        });
    }

    private resetInactivityTimer(timeoutMs: number) {
        if (this.inactivityTimer !== undefined) {
            window.clearTimeout(this.inactivityTimer);
        }

        this.inactivityTimer = window.setTimeout(() => {
            const threshold = Date.now() - timeoutMs;
            for (const [view] of activeViews) {
                view.dispatch({ effects: clearStaleEffect.of(threshold) });
            }
        }, timeoutMs);
    }

    close() {
        if (this.inactivityTimer !== undefined) {
            window.clearTimeout(this.inactivityTimer);
        }

        for (const [view] of activeViews) {
            const cursors = view.state.field(remoteCursorField);
            for (const id of cursors.keys()) {
                view.dispatch({ effects: removeCursorEffect.of(id) });
            }
        }
        activeViews.clear();

        log.debug("CursorEnv closed");
    }
}
