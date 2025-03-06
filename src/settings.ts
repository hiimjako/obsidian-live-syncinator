import type { App } from "obsidian";
import { Notice, PluginSettingTab, Setting } from "obsidian";
import type Syncinator from "../main";
import { LogLevel, type LogLevelType, log } from "./logger/logger";
import type { ConflictResolution } from "./plugin";

export interface PluginSettings {
    domain: string;
    useTLS: boolean;
    workspaceName: string;
    workspacePass: string;
    logLevel: LogLevelType;
    conflictResolution: ConflictResolution;
    nickname: string;
    color: `#${string}`;
    showCursors: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
    domain: "127.0.0.1:8080",
    useTLS: false,
    workspaceName: "",
    workspacePass: "",
    logLevel: LogLevel.WARN,
    conflictResolution: "merge",
    nickname: "",
    color: "#ff0000",
    showCursors: true,
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

        createInfoBox(containerEl);

        containerEl.createEl("h3", { text: "Connection" });

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

        containerEl.createEl("h3", { text: "Cursor" });

        new Setting(containerEl)
            .setName("Show cursors")
            .setDesc("Share your cursor positon and display other cursor in your editor")
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.showCursors).onChange((value) => {
                    this.plugin.settings.showCursors = value;
                }),
            );

        new Setting(containerEl)
            .setName("Nickname")
            .setDesc("Nickname showed to other clients")
            .addText((text) =>
                text
                    .setPlaceholder("user")
                    .setValue(this.plugin.settings.nickname)
                    .onChange((value) => {
                        this.plugin.settings.nickname = value;
                    }),
            );

        new Setting(containerEl)
            .setName("Color")
            .setDesc("Color showed to other clients")
            .addText((text) =>
                text
                    .setPlaceholder("hexadecimal color")
                    .setValue(this.plugin.settings.color)
                    .onChange((value) => {
                        if (!isValidHexColor(value)) {
                            return;
                        }
                        this.plugin.settings.color = value as `#${string}`;
                    }),
            );

        containerEl.createEl("h3", { text: "Advanced" });

        new Setting(containerEl)
            .setName("Conflict resolution")
            .setDesc("how to manage text file conflicts")
            .addDropdown((component) =>
                component
                    .addOptions({
                        merge: "Use merge tool",
                        remote: "Remote",
                        local: "Local",
                    })
                    .setValue(this.plugin.settings.conflictResolution.toString())
                    .onChange((value: ConflictResolution) => {
                        this.plugin.settings.conflictResolution = value;
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
                        this.plugin.settings.logLevel = Number(value) as LogLevelType;
                        log.setGlobalLevel(this.plugin.settings.logLevel);
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

function createInfoBox(parentEl: HTMLElement): HTMLElement {
    const infoBox = parentEl.createDiv({
        text: "To configure correctly the plugin follow the repository readme at ",
    });
    infoBox.createEl("a", {
        text: "obsidian-live-syncinator",
        href: "https://github.com/hiimjako/obsidian-live-syncinator",
    });
    infoBox.appendText(".");
    parentEl.createEl("br");

    return infoBox;
}

function isValidHexColor(color: string): boolean {
    const hexColorRegex = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/;
    return hexColorRegex.test(color);
}
