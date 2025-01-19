import { type Change, diffWords } from "diff";
import { type App, Modal, Setting } from "obsidian";

type Side = "local" | "remote" | "both";

interface DiffBlock {
    id: number;
    value: string;
    added?: boolean;
    removed?: boolean;
    selected?: boolean;
    side?: Side;
}

export interface FileDiff {
    lastUpdate: Date;
    content: string;
}

export class DiffModal extends Modal {
    private local: FileDiff;
    private remote: FileDiff;
    private filename: string;
    private mergedContent = "";
    private diffs: DiffBlock[] = [];
    private mergedContentEl: HTMLElement | null = null;
    private spans: Record<number, HTMLSpanElement> = {};
    private resolvePromise: ((value: string) => void) | null = null;

    constructor(app: App, filename: string, local: FileDiff, remote: FileDiff) {
        super(app);
        this.filename = filename;
        this.local = local;
        this.remote = remote;
    }

    onOpen() {
        const { contentEl } = this;

        if (contentEl.parentElement === null) {
            this.close();
            return;
        }
        this.calculateDiffs();
        // one diff means no changes
        if (this.diffs.length === 1) {
            this.close();
            return;
        }

        // setting modal size
        contentEl.parentElement.style.height = "90vh";
        contentEl.parentElement.style.width = "90vw";

        contentEl.createEl("h1", {
            cls: "filename-container",
            text: `Merge conflict: ${this.filename}`,
        });
        const container = contentEl.createDiv({ cls: "diff-container" });

        const localColumn = container.createDiv({ cls: "diff-column" });
        const mergedColumn = container.createDiv({ cls: "diff-column" });
        const remoteColumn = container.createDiv({ cls: "diff-column" });

        this.createSideHeader(localColumn, "local");
        this.createMergeHeader(mergedColumn, "Merged Result");
        this.createSideHeader(remoteColumn, "remote");

        this.updateMergedContent();

        this.createDiffContent(localColumn, "local");
        this.createMergedContent(mergedColumn);
        this.createDiffContent(remoteColumn, "remote");

        const saveButtonContainer = contentEl.createDiv({ cls: "save-button-container" });
        new Setting(saveButtonContainer).addButton((btn) =>
            btn
                .setButtonText("Save Merged Version")
                .setCta()
                .onClick(() => this.saveMergedContent()),
        );
    }

    private createSideHeader(container: HTMLElement, side: Side) {
        const header = container.createDiv({ cls: "diff-header" });
        const titleDiv = header.createDiv({ cls: "diff-header-title" });

        const title = side === "local" ? "Local version" : "Remote version";
        const time = side === "local" ? this.local.lastUpdate : this.remote.lastUpdate;
        const subtitle = `Last update: ${formatDate(time)}`;

        titleDiv.createEl("h3", { text: title });
        const button = titleDiv.createEl("button", { text: "Select All" });
        button.onclick = () => this.selectAllChanges(side);
        header.createEl("small", { text: subtitle });
    }

    private createMergeHeader(container: HTMLElement, title: string) {
        const header = container.createDiv({ cls: "diff-header" });
        const titleDiv = header.createDiv({ cls: "diff-header-title" });
        titleDiv.createEl("h3", { text: title });
    }

    private updateSpanColor(diffId: number) {
        const span = this.spans[diffId];
        const diff = this.diffs[diffId];
        if (span && diff) {
            span.style.backgroundColor = diff.selected
                ? "var(--background-modifier-success)"
                : "var(--background-modifier-error)";
        }
    }

    private toggleSelection(diffId: number) {
        const diff = this.diffs[diffId];
        if (diff) {
            diff.selected = !diff.selected;
            this.updateSpanColor(diffId);
            this.updateMergedContent();
        }
    }

    private calculateDiffs() {
        const differences = diffWords(this.local.content, this.remote.content);

        const side = (diff: Change): Side => {
            if (!diff.added && !diff.removed) {
                return "both";
            }
            if (!diff.added && diff.removed) {
                return "local";
            }
            if (diff.added && !diff.removed) {
                return "remote";
            }

            throw new Error("unreachable");
        };

        for (let i = 0; i < differences.length; i++) {
            const diff = differences[i];
            const customDiff = {
                ...diff,
                id: i,
                selected: !diff.added && !diff.removed,
                side: side(diff),
            };
            this.diffs.push(customDiff);

            if (customDiff.side !== "both") {
                const span = createSpan();
                span.setText(diff.value);
                span.style.cursor = "pointer";
                span.dataset.index = `${i}`;

                this.spans[i] = span;
                this.updateSpanColor(i);
                span.onclick = () => this.toggleSelection(i);
            }
        }
    }

    private createDiffContent(container: HTMLElement, side: Side) {
        const scrollContainer = container.createDiv({ cls: "scroll-container" });
        scrollContainer.style.overflow = "auto";
        scrollContainer.style.flex = "1";

        const content = scrollContainer.createDiv({ cls: "diff-content" });
        content.style.whiteSpace = "pre-wrap";

        for (let i = 0; i < this.diffs.length; i++) {
            let spanToAppend: HTMLSpanElement;
            if (this.diffs[i].side === "both") {
                const span = createSpan();
                span.setText(this.diffs[i].value);
                spanToAppend = span;
            } else if (this.diffs[i].side === side) {
                spanToAppend = this.spans[i];
            } else {
                continue;
            }
            content.append(spanToAppend);
        }
    }

    private createMergedContent(container: HTMLElement) {
        const scrollContainer = container.createDiv({ cls: "scroll-container" });
        scrollContainer.style.overflow = "auto";
        scrollContainer.style.flex = "1";

        this.mergedContentEl = scrollContainer.createDiv({ cls: "merged-content" });
        this.mergedContentEl.style.whiteSpace = "pre-wrap";
        this.updateMergedContent();
    }

    private updateMergedContent() {
        if (!this.mergedContentEl) return;

        this.mergedContent = "";
        for (const diff of this.diffs) {
            if (diff.selected) {
                this.mergedContent += diff.value;
            }
        }

        this.mergedContentEl.setText(this.mergedContent);
    }

    private selectAllChanges(sideToSelect: Side) {
        for (let i = 0; i < this.diffs.length; i++) {
            const { side, id, selected } = this.diffs[i];
            if (side === sideToSelect && selected === false) {
                this.toggleSelection(id);
            }
        }
    }

    private saveMergedContent() {
        this.close();
    }

    onClose() {
        const { contentEl } = this;
        contentEl.empty();
        if (this.resolvePromise) {
            this.updateMergedContent();
            this.resolvePromise(this.mergedContent);
        }
    }

    open(): Promise<string> {
        return new Promise((resolve) => {
            this.resolvePromise = resolve;
            super.open();
        });
    }
}

function formatDate(date: Date): string {
    return date
        .toLocaleString("en-GB", {
            day: "2-digit",
            month: "2-digit",
            year: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
        })
        .replace(",", "");
}
