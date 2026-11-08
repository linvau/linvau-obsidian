import { App, Modal, Notice, Setting } from "obsidian";
import qrcode from "qrcode-generator";

/**
 * QR code of a link (PRD 6.8). It encodes the share link, so it survives edits and pauses and stops
 * working only when the link is regenerated or unpublished. Free plan: PNG.
 */
export function qrCanvas(url: string, size = 1024): HTMLCanvasElement {
	const qr = qrcode(0, "M");
	qr.addData(url);
	qr.make();
	const n = qr.getModuleCount(), quiet = 4, cell = Math.floor(size / (n + quiet * 2));
	const px = cell * (n + quiet * 2);
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = px;
	const ctx = canvas.getContext("2d")!;
	ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, px, px);
	ctx.fillStyle = "#000000";
	for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
	return canvas;
}

const pngOf = (canvas: HTMLCanvasElement) => new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("PNG not available"))), "image/png"));

export class QrModal extends Modal {
	constructor(app: App, private noteName: string, private notePath: string, private url: string) { super(app); }

	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText(`QR code · ${this.noteName}`);
		const canvas = qrCanvas(this.url);
		canvas.addClass("linvau-qr");
		contentEl.appendChild(canvas);
		contentEl.createEl("p", { cls: "linvau-muted", text: `${this.url} — keeps working while you edit or pause the link; stops if you regenerate or unpublish it.` });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Copy image").onClick(async () => {
				try {
					await navigator.clipboard.write([new ClipboardItem({ "image/png": await pngOf(canvas) })]);
					new Notice("Linvau: QR code copied.");
				} catch {
					new Notice("Linvau: this device cannot copy images. Use “Save PNG to vault”.");
				}
			}))
			.addButton((b) => b.setButtonText("Save PNG to vault").setCta().onClick(async () => {
				try {
					const name = `${this.noteName.replace(/[\\/:*?"<>|#^[\]]/g, "-")} - QR.png`;
					const path = await this.app.fileManager.getAvailablePathForAttachment(name, this.notePath);
					await this.app.vault.createBinary(path, await (await pngOf(canvas)).arrayBuffer());
					new Notice(`Linvau: QR saved as ${path}`);
					this.close();
				} catch (e) {
					new Notice(`Linvau: could not save the QR code (${e instanceof Error ? e.message : String(e)}).`);
				}
			}));
	}

	onClose() { this.contentEl.empty(); }
}
