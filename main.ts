import { Notice, Plugin } from "obsidian";
import { log } from "src/logger/logger";
import { DiffModal, type FileDiff } from "src/modals/conflict";
import { Syncinator as SyncinatorPlugin } from "src/plugin";
import { Disk } from "src/storage/storage";
import { ApiClient, type File } from "./src/api/api";
import { HttpClient } from "./src/api/http";
import { WsClient } from "./src/api/ws";
import { DEFAULT_SETTINGS, type PluginSettings, SettingTab } from "./src/settings";

type ObsidianData = {
    settings?: PluginSettings;
    fileCache?: File[];
};

export default class Syncinator extends Plugin {
    settings: PluginSettings = DEFAULT_SETTINGS;
    private wsClient: WsClient;
    private storage: Disk;
    private apiClient: ApiClient;
    private syncinator: SyncinatorPlugin;

    async registerPlugin() {
        this.syncinator = new SyncinatorPlugin(
            this.storage,
            this.apiClient,
            this.wsClient,
            {
                diffModal: this.wrappedDiffModal.bind(this),
            },
            {
                conflictResolution: this.settings.conflictResolution,
            },
        );

        const fileCache = await this.loadFileCache();
        await this.syncinator.init(fileCache);

        this.registerEvent(this.app.vault.on("create", this.syncinator.events.create));
        this.registerEvent(this.app.vault.on("modify", this.syncinator.events.modify));
        this.registerEvent(this.app.vault.on("delete", this.syncinator.events.delete));
        this.registerEvent(this.app.vault.on("rename", this.syncinator.events.rename));

        this.registerInterval(
            window.setInterval(async () => await this.saveFileCache(), 10 * 1000),
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

        // Deferred startup
        setTimeout(async () => {
            await this.registerPlugin();
            new Notice("Obsidian Live Syncinator inizialized");
        }, 2000);
    }

    onunload() {
        this.wsClient.close(true);
        this.saveFileCache();
    }

    async loadFileCache(): Promise<File[]> {
        const data = await this.loadData();
        return data.fileCache ?? [];
    }

    async loadSettings() {
        const data = await this.loadData();
        this.settings = Object.assign({}, this.settings, data.settings);
    }

    async saveFileCache() {
        const dump = this.syncinator.cacheDumpWithoutContent();
        const len = Object.keys(dump).length;
        if (len === 0) {
            log.debug("skipping saving cache dump, empty cache");
            return;
        }
        log.debug(`saving cache dump on disk with ${len} items`);

        const data = await this.loadData();
        data.fileCache = dump;
        await this.saveData(data);
    }

    async saveSettings() {
        const data = await this.loadData();
        data.settings = this.settings;
        await this.saveData(data);
    }

    async wrappedDiffModal(filename: string, local: FileDiff, remote: FileDiff): Promise<string> {
        const modal = new DiffModal(this.app, filename, local, remote);
        return await modal.open();
    }

    // ---------- Obsidian Override ---------
    async loadData(): Promise<ObsidianData> {
        return (await super.loadData()) as ObsidianData;
    }

    async saveData(data: ObsidianData): Promise<void> {
        await super.saveData(data);
    }
}
