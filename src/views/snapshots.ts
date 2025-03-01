import { ItemView } from "obsidian";
import type { IconName, TFile, WorkspaceLeaf } from "obsidian";
import type { EventBus, Snapshot, SnapshotEventMap } from "../utils/eventBus";

export const VIEW_TYPE_SNAPSHOT = "syncinator-snapshot-view";

export class SnapshotView extends ItemView {
    private currentFilePath = "No file open";
    private unsubscribers: Array<() => void> = [];
    private eventBus: EventBus<SnapshotEventMap>;

    constructor(leaf: WorkspaceLeaf, eventBus: EventBus<SnapshotEventMap>) {
        super(leaf);

        this.eventBus = eventBus;

        this.registerEvent(
            this.app.workspace.on("file-open", (file: TFile) => {
                if (file) {
                    this.currentFilePath = file.path;
                    this.eventBus.emit("file-focus-change", { path: file.path });
                } else {
                    this.currentFilePath = "No file open";
                    this.noFileView();
                }
            }),
        );

        this.unsubscribers.push(
            this.eventBus.on("snapshots-list-updated", async (data) => {
                this.updateView(data);
            }),
        );
    }

    getIcon(): IconName {
        return "history";
    }

    getViewType() {
        return VIEW_TYPE_SNAPSHOT;
    }

    getDisplayText() {
        return "Snapshots";
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.createEl("h4", { text: "Snapshots" });

        // Create a div to hold the file path
        const filePathEl = container.createEl("div", { cls: "snapshot-file-path" });
        filePathEl.createEl("h6", { text: `Current file: ${this.currentFilePath}` });
    }

    updateView(snapshots: Snapshot[]) {
        const container = this.containerEl.children[1];
        const filePathEl = container.querySelector(".snapshot-file-path");
        if (filePathEl) {
            filePathEl.empty();
            filePathEl.createEl("h6", { text: `Current file: ${this.currentFilePath}` });

            if (snapshots.length > 0) {
                const eventBus = this.eventBus;
                const listEl = filePathEl.createEl("ul");
                for (const snapshot of snapshots) {
                    const data = new Date(snapshot.createdAt);
                    const el = listEl.createEl("li", {
                        text: `Version: ${snapshot.version} Created: ${data.toLocaleDateString()} ${data.toLocaleTimeString()}`,
                        attr: {
                            ...snapshot,
                        },
                    });
                    el.onClickEvent(function () {
                        const fileId = +(this.getAttr("fileId") ?? -1);
                        const version = +(this.getAttr("version") ?? -1);
                        const createdAt = new Date(this.getAttr("createdAt") ?? "").toISOString();

                        eventBus.emit("snapshot-selected", {
                            fileId,
                            version,
                            createdAt,
                        });
                    });
                }
            } else {
                filePathEl.createEl("p", { text: "No available snapshots" });
            }
        }
    }

    noFileView() {
        const container = this.containerEl.children[1];
        const filePathEl = container.querySelector(".snapshot-file-path");
        if (filePathEl) {
            filePathEl.empty();
        }
    }

    async onClose() {
        this.app.workspace.offref(this.app.workspace.on("file-open", () => {}));
        for (const unsubscribe of this.unsubscribers) {
            unsubscribe();
        }
    }
}
