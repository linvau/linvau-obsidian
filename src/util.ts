import { App, getFrontMatterInfo, TFile } from "obsidian";

export interface Payload {
	title: string;
	markdown: string;
	hash: string;
	bytes: number;
}

export async function sha256(text: string): Promise<string> {
	const data = new TextEncoder().encode(text);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Builds what will be published. Properties (frontmatter) are stripped on the device:
 * they never leave the vault (PRD: properties hidden by default).
 */
export async function buildPayload(app: App, file: TFile): Promise<Payload> {
	const raw = await app.vault.read(file);
	const fm = getFrontMatterInfo(raw);
	const markdown = fm.exists ? raw.slice(fm.contentStart) : raw;
	const fmTitle = app.metadataCache.getFileCache(file)?.frontmatter?.title;
	const title = typeof fmTitle === "string" && fmTitle.trim() ? fmTitle.trim() : file.basename;
	const hash = await sha256(`${title}\n\u0000\n${markdown}`);
	return { title, markdown, hash, bytes: new TextEncoder().encode(markdown).length };
}

export function ago(ts: number | null): string {
	if (!ts) return "never";
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (s < 45) return "just now";
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h} h ago`;
	return `${Math.round(h / 24)} d ago`;
}

export function percentile(values: number[], p: number): number | null {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx];
}

export function fmtMs(ms: number | null): string {
	if (ms === null) return "—";
	return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function errMsg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
