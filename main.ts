import { Notice, Plugin } from "obsidian";
import type { App, PluginManifest } from "obsidian";
import { SettingTab } from "./src/settings";
import { ApiClient } from "src/api";
import { Auth } from "src/auth";

// Remember to rename these classes and interfaces!

interface MyPluginSettings {
	serverURL: string;
	workspaceName: string;
	workspacePass: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	serverURL: "http://127.0.0.1:8080",
	workspaceName: "",
	workspacePass: "",
};

export default class RealTimeSync extends Plugin {
	settings: MyPluginSettings = DEFAULT_SETTINGS;
	private statusBar: HTMLElement;
	private uploadingFiles = 0;
	private downloadingFiles = 0;
	private apiClient: ApiClient;

	constructor(app: App, manifest: PluginManifest) {
		super(app, manifest);
		this.statusBar = this.addStatusBarItem();
		this.apiClient = new ApiClient(this.settings.serverURL, {});
	}

	async onload() {
		await this.loadSettings();
		this.updateStatusBar();

		new Notice("Real time sync inizialized");

		const auth = new Auth(this.apiClient);
		try {
			const res = await auth.login(
				this.settings.workspaceName,
				this.settings.workspacePass,
			);
			console.log(res);
		} catch (error) {
			console.log(error);
		}

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, "click", (evt: MouseEvent) => {
			console.log("click", evt);
		});

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		// this.registerInterval(
		// 	window.setInterval(() => this.addUploadingFiles(1), 1 * 1000),
		// );
	}

	onunload() {}

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
