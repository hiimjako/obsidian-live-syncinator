import { Notice, Plugin } from "obsidian";
import type { App, PluginManifest } from "obsidian";
import { log } from "src/logger/logger";
import { Syncinator as SyncinatorPlugin } from "src/plugin";
import { Disk } from "src/storage/storage";
import { ApiClient } from "./src/api/api";
import { HttpClient } from "./src/api/http";
import { WsClient } from "./src/api/ws";
import {
    DEFAULT_SETTINGS,
    type PluginSettings,
    SettingTab,
} from "./src/settings";

export default class Syncinator extends Plugin {
    settings: PluginSettings = DEFAULT_SETTINGS;
    private statusBar: HTMLElement;
    private uploadingFiles = 0;
    private downloadingFiles = 0;
    private wsClient: WsClient;
    private storage: Disk;
    private apiClient: ApiClient;

    constructor(app: App, manifest: PluginManifest) {
        super(app, manifest);
        this.statusBar = this.addStatusBarItem();
    }

    async registerPlugin() {
        const plugin = new SyncinatorPlugin(
            this.storage,
            this.apiClient,
            this.wsClient,
            {
                conflictResolution: this.settings.conflictResolution,
            },
        );

        await plugin.init();

        this.registerEvent(this.app.vault.on("create", plugin.events.create));
        this.registerEvent(this.app.vault.on("modify", plugin.events.modify));
        this.registerEvent(this.app.vault.on("delete", plugin.events.delete));
        this.registerEvent(this.app.vault.on("rename", plugin.events.rename));
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
        this.wsClient = new WsClient(
            this.settings.useTLS ? "wss" : "ws",
            this.settings.domain,
        );

        await this.refreshToken();
        this.registerInterval(
            window.setInterval(
                async () => await this.refreshToken(),
                5 * 60 * 1000,
            ),
        );

        // Deferred startup
        setTimeout(async () => {
            await this.registerPlugin();
            this.updateStatusBar();
            new Notice("Obsidian Live Syncinator inizialized");
        }, 2000);
    }

    onunload() {
        this.wsClient.close(true);
    }

    async loadSettings() {
        this.settings = Object.assign({}, this.settings, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private updateStatusBar() {
        this.statusBar.setText(
            `sync: ${this.uploadingFiles}↑ ${this.downloadingFiles}↓`,
        );
    }

    addUploadingFiles(n: number) {
        this.uploadingFiles += n;
        this.updateStatusBar();
    }

    addDownlodingFiles(n: number) {
        this.downloadingFiles += n;
        this.updateStatusBar();
    }
}
