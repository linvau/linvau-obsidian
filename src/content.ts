import { App, TFile, getFrontMatterInfo, loadMermaid, parseYaml } from "obsidian";

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

export interface AssetRef {
	hash: string; ext: string; path: string; bytes: number; image: boolean;
	/** Generated on this device (a Mermaid diagram or an Excalidraw drawing rendered as SVG/PNG): uploaded from here, not read from the vault. */
	data?: ArrayBuffer;
}
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
	/** Note styles (API 0.7.0): classes the note uses and the snippet CSS that mentions them. */
	style?: NoteStyle;
	/** Language of the note (property linvau-lang), for screen readers and right-to-left scripts. */
	lang?: string;
}

export interface NoteStyle { cssclasses: string[]; classes: string[]; css: string }

export interface BuildOptions {
	assetsEnabled: boolean;
	approvedEmbeds: Set<string>;
	/** Returns the Linvau note id if that vault path is published and active (for side-panel notes). */
	publishedNoteId: (path: string) => string | null;
	/** Send the CSS snippet rules for the classes this note uses. */
	stylesEnabled?: boolean;
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

	/** Rendered diagrams and drawings, by source (Mermaid code, or drawing path + mtime): rendering again on every save would be slow. */
	private generated = new Map<string, { ext: string; data: ArrayBuffer }>();

	constructor(private app: App) {}

	private async generatedRef(key: string, name: string, make: () => Promise<{ ext: string; data: ArrayBuffer } | null>): Promise<AssetRef | null> {
		let g = this.generated.get(key);
		if (!g) {
			const made = await make();
			if (!made) return null;
			g = made;
			if (this.generated.size > 200) this.generated.clear();
			this.generated.set(key, g);
		}
		if (g.data.byteLength > MAX_ASSET_BYTES) return null;
		return { hash: await sha256Hex(g.data), ext: g.ext, path: name, bytes: g.data.byteLength, image: true, data: g.data };
	}

	/**
	 * Mermaid (0.6.0): rendered here with Obsidian's own Mermaid, light theme and plain-text labels so the SVG
	 * works as an image anywhere. The code block is kept (AI assistants read the source) and its info string
	 * points at the published image: ```mermaid linvau-asset:<hash>
	 */
	private async mermaidSvg(code: string): Promise<ArrayBuffer | null> {
		try {
			const mermaid = await loadMermaid();
			const init = `%%{init: {"theme": "default", "htmlLabels": false, "flowchart": {"htmlLabels": false}}}%%\n`;
			const id = `linvau-mmd-${Math.random().toString(36).slice(2)}`;
			const out = await mermaid.render(id, init + code);
			let svg = String(typeof out === "string" ? out : out?.svg ?? "");
			document.getElementById(id)?.remove();
			document.getElementById(`d${id}`)?.remove();
			if (!svg.startsWith("<svg")) return null;
			if (!/xmlns="http:\/\/www.w3.org\/2000\/svg"/.test(svg)) svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
			// HTML entities are not valid in a standalone SVG file.
			svg = svg.replace(/&nbsp;/g, "&#160;").replace(/<br>/g, "<br/>");
			return new TextEncoder().encode(svg).buffer as ArrayBuffer;
		} catch {
			return null;
		}
	}

	private async mermaidBlocks(md: string, add: (ref: AssetRef) => void, skipped: string[], depth: number): Promise<string> {
		if (!/^\s{0,3}(`{3,}|~{3,})\s*mermaid\s*$/im.test(md)) return md;
		const lines = md.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const open = lines[i].match(/^(\s{0,3})(`{3,}|~{3,})\s*mermaid\s*$/i);
			if (!open) {
				const other = lines[i].match(/^\s{0,3}(`{3,}|~{3,})/);
				if (other) { // skip any other code block whole
					let j = i + 1;
					while (j < lines.length && !(lines[j].trim().startsWith(other[1][0].repeat(other[1].length)))) j++;
					i = j;
				}
				continue;
			}
			let j = i + 1;
			while (j < lines.length && !lines[j].trim().startsWith(open[2][0].repeat(open[2].length))) j++;
			const code = lines.slice(i + 1, j).join("\n");
			const ref = await this.generatedRef(`mmd:${code}`, "Mermaid diagram", async () => {
				const data = await this.mermaidSvg(code);
				return data ? { ext: "svg", data } : null;
			});
			if (ref) {
				add(ref);
				lines[i] = `${open[1]}${open[2]}mermaid linvau-asset:${ref.hash}`;
			} else if (depth === 0) {
				skipped.push("Mermaid diagram: could not be rendered on this device (it is published as code)");
			}
			i = j;
		}
		return lines.join("\n");
	}

	/**
	 * Excalidraw (0.6.0): published as an image. An exported SVG/PNG next to the drawing is used if there is one
	 * (Excalidraw's auto-export); otherwise the Excalidraw plugin renders it (SVG, PNG as fallback).
	 */
	isExcalidraw(f: TFile): boolean {
		if (f.extension === "excalidraw" || f.path.endsWith(".excalidraw.md")) return true;
		if (f.extension !== "md") return false;
		const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
		return !!fm && "excalidraw-plugin" in fm;
	}

	async excalidrawImage(f: TFile): Promise<{ file?: TFile; ref?: AssetRef } | null> {
		const dir = f.parent?.path && f.parent.path !== "/" ? `${f.parent.path}/` : "";
		const names = [...new Set([f.basename, f.basename.replace(/\.excalidraw$/, "")])];
		for (const n of names) for (const ext of ["svg", "png"]) {
			const sib = this.app.vault.getAbstractFileByPath(`${dir}${n}.${ext}`);
			if (sib instanceof TFile) return { file: sib };
		}
		const g = window as unknown as { ExcalidrawAutomate?: { getAPI?: () => unknown } };
		const eaRoot = g.ExcalidrawAutomate;
		if (!eaRoot) return null;
		const ea = (eaRoot.getAPI?.() ?? eaRoot) as {
			reset?: () => void;
			createSVG?: (path?: string, embedFont?: boolean, settings?: unknown) => Promise<SVGSVGElement>;
			createPNG?: (path?: string, scale?: number, settings?: unknown) => Promise<Blob>;
		};
		const ref = await this.generatedRef(`exc:${f.path}:${f.stat.mtime}`, f.name, async () => {
			try {
				ea.reset?.();
				const svg = await ea.createSVG?.(f.path, true, { withBackground: true, withTheme: false });
				if (svg?.outerHTML) {
					let text = svg.outerHTML;
					if (!/xmlns=/.test(text)) text = text.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
					return { ext: "svg", data: new TextEncoder().encode(text).buffer as ArrayBuffer };
				}
			} catch { /* try PNG */ }
			try {
				ea.reset?.();
				const png = await ea.createPNG?.(f.path, 2, { withBackground: true, withTheme: false });
				if (png) return { ext: "png", data: await png.arrayBuffer() };
			} catch { /* none */ }
			return null;
		});
		return ref ? { ref } : null;
	}

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
			if (!dest) {
				// Shown in the "Embedded content" dialog, so the author knows why it is missing.
				if (linkpath.trim() && depth === 0) skipped.push(`${linkpath.trim()}: not found in the vault`);
				return PLACEHOLDER;
			}
			const ext = dest.extension.toLowerCase();

			if (this.isExcalidraw(dest)) {
				if (!opts.assetsEnabled) return PLACEHOLDER;
				const img = await this.excalidrawImage(dest);
				const ref = img?.file ? await useAsset(img.file) : img?.ref ?? null;
				if (img?.ref) { assets.set(img.ref.hash, img.ref); deps.add(dest.path); }
				if (!ref) {
					if (depth === 0) skipped.push(`${dest.name}: install the Excalidraw plugin or turn on its SVG auto-export to publish this drawing`);
					return PLACEHOLDER;
				}
				const clean = (s: string) => s.replace(/[[\]\n|]/g, " ").trim();
				return `![${clean(label) || clean(dest.basename.replace(/\.excalidraw$/, ""))}](linvau-asset:${ref.hash}${width ? `#w=${width}` : ""})`;
			}

			if (IMAGE_EXT.has(ext) || FILE_EXT.has(ext)) {
				if (!opts.assetsEnabled) return PLACEHOLDER;
				const ref = await useAsset(dest);
				if (!ref) return PLACEHOLDER;
				// "|" is removed too: the embed may sit inside a table cell.
				const clean = (s: string) => s.replace(/[[\]\n|]/g, " ").trim();
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

		const transform = async (md: string, source: TFile, depth: number): Promise<string> => this.mermaidBlocks(await mapOutsideCode(md, async (text) => {
				// Obsidian and HTML comments are private by definition (never sent); block ids are internal anchors.
				text = text.replace(/%%[\s\S]*?%%/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/[ \t]\^[A-Za-z0-9-]+[ \t]*$/gm, "");
				// ![[file]]  ![[file|alt]]  ![[image.png|300]]  ![[note#heading]]
				text = await replaceAsync(text, /!\[\[([^\]\n]+?)\]\]/g, async (m) => {
					// Inside a table the separator is written "\|" (Obsidian's own rule), so the backslash is not part of the name.
					const [target, ...rest] = m[1].split(/\\?\|/);
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
					const [alt, w] = m[1].split(/\\?\|/);
					return renderEmbed(decoded, alt ?? "", /^\d{1,4}$/.test(w ?? "") ? w : undefined, source, depth);
				});
				// <img src="photo.png"> written as HTML (API 0.6.0 keeps sanitized HTML): the file is published
				// like any other image and the tag points at it. Remote and inline images are left as they are.
				text = await replaceAsync(text, /<img\b[^>]*?\bsrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>"']+))[^>]*>/gi, async (m) => {
					const srcRaw = m[2] ?? m[3] ?? m[4] ?? "";
					if (!srcRaw || /^(https?:|data:|linvau-asset:)/i.test(srcRaw)) return m[0];
					let path = srcRaw;
					try { path = decodeURIComponent(srcRaw); } catch { /* keep as written */ }
					path = path.replace(/^\.?\//, "").split(/[?#]/)[0];
					const byLink = this.app.metadataCache.getFirstLinkpathDest(path, source.path);
					const byPath = this.app.vault.getAbstractFileByPath(path);
					const dest = byLink ?? (byPath instanceof TFile ? byPath : null);
					if (!dest) { if (depth === 0) skipped.push(`${path}: not found in the vault`); return m[0]; }
					if (!IMAGE_EXT.has(dest.extension.toLowerCase())) { if (depth === 0) skipped.push(`${dest.name}: only images can be used in <img>`); return m[0]; }
					if (!opts.assetsEnabled) return m[0];
					const ref = await useAsset(dest);
					return ref ? m[0].replace(m[1], `"linvau-asset:${ref.hash}"`) : m[0];
				});
				return text;
			}), (ref) => { if (opts.assetsEnabled) { assets.set(ref.hash, ref); } }, skipped, depth);

		const markdown = await transform(body, file, 0);
		const panel = await this.buildPanel(props, file, opts, useAsset, skipped);
		const style = opts.stylesEnabled === false ? undefined : await this.buildStyle(props, markdown, file, opts, useAsset, skipped);
		const langProp = props["linvau-lang"];
		const lang = typeof langProp === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(langProp.trim()) ? langProp.trim() : undefined;
		const hash = await sha256Hex(`${title}\n\u0000\n${markdown}\n\u0000\n${JSON.stringify(panel)}${style ? `\n\u0000\n${JSON.stringify(style)}` : ""}${lang ? `\n\u0000\nlang:${lang}` : ""}`);

		return {
			title, markdown, hash,
			bytes: new TextEncoder().encode(markdown).length,
			assets: [...assets.values()],
			panel,
			pendingEmbeds: [...pending],
			includedEmbeds: [...included],
			skipped,
			deps: [...deps],
			...(style ? { style } : {}),
			...(lang ? { lang } : {}),
		};
	}

	/**
	 * Note styles. Obsidian applies enabled CSS snippets to every note; a published note takes only the
	 * snippets that mention a class this note uses (its cssclasses property, or class="…" in its HTML).
	 * Images referenced with url(…) are published like any attachment. The server then keeps only the
	 * rules for those classes, scoped to the note, with an allowlist of properties.
	 */
	private async buildStyle(props: Record<string, unknown>, markdown: string, file: TFile, opts: BuildOptions,
		useAsset: (f: TFile) => Promise<AssetRef | null>, skipped: string[]): Promise<NoteStyle | undefined> {
		const list = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : []).map(String).map((x) => x.trim()).filter((x) => /^[A-Za-z_][\w-]{0,63}$/.test(x));
		const cssclasses = [...new Set([...list(props.cssclasses), ...list(props.cssclass)])].slice(0, 20);
		const html = new Set<string>();
		for (const m of markdown.matchAll(/\bclass\s*=\s*("([^"]*)"|'([^']*)')/gi)) for (const c of list(m[2] ?? m[3])) html.add(c);
		const classes = [...new Set([...cssclasses, ...html])].slice(0, 40);
		if (!classes.length) return undefined;

		const custom = (this.app as unknown as { customCss?: { enabledSnippets?: Set<string> } }).customCss;
		const enabled = [...(custom?.enabledSnippets ?? new Set<string>())];
		const mentions = (css: string) => classes.some((c) => new RegExp(`\\.${c.replace(/[-]/g, "\\-")}(?![\\w-])`).test(css));
		let css = "";
		for (const name of enabled.sort()) {
			const path = `${this.app.vault.configDir}/snippets/${name}.css`;
			try {
				if (!(await this.app.vault.adapter.exists(path))) continue;
				const text = await this.app.vault.adapter.read(path);
				if (!mentions(text)) continue;
				if (css.length + text.length > 200_000) { skipped.push(`snippet ${name}.css: too large to publish with the note`); continue; }
				css += `\n${text}`;
			} catch { /* unreadable snippet: ignored */ }
		}
		// Images used as backgrounds: resolved like note links and published as attachments.
		if (css && opts.assetsEnabled) {
			css = await replaceAsync(css, /url\(\s*(["']?)([^"')]+)\1\s*\)/gi, async (m) => {
				const ref = m[2].trim();
				if (/^(https?:|data:|linvau-asset:|#)/i.test(ref)) return m[0];
				let p = ref;
				try { p = decodeURIComponent(ref); } catch { /* as written */ }
				p = p.replace(/^\.?\//, "").split(/[?#]/)[0];
				const byPath = this.app.vault.getAbstractFileByPath(p);
				const dest = this.app.metadataCache.getFirstLinkpathDest(p, file.path) ?? (byPath instanceof TFile ? byPath : null);
				if (!dest || !IMAGE_EXT.has(dest.extension.toLowerCase())) { skipped.push(`${p} (CSS background): not found in the vault`); return m[0]; }
				const a = await useAsset(dest);
				return a ? `url("linvau-asset:${a.hash}")` : m[0];
			});
		}
		return { cssclasses, classes, css };
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

			const wiki = target.replace(/\\\|/g, "|").match(/^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]$/);
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
