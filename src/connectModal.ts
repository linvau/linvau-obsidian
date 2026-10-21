import { App, Modal, Notice, Setting } from "obsidian";
import { ApiError, type LinvauApi, type LoginResult } from "./api";
import { errMsg } from "./util";

/**
 * "Connect to Linvau": email → 6-digit code → this device is connected.
 * Everything happens inside Obsidian (no browser round trip), so it works the same on desktop and mobile.
 */
export class ConnectModal extends Modal {
	private email = "";
	private resendAt = 0;
	private timer: number | null = null;
	private done = false;
	private busy = false;

	constructor(
		app: App,
		private api: LinvauApi,
		private device: { name: string; platform: string; lang: string },
		private reason: string | null,
		private onResult: (r: LoginResult | null) => void,
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("linvau-connect");
		this.showEmailStep();
	}

	onClose() {
		if (this.timer !== null) window.clearInterval(this.timer);
		this.contentEl.empty();
		if (!this.done) this.onResult(null);
	}

	private errorLine(): HTMLElement {
		return this.contentEl.createDiv({ cls: "linvau-connect-error" });
	}

	private showEmailStep(prefill = this.email) {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText("Connect to Linvau");
		if (this.reason) contentEl.createEl("p", { text: this.reason });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "Your free account lets you pause, renew or remove your links from any of your devices. "
				+ "We only ask for your email: we send you a 6-digit code, no password.",
		});
		let input!: HTMLInputElement;
		new Setting(contentEl).setName("Email").addText((t) => {
			input = t.inputEl;
			input.type = "email";
			input.autocomplete = "email";
			input.setAttr("autocapitalize", "off");
			input.setAttr("spellcheck", "false");
			t.setPlaceholder("you@example.com").setValue(prefill);
		});
		const err = this.errorLine();
		let sendBtn!: HTMLButtonElement;
		const setBusy = (on: boolean) => {
			this.busy = on;
			sendBtn.disabled = on;
			input.disabled = on;
			sendBtn.setText(on ? "Sending…" : "Send code");
		};
		const send = async () => {
			if (this.busy) return;
			const email = input.value.trim();
			if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { err.setText("Enter a valid email address."); return; }
			setBusy(true);
			err.setText("");
			try {
				const r = await this.api.requestCode(email, this.device.lang);
				this.email = email;
				this.resendAt = Date.now() + r.resendAfter * 1000;
				this.showCodeStep();
			} catch (e) {
				// "Too soon" means a code was already sent a moment ago: go on and use it.
				if (e instanceof ApiError && e.code === "too_soon") {
					this.email = email;
					this.resendAt = Date.now() + (e.retryAfter ?? 60) * 1000;
					this.showCodeStep();
				} else {
					err.setText(errMsg(e));
				}
			} finally {
				// The step may already have changed (success): only restore controls that are still on screen.
				if (sendBtn.isConnected) setBusy(false); else this.busy = false;
			}
		};
		new Setting(contentEl).addButton((b) => { sendBtn = b.buttonEl; b.setButtonText("Send code").setCta().onClick(() => void send()); });
		input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); void send(); } });
		window.setTimeout(() => input.focus(), 50);
	}

	private showCodeStep() {
		const { contentEl } = this;
		contentEl.empty();
		this.titleEl.setText("Enter your code");
		contentEl.createEl("p", { text: `We sent a 6-digit code to ${this.email}. It expires in 10 minutes.` });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "Not there after a few seconds? Check your spam folder. You can read it on any device and type it here.",
		});
		const input = contentEl.createEl("input", {
			cls: "linvau-code-input",
			attr: { type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6", placeholder: "000000", "aria-label": "6-digit code" },
		});
		const err = this.errorLine();
		let resendBtn!: HTMLButtonElement;
		let connectBtn!: HTMLButtonElement;
		let otherBtn!: HTMLButtonElement;
		const tick = () => {
			if (!resendBtn) return;
			if (this.busy) { resendBtn.disabled = true; return; }
			const left = Math.ceil((this.resendAt - Date.now()) / 1000);
			resendBtn.disabled = left > 0;
			resendBtn.setText(left > 0 ? `Resend code (${left}s)` : "Resend code");
		};
		const setBusy = (on: boolean, label?: string) => {
			this.busy = on;
			input.disabled = on;
			connectBtn.disabled = on;
			otherBtn.disabled = on;
			connectBtn.setText(on && label === "connect" ? "Connecting…" : "Connect");
			tick();
		};
		const verify = async () => {
			const code = input.value.replace(/\D/g, "");
			if (code.length !== 6 || this.busy) return;
			setBusy(true, "connect");
			err.setText("");
			try {
				const r = await this.api.verifyCode(this.email, code, this.device.name, this.device.platform);
				this.done = true;
				this.onResult(r);
				this.close();
			} catch (e) {
				input.value = "";
				if (e instanceof ApiError && (e.code === "code_expired" || e.code === "too_many_attempts")) {
					err.setText(`${errMsg(e)} Use “Resend code”.`);
					this.resendAt = Math.min(this.resendAt, Date.now());
				} else {
					err.setText(errMsg(e));
				}
			} finally {
				if (input.isConnected) { setBusy(false); input.focus(); } else this.busy = false;
			}
		};
		input.addEventListener("input", () => {
			input.value = input.value.replace(/\D/g, "").slice(0, 6);
			if (input.value.length === 6) void verify();
		});

		const row = new Setting(contentEl);
		row.addButton((b) => { otherBtn = b.buttonEl; b.setButtonText("Use another email").onClick(() => { if (!this.busy) this.showEmailStep(); }); });
		row.addButton((b) => {
			resendBtn = b.buttonEl;
			b.onClick(async () => {
				if (Date.now() < this.resendAt || this.busy) return;
				setBusy(true, "resend");
				resendBtn.setText("Sending…");
				err.setText("");
				try {
					const r = await this.api.requestCode(this.email, this.device.lang);
					this.resendAt = Date.now() + r.resendAfter * 1000;
					err.setText("New code sent. The previous one no longer works.");
				} catch (e) {
					if (e instanceof ApiError && e.retryAfter) this.resendAt = Date.now() + e.retryAfter * 1000;
					err.setText(errMsg(e));
				} finally {
					setBusy(false);
				}
			});
		});
		row.addButton((b) => { connectBtn = b.buttonEl; b.setButtonText("Connect").setCta().onClick(() => void verify()); });

		tick();
		if (this.timer !== null) window.clearInterval(this.timer);
		this.timer = window.setInterval(tick, 1000);
		window.setTimeout(() => input.focus(), 50);
	}
}

export function connectedNotice(r: LoginResult) {
	new Notice(`Linvau: connected as ${r.user.email}.`);
	if (r.claimedNotes > 0) new Notice(`Linvau: ${r.claimedNotes} note(s) published during the pilot are now in your account.`, 8000);
}
