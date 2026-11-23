import { Modal, Notice, Setting } from "obsidian";
import { ApiError } from "./api";
import type LinvauPlugin from "./main";
import { errMsg } from "./util";

/**
 * Deleting the Linvau account (API 0.10.0). Irreversible, so the author types the account email to confirm.
 * It removes everything held on the Linvau server; the notes in the vault are never touched.
 */
export class DeleteAccountModal extends Modal {
	private busy = false;

	constructor(private plugin: LinvauPlugin) {
		super(plugin.app);
	}

	onOpen() {
		const email = this.plugin.session.email ?? "";
		const { contentEl } = this;
		this.titleEl.setText("Delete your Linvau account");
		contentEl.createEl("p", { text: "This permanently deletes your account and everything Linvau holds for it: every published note, its versions and attachments, your devices and your plan. All your links stop working immediately. It cannot be undone." });
		contentEl.createEl("p", { cls: "setting-item-description", text: "Your notes in Obsidian are not touched. If you have an active Pro subscription, cancel it first from the subscription portal: an active subscription blocks the deletion so you are not charged for an account that no longer exists." });
		let typed = "";
		let btn: HTMLButtonElement | null = null;
		const matches = () => typed.trim().toLowerCase() === email.toLowerCase() && email !== "";
		new Setting(contentEl).setName("Type your email to confirm").setDesc(email)
			.addText((t) => t.setPlaceholder(email).onChange((v) => { typed = v; if (btn) btn.disabled = this.busy || !matches(); }));
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText("Delete my account").setWarning().setDisabled(true).onClick(() => void this.run(typed));
				btn = b.buttonEl;
			});
	}

	private async run(typed: string) {
		if (this.busy) return;
		this.busy = true;
		try {
			const r = await this.plugin.api.deleteAccount(typed.trim());
			this.close();
			await this.plugin.afterAccountDeleted(r.deleted?.notes ?? 0);
		} catch (e) {
			this.busy = false;
			if (e instanceof ApiError && e.code === "active_subscription") {
				new Notice("Linvau: cancel your subscription first (opening the subscription portal), then delete the account.", 10000);
				this.close();
				void this.plugin.openPortal();
				return;
			}
			new Notice(`Linvau: ${errMsg(e)}`);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
