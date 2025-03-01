import { type Editor, MarkdownView, Notice, Plugin } from "obsidian";
import { log } from "src/logger/logger";
import { DiffModal, type FileDiff } from "src/modals/conflict";
import { Syncinator as SyncinatorPlugin } from "src/plugin";
import { Disk } from "src/storage/storage";
import {
    EventBus,
    type CursorEventMap,
    type ObsidianEventMap,
    type SnapshotEventMap,
} from "src/utils/eventBus";
import { SnapshotView, VIEW_TYPE_SNAPSHOT } from "src/views/snapshots";
import { ApiClient } from "./src/api/api";
import { HttpClient } from "./src/api/http";
import { WsClient } from "./src/api/ws";
import { DEFAULT_SETTINGS, type PluginSettings, SettingTab } from "./src/settings";
import { CursorEnv } from "src/editor/cursor";

export default class Syncinator extends Plugin {
    settings: PluginSettings = DEFAULT_SETTINGS;
    private wsClient: WsClient;
    private storage: Disk;
    private apiClient: ApiClient;
    snapshotEventBus = new EventBus<SnapshotEventMap>();
    obsidianEventBus = new EventBus<ObsidianEventMap>();
    cursorEventBus = new EventBus<CursorEventMap>();
    private cursorEnv = new CursorEnv(
        this.cursorEventBus,
        () => this.app.workspace.getActiveViewOfType(MarkdownView),
        1_000,
    );

    async registerSyncinator() {
        const plugin = new SyncinatorPlugin(
            this.storage,
            this.apiClient,
            this.wsClient,
            {
                diffModal: this.wrappedDiffModal.bind(this),
                snapshotEventBus: this.snapshotEventBus,
                obsidianEventBus: this.obsidianEventBus,
            },
            {
                conflictResolution: this.settings.conflictResolution,
            },
        );

        await plugin.init();

        this.registerEvent(
            this.app.vault.on("create", (file) => {
                this.obsidianEventBus.emit("create", { file });
            }),
        );
        this.registerEvent(
            this.app.vault.on("modify", (file) => {
                this.obsidianEventBus.emit("modify", { file });
            }),
        );

        this.registerEvent(
            this.app.vault.on("delete", (file) => {
                this.obsidianEventBus.emit("delete", { file });
            }),
        );

        this.registerEvent(
            this.app.vault.on("rename", (file, oldPath) => {
                this.obsidianEventBus.emit("rename", { file, oldPath });
            }),
        );
    }

    registerCursors() {
        this.registerEvent(
            this.app.workspace.on("editor-change", (editor: Editor) => {
                const cursor = editor.getCursor();

                //@ts-ignore
                const cursorCoords = editor.coordsAtPos(cursor);
                if (!cursorCoords) {
                    log.error("impossible to get cursor cords");
                    return;
                }
                const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                const path = activeView?.file?.path ?? "";

                if (path === "") {
                    log.error("invalid path for cursor");
                    return;
                }

                this.cursorEventBus.emit("local-cursor-update", {
                    path: path,
                    label: "user",
                    color: `#${"ff0000"}`,
                    left: cursorCoords.left,
                    bottom: cursorCoords.bottom,
                });
            }),
        );
    }

    private async refreshToken() {
        try {
            const res = await this.apiClient.login(
                this.settings.workspaceName,
                this.settings.workspacePass,
            );
            this.apiClient.setAuthorizationHeader(res.token);
            this.wsClient.setAuthorization(res.token);
        } catch (error) {
            log.error(error);
        }
    }

    async onload() {
        // Settings
        await this.loadSettings();
        this.addSettingTab(new SettingTab(this.app, this));
        log.setGlobalLevel(this.settings.logLevel);

        // Init
        this.storage = new Disk(this.app.vault);
        const httpClient = new HttpClient(
            this.settings.useTLS ? "https" : "http",
            this.settings.domain,
            {},
        );
        this.apiClient = new ApiClient(httpClient);
        this.wsClient = new WsClient(this.settings.useTLS ? "wss" : "ws", this.settings.domain);

        await this.refreshToken();
        this.registerInterval(
            window.setInterval(async () => await this.refreshToken(), 5 * 60 * 1000),
        );

        const snapshotEventBus = new EventBus<SnapshotEventMap>();
        this.registerView(VIEW_TYPE_SNAPSHOT, (leaf) => new SnapshotView(leaf, snapshotEventBus));
        this.app.workspace.onLayoutReady(() => this.activateSnapshotView());

        // Deferred startup
        setTimeout(async () => {
            await this.registerSyncinator();
            this.registerCursors();
            new Notice("Obsidian Live Syncinator inizialized");
        }, 2000);
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_SNAPSHOT);
        this.wsClient.close(true);
        this.cursorEnv.close();
    }

    async loadSettings() {
        this.settings = Object.assign({}, this.settings, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async activateSnapshotView() {
        const { workspace } = this.app;

        // Check if view already exists
        const existingView = workspace.getLeavesOfType(VIEW_TYPE_SNAPSHOT)[0];
        if (existingView) {
            // Focus the existing view
            // workspace.revealLeaf(existingView);
            return;
        }

        // Create a new leaf in the right sidebar
        const leaf = workspace.getRightLeaf(false);
        if (leaf) {
            await leaf.setViewState({
                type: VIEW_TYPE_SNAPSHOT,
                active: false,
            });
        }
    }

    async wrappedDiffModal(filename: string, local: FileDiff, remote: FileDiff): Promise<string> {
        const modal = new DiffModal(this.app, filename, local, remote);
        return await modal.open();
    }
}
