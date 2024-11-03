import { Notice, Plugin } from "obsidian";
import type { App, PluginManifest, TAbstractFile } from "obsidian";
import {
	DEFAULT_SETTINGS,
	SettingTab,
	type PluginSettings,
} from "./src/settings";
import { Auth } from "src/auth";
import { WsClient } from "src/ws";
import { HttpClient } from "src/http";
import { ApiClient } from "src/api";

export default class RealTimeSync extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	private statusBar: HTMLElement;
	private uploadingFiles = 0;
	private downloadingFiles = 0;
	private httpClient: HttpClient;
	private wsClient: WsClient;

	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
		this.statusBar = this.addStatusBarItem();

		this.httpClient = new HttpClient(
			this.settings.https ? "https" : "http",
			this.settings.domain,
			{},
		);
		this.wsClient = new WsClient(this.settings.domain, {
			onError(err) {
				console.error(err);
			},
			onMessage(data) {
				console.log(data);
			},
		});
	}

	private async refreshToken() {
		const auth = new Auth(this.httpClient);
		try {
			const res = await auth.login(
				this.settings.workspaceName,
				this.settings.workspacePass,
			);
			this.httpClient.setAuthorizationHeader(res.token);
		} catch (error) {
			console.error(error);
		}
	}

	async onload() {
		await this.loadSettings();

		await this.refreshToken();
		this.registerInterval(
			window.setInterval(async () => await this.refreshToken(), 5 * 60 * 1000),
		);

		const apiClient = new ApiClient(this.httpClient);
		console.log(await apiClient.fetchFiles());

		this.addSettingTab(new SettingTab(this.app, this));

		this.updateStatusBar();

		new Notice("Real time sync inizialized");

		this.registerEvent(
			this.app.vault.on("create", async (file: TAbstractFile) => {
				try {
					const fileApi = await apiClient.createFile(file.path, "");
					console.log(fileApi);
				} catch (error) {
					console.error(error);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				console.log("modify", file);
			}),
		);

		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				console.log("delete", file);
			}),
		);

		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				console.log("rename", file, oldPath);
			}),
		);
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
