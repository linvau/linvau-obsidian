import { App, Modal, Setting, TFile } from "obsidian";
import type LinvauPlugin from "./main";
import type { Payload } from "./content";

export interface EmbedChoice { assetsEnabled: boolean; approvedEmbeds: string[] }

/**
 * Shows what a note brings along before it is published (or while it is live):
 *  - images and attachments → published by default, can be turned off for this note;
 *  - embedded notes         → off by default, each one needs an explicit approval;
 *  - side panel items       → listed, with the reminder that other sites control their own access.
 */
export class EmbedsModal extends Modal {
	private choice: EmbedChoice;

	constructor(
		app: App, private plugin: LinvauPlugin, private file: TFile,
		initial: EmbedChoice, private mode: "publish" | "manage",
		private onConfirm: (choice: EmbedChoice) => void,
	) {
		super(app);
		this.choice = { assetsEnabled: initial.assetsEnabled, approvedEmbeds: [...initial.approvedEmbeds] };
	}

	onOpen() {
		this.titleEl.setText(this.mode === "publish" ? `Publish “${this.file.basename}”` : `Embedded content of “${this.file.basename}”`);
		void this.render();
	}

	onClose() {
		this.contentEl.empty();
	}

	private async render() {
		const { contentEl } = this;
		contentEl.empty();

		// Scan with attachments on and with the current approvals, to list everything the note refers to.
		let scan: Payload;
		try {
			scan = await this.plugin.builder.build(this.file, this.plugin.buildOptions({ assetsEnabled: true, approvedEmbeds: this.choice.approvedEmbeds }));
		} catch (e) {
			contentEl.createEl("p", { text: `Could not read the note: ${e instanceof Error ? e.message : String(e)}` });
			return;
		}

		// ── Attachments
		const images = scan.assets.filter((a) => a.image).length;
		const files = scan.assets.length - images;
		const mb = (scan.assets.reduce((s, a) => s + a.bytes, 0) / 1e6).toFixed(1);
		new Setting(contentEl).setName("Images and attachments").setHeading();
		if (scan.assets.length) {
			const parts = [images ? `${images} image${images > 1 ? "s" : ""}` : "", files ? `${files} file${files > 1 ? "s" : ""}` : ""].filter(Boolean).join(" and ");
			new Setting(contentEl)
				.setName(`Publish ${parts} (${mb} MB)`)
				.setDesc("They are published with the note and stop being available when you pause, regenerate or unpublish the link. Images you add later are published too.")
				.addToggle((t) => t.setValue(this.choice.assetsEnabled).onChange((v) => { this.choice.assetsEnabled = v; }));
		} else {
			contentEl.createEl("p", { cls: "setting-item-description", text: "This note has no images or attachments." });
		}

		// ── Embedded notes
		const embeds = [...new Set([...scan.includedEmbeds, ...scan.pendingEmbeds])].sort();
		new Setting(contentEl).setName("Embedded notes").setHeading();
		if (embeds.length) {
			contentEl.createEl("p", {
				cls: "setting-item-description",
				text: "An embedded note brings its whole content into this link, and keeps doing so as that note changes. Nothing is included unless you turn it on here.",
			});
			for (const path of embeds) {
				new Setting(contentEl)
					.setName(path.replace(/\.md$/, ""))
					.setDesc("Include the content of this note")
					.addToggle((t) => t.setValue(this.choice.approvedEmbeds.includes(path)).onChange((v) => {
						const set = new Set(this.choice.approvedEmbeds);
						if (v) set.add(path); else set.delete(path);
						this.choice.approvedEmbeds = [...set];
					}));
			}
		} else {
			contentEl.createEl("p", { cls: "setting-item-description", text: "This note does not embed other notes." });
		}

		// ── Side panel
		if (scan.panel.length) {
			new Setting(contentEl).setName("Side panel").setHeading();
			const third = scan.panel.filter((p) => p.url).length;
			contentEl.createEl("p", {
				cls: "setting-item-description",
				text: `${scan.panel.length} item${scan.panel.length > 1 ? "s" : ""} will be offered next to the note.`
					+ (third ? ` ${third} come${third > 1 ? "" : "s"} from other sites: who can see that content is decided by those sites, not by Linvau.` : ""),
			});
		}

		// ── Not publishable
		if (scan.skipped.length) {
			new Setting(contentEl).setName("Not published").setHeading();
			const ul = contentEl.createEl("ul", { cls: "setting-item-description" });
			scan.skipped.forEach((m) => ul.createEl("li", { text: m }));
		}

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText(this.mode === "publish" ? "Publish" : "Save").setCta().onClick(() => {
				// Approvals for notes that are no longer embedded are dropped.
				this.choice.approvedEmbeds = this.choice.approvedEmbeds.filter((p) => embeds.includes(p));
				this.close();
				this.onConfirm(this.choice);
			}));
	}
}
