import { StateEffect, StateField } from "@codemirror/state";

export interface CursorState {
    id: string;
    path: string;
    label: string;
    color: string;
    line: number;
    ch: number;
    lastUpdate: number;
}

export const updateCursorEffect = StateEffect.define<CursorState>();
export const removeCursorEffect = StateEffect.define<string>();
export const clearStaleEffect = StateEffect.define<number>();

export const remoteCursorField = StateField.define<Map<string, CursorState>>({
    create() {
        return new Map();
    },
    update(cursors, tr) {
        let changed = false;
        let next = cursors;

        for (const effect of tr.effects) {
            if (effect.is(updateCursorEffect)) {
                if (!changed) {
                    next = new Map(cursors);
                    changed = true;
                }
                next.set(effect.value.id, effect.value);
            } else if (effect.is(removeCursorEffect)) {
                if (cursors.has(effect.value)) {
                    if (!changed) {
                        next = new Map(cursors);
                        changed = true;
                    }
                    next.delete(effect.value);
                }
            } else if (effect.is(clearStaleEffect)) {
                const threshold = effect.value;
                for (const [id, cursor] of cursors) {
                    if (cursor.lastUpdate < threshold) {
                        if (!changed) {
                            next = new Map(cursors);
                            changed = true;
                        }
                        next.delete(id);
                    }
                }
            }
        }

        return next;
    },
});
