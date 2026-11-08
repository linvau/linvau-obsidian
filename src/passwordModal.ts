import { App, Modal, Setting } from "obsidian";

export const PASSWORD_MIN = 4;
export const PASSWORD_MAX = 200;

/**
 * Asks for a new password (twice). The password is sent to the server once, over HTTPS, and is not
 * stored on this device: the server keeps only a slow hash of it.
 */
export class PasswordModal extends Modal {
	constructor(app: App, private noteName: string, private changing: boolean, private onSubmit: (password: string) => Promise<boolean>) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText(this.changing ? "Change password" : "Protect with a password");
		contentEl.createEl("p", { text: `Readers of “${this.noteName}” will need this password to open the link.` });
		contentEl.createEl("p", { cls: "linvau-muted", text: this.changing
			? "Everyone who opened the note with the old password will be asked for the new one."
			: "Send the password through a different channel than the link. AI assistants and previews cannot read a protected note either." });

		let pw = "", again = "", busy = false;
		const error = contentEl.createDiv({ cls: "linvau-error" });
		const input = (name: string, set: (v: string) => void) => new Setting(contentEl).setName(name).addText((t) => {
			t.inputEl.type = "password";
			t.inputEl.autocomplete = "new-password";
			t.inputEl.maxLength = PASSWORD_MAX;
			t.onChange(set);
			t.inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") void submit(); });
			return t;
		});
		input("Password", (v) => { pw = v; });
		input("Repeat password", (v) => { again = v; });

		const submit = async () => {
			if (busy) return;
			const len = [...pw].length;
			if (len < PASSWORD_MIN || !pw.trim()) { error.setText(`Use at least ${PASSWORD_MIN} characters.`); return; }
			if (len > PASSWORD_MAX) { error.setText(`Use at most ${PASSWORD_MAX} characters.`); return; }
			if (pw !== again) { error.setText("The two passwords are different."); return; }
			busy = true; error.setText("");
			if (await this.onSubmit(pw)) this.close();
			busy = false;
		};
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText(this.changing ? "Change password" : "Set password").setCta().onClick(() => void submit()));
		window.setTimeout(() => contentEl.querySelector("input")?.focus(), 0);
	}

	onClose() {
		this.contentEl.empty();
	}
}
