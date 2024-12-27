import type { App } from "obsidian";
import { Setting, PluginSettingTab } from "obsidian";
import type Syncinator from "../main";

export interface PluginSettings {
	domain: string;
	https: boolean;
	workspaceName: string;
	workspacePass: string;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	domain: "127.0.0.1:8080",
	https: false,
	workspaceName: "",
	workspacePass: "",
};

export class SettingTab extends PluginSettingTab {
	plugin: Syncinator;

	constructor(app: App, plugin: Syncinator) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("Server to connect")
			.addText((text) =>
				text
					.setPlaceholder("127.0.0.1:8080")
					.setValue(this.plugin.settings.domain)
					.onChange((value) => {
						this.plugin.settings.domain = value;
					}),
			);

		new Setting(containerEl).setName("HTTPS").addToggle((toggle) =>
			toggle.setValue(this.plugin.settings.https).onChange((value) => {
				this.plugin.settings.https = value;
			}),
		);

		new Setting(containerEl)
			.setName("Workspace name")
			.setDesc("Remote workspace to sync with")
			.addText((text) =>
				text
					.setPlaceholder("workspace")
					.setValue(this.plugin.settings.workspaceName)
					.onChange((value) => {
						this.plugin.settings.workspaceName = value;
					}),
			);

		new Setting(containerEl)
			.setName("Workspace password")
			.setDesc("Remote workspace password")
			.addText((text) =>
				text.setPlaceholder("********").onChange((value) => {
					this.plugin.settings.workspacePass = value;
				}),
			);

		new Setting(containerEl).addButton((button) =>
			button
				.setButtonText("save")
				.setWarning()
				.onClick(async () => {
					console.log(this.plugin.settings);
					await this.plugin.saveSettings();
				}),
		);
	}
}
