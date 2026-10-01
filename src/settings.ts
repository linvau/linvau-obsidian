import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type LinvauPlugin from "./main";
import { errMsg } from "./util";

export class LinvauSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: LinvauPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Pilot build. Notes are only published when you run “Publish current note”. Nothing else in your vault is read or sent.",
		});

		new Setting(containerEl).setName("Connection").setHeading();

		new Setting(containerEl)
			.setName("API URL")
			.setDesc("Pilot server address, e.g. https://linvau-api-mock.<your-subdomain>.workers.dev")
			.addText((t) =>
				t.setPlaceholder("https://…workers.dev")
					.setValue(this.plugin.data.settings.apiBase)
					.onChange(async (v) => {
						this.plugin.data.settings.apiBase = v.trim().replace(/\/+$/, "");
						await this.plugin.saveState();
					}));

		new Setting(containerEl)
			.setName("Pilot token")
			.setDesc("Stored in this device’s local storage, never in the vault, so it does not travel with Obsidian Sync or git. Enter it on each device.")
			.addText((t) => {
				t.inputEl.type = "password";
				t.setPlaceholder(this.plugin.getToken() ? "•••••••• (set)" : "Paste token")
					.onChange((v) => this.plugin.setToken(v.trim() || null));
			});

		new Setting(containerEl)
			.setName("Test connection")
			.addButton((b) =>
				b.setButtonText("Test").onClick(async () => {
					try {
						const h = await this.plugin.api.health();
						const me = await this.plugin.api.me();
						new Notice(`Linvau: connected to ${h.service} ${h.version} as ${me.owner}.`);
						this.plugin.logger.info(`connection OK (${h.service} ${h.version})`);
					} catch (e) {
						new Notice(`Linvau: ${errMsg(e)}`);
						this.plugin.logger.error(`connection test failed: ${errMsg(e)}`);
					}
				}));

		new Setting(containerEl).setName("Sync").setHeading();

		new Setting(containerEl)
			.setName("Debounce (seconds)")
			.setDesc("Wait this long after the last save before publishing. PRD range: 5–10 s.")
			.addSlider((s) =>
				s.setLimits(2, 30, 1)
					.setValue(this.plugin.data.settings.debounceSeconds)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.data.settings.debounceSeconds = v;
						await this.plugin.saveState();
					}));

		new Setting(containerEl)
			.setName("Maximum wait while editing (seconds)")
			.setDesc("During a long editing session, publish at least this often even if you keep typing.")
			.addSlider((s) =>
				s.setLimits(15, 120, 5)
					.setValue(this.plugin.data.settings.maxWaitSeconds)
					.setDynamicTooltip()
					.onChange(async (v) => {
						this.plugin.data.settings.maxWaitSeconds = v;
						await this.plugin.saveState();
					}));

		new Setting(containerEl)
			.setName("Verbose log")
			.setDesc("Also log every save event and skipped (unchanged) syncs.")
			.addToggle((t) =>
				t.setValue(this.plugin.data.settings.verbose).onChange(async (v) => {
					this.plugin.data.settings.verbose = v;
					this.plugin.logger.verbose = v;
					await this.plugin.saveState();
				}));
	}
}

export class ConfirmModal extends Modal {
	constructor(app: App, private title: string, private body: string, private cta: string, private onConfirm: () => void) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(this.title);
		this.contentEl.createEl("p", { text: this.body });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText(this.cta).setWarning().onClick(() => {
				this.close();
				this.onConfirm();
			}));
	}

	onClose() {
		this.contentEl.empty();
	}
}
