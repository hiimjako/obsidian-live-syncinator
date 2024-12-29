import { Notice, Plugin } from "obsidian";
import type { App, PluginManifest } from "obsidian";
import {
	DEFAULT_SETTINGS,
	SettingTab,
	type PluginSettings,
} from "./src/settings";
import { WsClient } from "./src/api/ws";
import { HttpClient } from "./src/api/http";
import { ApiClient } from "./src/api/api";
import { Disk } from "src/storage/storage";
import { Syncinator as SyncinatorPlugin } from "src/plugin";

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

	async registerEvents() {
		const plugin = new SyncinatorPlugin(
			this.storage,
			this.apiClient,
			this.wsClient,
		);

		await plugin.init();

		this.registerEvent(this.app.vault.on("create", plugin.events.create));
		this.registerEvent(this.app.vault.on("modify", plugin.events.modify));
		this.registerEvent(this.app.vault.on("delete", plugin.events.delete));
		this.registerEvent(this.app.vault.on("rename", plugin.events.rename));
	}

	private async refreshToken() {
		try {
			await this.apiClient.refreshToken(
				this.settings.workspaceName,
				this.settings.workspacePass,
			);
		} catch (error) {
			console.error(error);
		}
	}

	async onload() {
		// Settings
		await this.loadSettings();
		this.addSettingTab(new SettingTab(this.app, this));

		// Init
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
		this.storage = new Disk(this.app.vault);

		this.refreshToken();
		this.registerInterval(
			window.setInterval(async () => await this.refreshToken(), 5 * 60 * 1000),
		);

		// Deferred startup
		setTimeout(async () => {
			await this.registerEvents();
			this.updateStatusBar();
			new Notice("Obsidian Live Syncinator inizialized");
		}, 2000);
	}

	onunload() {
		this.wsClient.close();
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
