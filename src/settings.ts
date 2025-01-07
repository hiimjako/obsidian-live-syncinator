import type { App } from "obsidian";
import { Setting, PluginSettingTab, Notice } from "obsidian";
import type Syncinator from "../main";
import { log, LogLevel, type LogLevelType } from "./logger/logger";
import type { ConflictResolution } from "./plugin";

export interface PluginSettings {
    domain: string;
    useTLS: boolean;
    workspaceName: string;
    workspacePass: string;
    logLevel: LogLevelType;
    conflictResolution: ConflictResolution;
}

export const DEFAULT_SETTINGS: PluginSettings = {
    domain: "127.0.0.1:8080",
    useTLS: false,
    workspaceName: "",
    workspacePass: "",
    logLevel: LogLevel.WARN,
    conflictResolution: "remote",
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

        new Setting(containerEl).setName("Use TLS").addToggle((toggle) =>
            toggle.setValue(this.plugin.settings.useTLS).onChange((value) => {
                this.plugin.settings.useTLS = value;
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

        new Setting(containerEl)
            .setName("Log level")
            .setDesc("set console log level")
            .addDropdown((component) =>
                component
                    .addOptions({
                        "0": "Silent",
                        "1": "Debug",
                        "2": "Info",
                        "3": "Warn",
                        "4": "Error",
                    })
                    .setValue(this.plugin.settings.logLevel.toString())
                    .onChange((value) => {
                        this.plugin.settings.logLevel = Number(
                            value,
                        ) as LogLevelType;
                        log.setGlobalLevel(this.plugin.settings.logLevel);
                    }),
            );

        new Setting(containerEl)
            .setName("Conflict resolution")
            .setDesc("how to manage text file conflicts")
            .addDropdown((component) =>
                component
                    .addOptions({
                        remote: "Remote",
                        local: "Local",
                        auto: "Auto merge",
                    })
                    .setValue(
                        this.plugin.settings.conflictResolution.toString(),
                    )
                    .onChange((value: ConflictResolution) => {
                        this.plugin.settings.conflictResolution = value;
                    }),
            );

        new Setting(containerEl).addButton((button) =>
            button
                .setButtonText("save")
                .setWarning()
                .onClick(async () => {
                    await this.plugin.saveSettings();
                    new Notice("Settings saved!");
                }),
        );
    }
}
