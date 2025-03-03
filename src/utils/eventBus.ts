import type { TAbstractFile } from "obsidian";

export class EventBus<EventTypes extends Record<string, unknown>> {
    private events: {
        [E in keyof EventTypes]?: Array<(data: EventTypes[E]) => Promise<void>>;
    } = {};

    on<E extends keyof EventTypes>(event: E, callback: (data: EventTypes[E]) => Promise<void>) {
        if (!this.events[event]) {
            this.events[event] = [];
        }

        this.events[event].push(callback);

        // Return an unsubscribe function
        return () => {
            if (this.events[event]) {
                this.events[event] = this.events[event].filter((cb) => cb !== callback);
            }
        };
    }

    async emit<E extends keyof EventTypes>(event: E, data: EventTypes[E]) {
        if (!this.events[event]) {
            return;
        }

        await Promise.all(this.events[event].map((callback) => callback(data)));
    }
}

export interface Snapshot {
    fileId: number;
    version: number;
    createdAt: string;
}

export type SnapshotEventMap = {
    "file-focus-change": { path: string };
    "snapshots-list-updated": Snapshot[];
    "snapshot-selected": Snapshot;
};

export type ObsidianEventMap = {
    create: { file: TAbstractFile };
    modify: { file: TAbstractFile };
    delete: { file: TAbstractFile };
    rename: { file: TAbstractFile; oldPath: string };
};

export interface CursorPosition {
    path: string;
    label: string;
    color: `#${string}`;
    line: number;
    ch: number;
}

export interface CursorPositionWithId extends CursorPosition {
    id: string;
}

export type CursorEventMap = {
    "remote-cursor-update": CursorPositionWithId;
    "local-cursor-update": CursorPosition;
};
