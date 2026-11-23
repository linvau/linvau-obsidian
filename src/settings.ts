import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type LinvauPlugin from "./main";
import type { Billing } from "./api";
import { errMsg } from "./util";
import { DEFAULT_API_BASE, LEGACY_API_BASES } from "./types";
import { ABUSE_MAIL, SUPPORT_MAIL, siteUrl } from "./plan";

export class LinvauSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: LinvauPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Notes are only published when you run “Publish current note”. Nothing else in your vault is read or sent.",
		});

		new Setting(containerEl).setName("Account").setHeading();
		const session = this.plugin.session;
		if (session.connected) {
			new Setting(containerEl)
				.setName(`Connected as ${session.email}`)
				.setDesc(`This device: ${session.deviceName}. The session is kept in this device's local storage, never in the vault.`)
				.addButton((b) => b.setButtonText("Disconnect this device").setWarning().onClick(() => {
					this.plugin.confirmDisconnect();
				}));
			new Setting(containerEl)
				.setName("Connected devices")
				.setDesc("Devices where this account is connected. Disconnect one you lost or no longer use.")
				.addButton((b) => b.setButtonText("Show").onClick(async () => {
					try {
						const { devices } = await this.plugin.api.devices();
						const list = this.containerEl.querySelector(".linvau-devices") ?? this.containerEl.createDiv({ cls: "linvau-devices" });
						list.empty();
						for (const d of devices) {
							new Setting(list as HTMLElement)
								.setName(`${d.name}${d.current ? " (this device)" : ""}`)
								.setDesc(`Last active ${new Date(d.lastSeenAt).toLocaleString()}`)
								.addButton((x) => x.setButtonText("Disconnect").setDisabled(d.current).onClick(async () => {
									try {
										await this.plugin.api.removeDevice(d.id);
										new Notice(`Linvau: “${d.name}” disconnected.`);
										this.display();
									} catch (e) { new Notice(`Linvau: ${errMsg(e)}`); }
								}));
						}
					} catch (e) {
						new Notice(`Linvau: ${errMsg(e)}`);
					}
				}));
		} else {
			new Setting(containerEl)
				.setName("Not connected")
				.setDesc("Publishing needs a free Linvau account. We send a 6-digit code to your email; no password.")
				.addButton((b) => b.setButtonText("Connect").setCta().onClick(async () => {
					if (await this.plugin.ensureConnected()) this.display();
				}));
		}

		if (session.connected) { this.renderPlan(containerEl); this.renderAccount(containerEl); }

		new Setting(containerEl)
			.setName("Test connection")
			.addButton((b) =>
				b.setButtonText("Test").onClick(async () => {
					try {
						const h = await this.plugin.api.health();
						if (!session.connected) {
							new Notice(`Linvau: server ${h.service} ${h.version} reachable. This device is not connected yet.`);
							return;
						}
						const me = await this.plugin.api.me();
						new Notice(`Linvau: connected to ${h.service} ${h.version} as ${me.user?.email ?? me.owner}.`);
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
			.setName("Publish note styles")
			.setDesc("Readers see the CSS snippet rules that style the classes a note uses (cssclasses property or class=\"…\" in HTML). Only those rules are sent; the server keeps layout and text properties and drops anything that could affect the page around the note. Fonts from a curated list (Montserrat, Inter, Lora…) are served by Linvau.")
			.addToggle((t) =>
				t.setValue(this.plugin.data.settings.publishStyles !== false).onChange(async (v) => {
					this.plugin.data.settings.publishStyles = v;
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

		this.renderAbout(containerEl);

		// ── Advanced: folded. The server address is built in (D-54); this is only for pointing at a test server.
		const adv = containerEl.createEl("details", { cls: "linvau-advanced" });
		adv.createEl("summary", { text: "Advanced" });
		const custom = this.plugin.data.settings.apiBase;
		if (custom) adv.open = true;
		new Setting(adv)
			.setName("Server address")
			.setDesc(`Development only. Leave it empty to use the Linvau server (${DEFAULT_API_BASE}). `
				+ "Changing it disconnects this device: sessions belong to one server.")
			.addText((t) => {
				t.setPlaceholder(DEFAULT_API_BASE).setValue(custom);
				t.inputEl.addEventListener("change", () => void this.setApiBase(t.getValue()));
			})
			.addExtraButton((b) => b.setIcon("rotate-ccw").setTooltip("Use the Linvau server").setDisabled(!custom)
				.onClick(() => void this.setApiBase("")));
		if (custom) adv.createDiv({ cls: "setting-item-description mod-warning", text: `This device is using a development server: ${custom}` });
	}

	/** Plan and subscription. Payment itself happens on the payment provider's page, opened in the browser. */
	private renderPlan(parent: HTMLElement) {
		new Setting(parent).setName("Plan").setHeading();
		const host = parent.createDiv();
		const draw = (b: Billing | null) => {
			host.empty();
			if (!b) {
				new Setting(host).setName("Plan").setDesc("Could not read your plan right now.")
					.addButton((x) => x.setButtonText("Try again").onClick(() => void load()));
				return;
			}
			const used = b.usage.activeNotes;
			if (b.plan === "pro") {
				const end = b.currentPeriodEnd ? new Date(b.currentPeriodEnd).toLocaleDateString() : null;
				const state = b.cancelAtPeriodEnd ? (end ? `Ends on ${end} (cancellation scheduled).` : "Cancellation scheduled.")
					: b.status === "past_due" ? "Your last payment failed: update your card in the subscription portal."
					: end ? `Renews on ${end}.` : "";
				new Setting(host).setName("Pro").setDesc(`${used} active shared notes, no limit. ${state}`.trim())
					.addButton((x) => x.setButtonText("Manage subscription").onClick(() => void this.plugin.openPortal()));
			} else if (b.plan === "pilot") {
				new Setting(host).setName("Early access").setDesc("This device uses the early-access token. Connect with your email to see your plan.");
			} else {
				const limit = b.limit ?? b.freeNoteLimit;
				const s = new Setting(host).setName("Free")
					.setDesc(`${used} of ${limit} active shared notes. Pro removes the limit.`)
					.addButton((x) => x.setButtonText("Upgrade to Pro").setCta().onClick(() => void this.plugin.openUpgrade()));
				if (b.status === "refunded" || b.status === "disputed" || b.status === "unpaid") {
					s.setDesc(`${used} of ${limit} active shared notes. Your subscription ended (${b.status}).`);
				}
				if (b.hasPortal) s.addButton((x) => x.setButtonText("Billing portal").onClick(() => void this.plugin.openPortal()));
			}
			new Setting(host).setName("Refresh plan").addExtraButton((x) => x.setIcon("refresh-cw").setTooltip("Refresh").onClick(() => void load()));
		};
		const load = async () => { draw(this.plugin.plan); draw(await this.plugin.refreshPlan()); };
		draw(this.plugin.plan);
		void load();
	}

	/** Account deletion, kept apart from the everyday buttons. */
	private renderAccount(parent: HTMLElement) {
		new Setting(parent).setName("Account").setHeading();
		new Setting(parent).setName("Delete my account")
			.setDesc("Permanently removes your account and every published note from Linvau. Your notes in Obsidian stay as they are.")
			.addButton((b) => b.setButtonText("Delete account…").setWarning().onClick(() => this.plugin.confirmDeleteAccount()));
	}

	private renderAbout(parent: HTMLElement) {
		new Setting(parent).setName("About Linvau").setHeading();
		const lang = this.plugin.deviceInfo().lang;
		const s = new Setting(parent).setName("Terms, privacy and help")
			.setDesc("The plugin is MIT-licensed; the Linvau service is proprietary. Linvau is not affiliated with Obsidian.");
		const links = s.descEl.createDiv({ cls: "linvau-links" });
		const a = (text: string, href: string) => { links.createEl("a", { text, href }); links.appendText(" · "); };
		a("Terms", siteUrl("terms", lang));
		a("Privacy", siteUrl("privacy", lang));
		a("Support", siteUrl("support", lang));
		links.createEl("a", { text: `Report abuse (${ABUSE_MAIL})`, href: `mailto:${ABUSE_MAIL}` });
		s.descEl.createDiv({ text: `Questions: ${SUPPORT_MAIL}` });
	}

	private async setApiBase(raw: string) {
		const v = raw.trim().replace(/\/+$/, "");
		const next = v === DEFAULT_API_BASE || LEGACY_API_BASES.includes(v) ? "" : v;
		if (next && !/^https?:\/\/[^\s/]+/.test(next)) { new Notice("Linvau: enter a full address, like https://staging.example.com"); return; }
		if (next === this.plugin.data.settings.apiBase) return;
		this.plugin.data.settings.apiBase = next;
		await this.plugin.saveState();
		this.plugin.logger.info(`server address set to ${next || "the Linvau server"}`);
		if (this.plugin.session.connected) {
			this.plugin.session.clear("server address changed");
			this.plugin.accountNotes = null;
			new Notice("Linvau: server changed. Connect this device again to publish.");
		}
		this.display();
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
