import { App, Modal, Setting } from "obsidian";

export interface Choice { label: string; cta?: boolean; warning?: boolean; run: () => void }

/** A short question with two or three answers. Closing it without choosing does nothing. */
export class ChoiceModal extends Modal {
	constructor(app: App, private title: string, private body: string[], private choices: Choice[]) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(this.title);
		for (const p of this.body) this.contentEl.createEl("p", { text: p });
		const row = new Setting(this.contentEl);
		for (const c of this.choices) {
			row.addButton((b) => {
				b.setButtonText(c.label);
				if (c.cta) b.setCta();
				if (c.warning) b.setWarning();
				b.onClick(() => { this.close(); c.run(); });
			});
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
