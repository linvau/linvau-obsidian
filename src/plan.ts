import { Modal, Notice, Setting } from "obsidian";
import { ApiError } from "./api";
import type LinvauPlugin from "./main";
import { errMsg } from "./util";

export const SITE = "https://linvau.com";
const LANG_PREFIX: Record<string, string> = { en: "", es: "es/", pt: "pt/", de: "de/" };

/** Pages of the Linvau site in the user's language. Terms and privacy exist in the four languages. */
export function siteUrl(page: "terms" | "privacy" | "support", lang: string): string {
	return `${SITE}/${LANG_PREFIX[lang] ?? ""}${page}/`;
}

export const ABUSE_MAIL = "abuse@linvau.com";
export const SUPPORT_MAIL = "support@linvau.com";

/** Opens a page in the system browser (desktop and mobile). Payment always happens on the provider's page, never inside Obsidian. */
export function openExternal(url: string) {
	window.open(url, "_blank");
}

/** Chooses the billing period, then opens the payment page. The plugin never sees card data. */
export class UpgradeModal extends Modal {
	private busy = false;

	constructor(private plugin: LinvauPlugin) {
		super(plugin.app);
	}

	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText("Upgrade to Linvau Pro");
		contentEl.createEl("p", { text: "Pro removes the limit on active shared notes. The payment page opens in your browser and is run by Creem, our payment provider; Linvau never sees your card." });
		contentEl.createEl("p", { cls: "setting-item-description", text: "Use the same email as this Linvau account. Pro is applied automatically after payment. Cancel any time from the subscription portal. 10-day money-back guarantee." });
		const row = (name: string, desc: string, interval: "month" | "year", cta: boolean) =>
			new Setting(contentEl).setName(name).setDesc(desc).addButton((b) => {
				b.setButtonText("Continue").onClick(() => void this.start(interval, b.buttonEl));
				if (cta) b.setCta();
			});
		row("Yearly", "Two months free compared with paying monthly.", "year", true);
		row("Monthly", "Pay month to month.", "month", false);
		new Setting(contentEl).setDesc("Prices and plan details: ").addExtraButton((b) =>
			b.setIcon("external-link").setTooltip("Open linvau.com pricing").onClick(() => openExternal(`${SITE}/#pricing`)));
	}

	private async start(interval: "month" | "year", btn: HTMLButtonElement) {
		if (this.busy) return;
		this.busy = true;
		btn.disabled = true;
		try {
			const { url } = await this.plugin.api.checkout(interval, this.plugin.deviceInfo().lang);
			openExternal(url);
			this.close();
			new Notice("Linvau: payment page opened in your browser. This device will notice when Pro is active.", 8000);
			this.plugin.watchForPro();
		} catch (e) {
			if (e instanceof ApiError && e.code === "already_pro") { new Notice("Linvau: this account is already on Pro."); this.close(); await this.plugin.refreshPlan(); return; }
			new Notice(`Linvau: ${errMsg(e)}`);
			btn.disabled = false;
		} finally {
			this.busy = false;
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
