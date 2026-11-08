import { App, Modal, Setting } from "obsidian";
import type { ReviewInfo } from "./api";
import { summarize } from "./diff";

/** "Publish revision": what changes for readers, a private preview, and the decision (PRD F4). */
export class ReviewModal extends Modal {
	constructor(app: App, private noteName: string, private info: ReviewInfo,
		private actions: { publish: () => Promise<boolean>; discard: () => void }) {
		super(app);
	}

	onOpen() {
		const { contentEl, info } = this;
		this.modalEl.addClass("linvau-review");
		this.titleEl.setText(`Publish revision · ${this.noteName}`);
		const pending = info.pending!;
		const from = info.published ? `version ${info.published.version}` : "nothing (never published)";
		contentEl.createEl("p", { text: `Readers now see ${from}. Publishing makes version ${pending.version} visible to everyone who has the link.` });

		const s = summarize(info.published, pending);
		const facts = contentEl.createEl("p");
		facts.createEl("b", { text: `+${s.added} / −${s.removed} lines` });
		if (s.titleChanged) facts.appendText(` · title: “${info.published!.title}” → “${pending.title}”`);
		if (s.sections.length) {
			const ul = contentEl.createEl("ul", { cls: "linvau-review-sections" });
			for (const sec of s.sections.slice(0, 12)) ul.createEl("li", { text: `${sec.change === "added" ? "New" : sec.change === "removed" ? "Removed" : "Changed"}: ${sec.title}` });
			if (s.sections.length > 12) ul.createEl("li", { cls: "linvau-muted", text: `… and ${s.sections.length - 12} more` });
		}
		if (s.lines.length) {
			const pre = contentEl.createEl("pre", { cls: "linvau-diff" });
			for (const l of s.lines) pre.createDiv({ cls: l.kind === "+" ? "linvau-add" : "linvau-del", text: `${l.kind} ${l.text}` });
			if (s.added + s.removed > s.lines.length) pre.createDiv({ cls: "linvau-muted", text: `… ${s.added + s.removed - s.lines.length} more changed lines` });
		} else {
			contentEl.createEl("p", { cls: "linvau-muted", text: "Only formatting or attachments changed." });
		}

		const row = new Setting(contentEl);
		if (info.previewUrl) row.addButton((b) => b.setButtonText("Preview").setTooltip("Private preview, valid for one hour").onClick(() => window.open(info.previewUrl!, "_blank")));
		row.addButton((b) => b.setButtonText("Discard changes").setWarning().onClick(() => { this.close(); this.actions.discard(); }));
		row.addButton((b) => b.setButtonText(`Publish version ${pending.version}`).setCta().onClick(async () => {
			b.setDisabled(true);
			if (await this.actions.publish()) this.close(); else b.setDisabled(false);
		}));
	}

	onClose() { this.contentEl.empty(); }
}
