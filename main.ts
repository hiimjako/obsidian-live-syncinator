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
import { Disk } from "src/storage/storage";
import { computeDiff } from "src/diff";

export default class RealTimeSync extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	private statusBar: HTMLElement;
	private uploadingFiles = 0;
	private downloadingFiles = 0;
	private httpClient: HttpClient;
	private wsClient: WsClient;
	private filePathToId: Map<string, number> = new Map();
	private fileIdToContent: Map<number, string> = new Map();
	private storage: Disk;

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

		this.storage = new Disk(this.app.vault);
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

	private async fetchFiles() {
		const apiClient = new ApiClient(this.httpClient);
		const files = await apiClient.fetchFiles();

		for (const file of files) {
			this.filePathToId.set(file.workspace_path, file.id);

			const exists = await this.storage.exists(file.workspace_path);
			const fileWithContent = await apiClient.fetchFile(file.id);

			if (!exists) {
				await this.storage.createObject(
					file.workspace_path,
					fileWithContent.content,
				);
			} else {
				const currentContent = await this.storage.readObject(
					file.workspace_path,
				);
				const diffs = computeDiff(currentContent, fileWithContent.content);
				await this.storage.persistChunks(file.workspace_path, diffs);
			}

			this.fileIdToContent.set(
				file.id,
				await this.storage.readObject(file.workspace_path),
			);
		}
		console.log(`fetched ${this.filePathToId.size} files from remote`);
	}

	registerEvents() {
		this.registerEvent(
			this.app.vault.on("create", async (file: TAbstractFile) => {
				if (this.filePathToId.has(file.path)) {
					return;
				}

				try {
					const apiClient = new ApiClient(this.httpClient);
					const fileApi = await apiClient.createFile(file.path, "");
					this.filePathToId.set(fileApi.workspace_path, fileApi.id);
				} catch (error) {
					console.error(error);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", async (file: TAbstractFile) => {
				const fileId = this.filePathToId.get(file.path);
				if (fileId == null) {
					console.error(`file '${file.path}' not found`);
					return;
				}

				const currentContent = this.fileIdToContent.get(fileId);
				if (currentContent == null) {
					console.error(`file '${file.path}' not found`);
					return;
				}

				const newContent = await this.storage.readObject(file.path);
				const chunks = computeDiff(currentContent, newContent);

				this.wsClient.sendMessage({ fileId, chunks });
				console.log("modify", file);
			}),
		);

		this.registerEvent(
			this.app.vault.on("delete", async (file: TAbstractFile) => {
				const fileId = this.filePathToId.get(file.path);
				if (!fileId) {
					console.error(`missing file for deletion: ${file.path}`);
					return;
				}

				try {
					const apiClient = new ApiClient(this.httpClient);
					await apiClient.deleteFile(fileId);
					this.filePathToId.delete(file.path);
				} catch (error) {
					console.error(error);
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on(
				"rename",
				async (file: TAbstractFile, oldPath: string) => {
					const oldFileId = this.filePathToId.get(oldPath);
					if (!oldFileId) {
						console.error(`missing file for rename: ${oldPath}`);
						return;
					}

					const apiClient = new ApiClient(this.httpClient);

					try {
						await apiClient.deleteFile(oldFileId);
						this.filePathToId.delete(file.path);
					} catch (error) {
						console.error(error);
					}

					if (this.filePathToId.has(file.path)) {
						return;
					}

					try {
						const fileApi = await apiClient.createFile(file.path, "");
						this.filePathToId.set(fileApi.workspace_path, fileApi.id);
					} catch (error) {
						console.error(error);
					}
				},
			),
		);
	}

	async onload() {
		// Settings
		await this.loadSettings();
		this.addSettingTab(new SettingTab(this.app, this));

		// Init
		await this.refreshToken();
		this.registerInterval(
			window.setInterval(async () => await this.refreshToken(), 5 * 60 * 1000),
		);

		// Deferred startup
		setTimeout(async () => {
			await this.fetchFiles();
			this.updateStatusBar();
			new Notice("Real time sync inizialized");
			this.registerEvents();
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
