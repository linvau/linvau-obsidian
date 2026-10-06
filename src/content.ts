import { App, TFile, getFrontMatterInfo, parseYaml } from "obsidian";

/**
 * Builds what is published for a note. Everything here runs on the author's device:
 *
 *  - Properties (frontmatter) are stripped and never sent. Only the title and the side-panel
 *    list are read from them.
 *  - Obsidian comments (%% … %%) and block ids are removed.
 *  - Images and attachments embedded in the note are published with it (default), as files
 *    identified by their content hash.
 *  - An embedded NOTE is only included if the author approved that note for this link.
 *    Otherwise a neutral placeholder is sent — not even the name of the embedded note.
 */

export interface AssetRef { hash: string; ext: string; path: string; bytes: number; image: boolean }
export interface PanelInput { title?: string; url?: string; asset?: string; ext?: string; noteId?: string }

export interface Payload {
	title: string;
	markdown: string;
	hash: string;
	bytes: number;
	assets: AssetRef[];
	panel: PanelInput[];
	/** Embedded notes waiting for the author's approval (vault paths). Never sent. */
	pendingEmbeds: string[];
	/** Embedded notes included because the author approved them (vault paths). */
	includedEmbeds: string[];
	/** Things that could not be published, with the reason (shown to the author only). */
	skipped: string[];
	/** Files this note's published content depends on, besides itself. */
	deps: string[];
}

export interface BuildOptions {
	assetsEnabled: boolean;
	approvedEmbeds: Set<string>;
	/** Returns the Linvau note id if that vault path is published and active (for side-panel notes). */
	publishedNoteId: (path: string) => string | null;
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"]);
const FILE_EXT = new Set(["pdf", "mp3", "wav", "m4a", "ogg", "mp4", "webm", "mov"]);
/** Camera formats that neither Obsidian nor browsers display. */
const RAW_EXT = new Set(["dng", "heic", "heif", "raw", "cr2", "cr3", "nef", "arw", "orf", "rw2", "tif", "tiff"]);
export const MAX_ASSET_BYTES = 10_000_000;
const MAX_PANEL_ITEMS = 12;

/** Sent instead of an embed that is not published. The server renders it as a muted placeholder. */
const PLACEHOLDER = "![[linvau-not-published]]";

export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
	const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
	const digest = await crypto.subtle.digest("SHA-256", buf);
	return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function replaceAsync(text: string, re: RegExp, fn: (m: RegExpMatchArray) => Promise<string>): Promise<string> {
	const matches = [...text.matchAll(re)];
	if (!matches.length) return text;
	let out = "";
	let last = 0;
	for (const m of matches) {
		out += text.slice(last, m.index) + (await fn(m));
		last = m.index! + m[0].length;
	}
	return out + text.slice(last);
}

/** Applies `fn` to the parts of the Markdown that are not code (fenced blocks and inline code are left alone). */
async function mapOutsideCode(md: string, fn: (text: string) => Promise<string>): Promise<string> {
	const lines = md.split("\n");
	const out: string[] = [];
	let chunk: string[] = [];
	let fence: string | null = null;

	const flushChunk = async () => {
		if (!chunk.length) return;
		const parts = chunk.join("\n").split(/(`+[^`\n]*`+)/);
		for (let i = 0; i < parts.length; i += 2) parts[i] = await fn(parts[i]);
		out.push(parts.join(""));
		chunk = [];
	};

	for (const line of lines) {
		const m = line.match(/^\s{0,3}(`{3,}|~{3,})/);
		if (fence) {
			out.push(line);
			if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
		} else if (m) {
			await flushChunk();
			fence = m[1];
			out.push(line);
		} else {
			chunk.push(line);
		}
	}
	await flushChunk();
	return out.join("\n");
}

/** Text of a heading section or of a block (`#Heading`, `#^block-id`). Empty string if not found. */
function extractSubpath(body: string, subpath: string): string {
	const lines = body.split("\n");
	const last = subpath.split("#").pop()!.trim();
	if (last.startsWith("^")) {
		const id = last.slice(1);
		const idx = lines.findIndex((l) => new RegExp(`(^|\\s)\\^${id.replace(/[^\w-]/g, "")}\\s*$`).test(l));
		if (idx < 0) return "";
		let a = idx, b = idx;
		while (a > 0 && lines[a - 1].trim()) a--;
		while (b < lines.length - 1 && lines[b + 1].trim()) b++;
		return lines.slice(a, b + 1).join("\n");
	}
	const start = lines.findIndex((l) => {
		const h = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
		return !!h && h[2].trim().toLowerCase() === last.toLowerCase();
	});
	if (start < 0) return "";
	const level = lines[start].match(/^(#{1,6})/)![1].length;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		const h = lines[i].match(/^(#{1,6})\s+/);
		if (h && h[1].length <= level) { end = i; break; }
	}
	return lines.slice(start, end).join("\n");
}

export class ContentBuilder {
	/** file path + mtime + size → content hash, so unchanged attachments are not re-read. */
	private hashCache = new Map<string, string>();

	constructor(private app: App) {}

	private async assetRef(file: TFile): Promise<AssetRef | null> {
		if (file.stat.size > MAX_ASSET_BYTES) return null;
		const key = `${file.path}:${file.stat.mtime}:${file.stat.size}`;
		let hash = this.hashCache.get(key);
		if (!hash) {
			hash = await sha256Hex(await this.app.vault.readBinary(file));
			this.hashCache.set(key, hash);
		}
		const ext = file.extension.toLowerCase();
		return { hash, ext, path: file.path, bytes: file.stat.size, image: IMAGE_EXT.has(ext) };
	}

	async build(file: TFile, opts: BuildOptions): Promise<Payload> {
		const raw = await this.app.vault.read(file);
		const fm = getFrontMatterInfo(raw);
		const body = fm.exists ? raw.slice(fm.contentStart) : raw;

		let props: Record<string, unknown> = {};
		if (fm.exists) {
			try { props = (parseYaml(fm.frontmatter) as Record<string, unknown>) ?? {}; } catch { /* invalid YAML: treated as no properties */ }
		}
		const title = typeof props.title === "string" && props.title.trim() ? props.title.trim() : file.basename;

		const assets = new Map<string, AssetRef>();
		const pending = new Set<string>();
		const included = new Set<string>();
		const skipped: string[] = [];
		const deps = new Set<string>();

		const useAsset = async (dest: TFile): Promise<AssetRef | null> => {
			const ref = await this.assetRef(dest);
			if (!ref) {
				skipped.push(`${dest.name}: larger than ${MAX_ASSET_BYTES / 1e6} MB`);
				return null;
			}
			assets.set(ref.hash, ref);
			deps.add(dest.path);
			return ref;
		};

		const renderEmbed = async (target: string, label: string, width: string | undefined, source: TFile, depth: number): Promise<string> => {
			const [linkpath, ...sub] = target.split("#");
			const subpath = sub.join("#");
			const dest = linkpath.trim() ? this.app.metadataCache.getFirstLinkpathDest(linkpath.trim(), source.path) : null;
			if (!dest) return PLACEHOLDER;
			const ext = dest.extension.toLowerCase();

			if (IMAGE_EXT.has(ext) || FILE_EXT.has(ext)) {
				if (!opts.assetsEnabled) return PLACEHOLDER;
				const ref = await useAsset(dest);
				if (!ref) return PLACEHOLDER;
				const clean = (s: string) => s.replace(/[[\]\n]/g, " ").trim();
				return ref.image
					? `![${clean(label)}](linvau-asset:${ref.hash}${width ? `#w=${width}` : ""})`
					: `[${clean(label) || clean(dest.name)}](linvau-asset:${ref.hash})`;
			}

			if (ext === "md") {
				// One level only: a note embedded inside an approved embedded note is never expanded.
				if (depth > 0 || !opts.approvedEmbeds.has(dest.path)) {
					if (depth === 0) pending.add(dest.path);
					return PLACEHOLDER;
				}
				const inner = await this.app.vault.read(dest);
				const info = getFrontMatterInfo(inner);
				let text = info.exists ? inner.slice(info.contentStart) : inner;
				if (subpath) text = extractSubpath(text, subpath);
				if (!text.trim()) return PLACEHOLDER;
				text = await transform(text, dest, depth + 1);
				included.add(dest.path);
				deps.add(dest.path);
				const heading = subpath && !subpath.startsWith("^") ? ` › ${subpath}` : "";
				const quoted = text.trim().split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
				return `\n\n> [!embed] ${dest.basename}${heading}\n${quoted}\n\n`;
			}

			skipped.push(RAW_EXT.has(ext)
				? `${dest.name}: browsers cannot show this photo format (${ext.toUpperCase()}). Export it as JPG or PNG to publish it`
				: `${dest.name}: this file type cannot be published yet`);
			return PLACEHOLDER;
		};

		const transform = (md: string, source: TFile, depth: number): Promise<string> =>
			mapOutsideCode(md, async (text) => {
				// Obsidian comments are private by definition; block ids are internal anchors.
				text = text.replace(/%%[\s\S]*?%%/g, "").replace(/[ \t]\^[A-Za-z0-9-]+[ \t]*$/gm, "");
				// ![[file]]  ![[file|alt]]  ![[image.png|300]]  ![[note#heading]]
				text = await replaceAsync(text, /!\[\[([^\]\n]+?)\]\]/g, async (m) => {
					const [target, ...rest] = m[1].split("|");
					const tail = rest.join("|").trim();
					const size = tail.match(/^(\d{1,4})(?:x\d{1,4})?$/);
					return renderEmbed(target, size ? "" : tail, size?.[1], source, depth);
				});
				// ![alt](local/path.png) — remote images are left as they are.
				text = await replaceAsync(text, /!\[([^\]\n]*)\]\((<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\)/g, async (m) => {
					const destRaw = m[2].replace(/^<|>$/g, "");
					if (/^(https?:|data:|linvau-asset:)/i.test(destRaw)) return m[0];
					let decoded = destRaw;
					try { decoded = decodeURIComponent(destRaw); } catch { /* keep as written */ }
					const [alt, w] = m[1].split("|");
					return renderEmbed(decoded, alt ?? "", /^\d{1,4}$/.test(w ?? "") ? w : undefined, source, depth);
				});
				return text;
			});

		const markdown = await transform(body, file, 0);
		const panel = await this.buildPanel(props, file, opts, useAsset, skipped);
		const hash = await sha256Hex(`${title}\n\u0000\n${markdown}\n\u0000\n${JSON.stringify(panel)}`);

		return {
			title, markdown, hash,
			bytes: new TextEncoder().encode(markdown).length,
			assets: [...assets.values()],
			panel,
			pendingEmbeds: [...pending],
			includedEmbeds: [...included],
			skipped,
			deps: [...deps],
		};
	}

	/**
	 * Side panel items, declared by the author in the note's properties:
	 *
	 *   linvau-panel:
	 *     - https://www.figma.com/design/…
	 *     - Demo video | https://youtu.be/…
	 *     - "[[plan.png]]"
	 *     - "Budget | [[Budget 2027]]"      (only if that note is published too)
	 *
	 * The nested form `linvau: { panel: [...] }` is accepted as well.
	 */
	private async buildPanel(
		props: Record<string, unknown>, file: TFile, opts: BuildOptions,
		useAsset: (f: TFile) => Promise<AssetRef | null>, skipped: string[],
	): Promise<PanelInput[]> {
		const nested = props.linvau && typeof props.linvau === "object" ? (props.linvau as Record<string, unknown>).panel : undefined;
		const rawList = nested ?? props["linvau-panel"] ?? props["linvau.panel"];
		if (rawList === undefined || rawList === null) return [];
		const list = Array.isArray(rawList) ? rawList : [rawList];
		const out: PanelInput[] = [];

		for (const entry of list.slice(0, MAX_PANEL_ITEMS)) {
			let title = "";
			let target = "";
			if (typeof entry === "string") {
				const md = entry.match(/^\s*\[([^\]]+)\]\((https:\/\/[^)\s]+)\)\s*$/);
				if (md) { title = md[1]; target = md[2]; }
				else {
					const bar = entry.indexOf(" | ");
					const startsWithLink = /^\s*\[\[/.test(entry);
					if (bar > 0 && !startsWithLink) { title = entry.slice(0, bar).trim(); target = entry.slice(bar + 3).trim(); }
					else target = entry.trim();
				}
			} else if (entry && typeof entry === "object") {
				const o = entry as Record<string, unknown>;
				title = typeof o.title === "string" ? o.title : "";
				target = String(o.url ?? o.link ?? o.file ?? "");
			}
			if (!target) continue;

			const wiki = target.match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]$/);
			if (wiki) {
				const dest = this.app.metadataCache.getFirstLinkpathDest(wiki[1].trim(), file.path);
				if (!dest) { skipped.push(`Side panel: “${wiki[1]}” was not found`); continue; }
				const label = title || wiki[2] || dest.basename;
				const ext = dest.extension.toLowerCase();
				if (ext === "md") {
					const noteId = opts.publishedNoteId(dest.path);
					if (noteId) out.push({ title: label, noteId });
					else skipped.push(`Side panel: “${dest.basename}” is not published, so it is not shown`);
				} else if (IMAGE_EXT.has(ext) || FILE_EXT.has(ext)) {
					if (!opts.assetsEnabled) continue;
					const ref = await useAsset(dest);
					if (ref) out.push({ title: label, asset: ref.hash, ext: ref.ext });
				} else {
					skipped.push(`Side panel: ${dest.name} cannot be published yet`);
				}
			} else if (/^https:\/\//i.test(target)) {
				out.push({ ...(title ? { title } : {}), url: target });
			} else {
				skipped.push(`Side panel: “${target.slice(0, 60)}” is not an https link or a [[file]]`);
			}
		}
		return out;
	}
}
