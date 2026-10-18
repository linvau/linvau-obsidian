/*
 * M0 spike P-06, path A: export Excalidraw drawings to SVG/PNG through the Excalidraw plugin's
 * public scripting API (ExcalidrawAutomate) and measure time, size and self-containment
 * on each device. Pilot-only code: it adds two commands, touches nothing else, writes only inside
 * the "Linvau spike" folder and sends nothing over the network.
 */
import { App, Notice, Platform, TFile, TFolder, apiVersion, normalizePath } from "obsidian";

export const SPIKE_FOLDER = "Linvau spike";
const OUT_FOLDER = `${SPIKE_FOLDER}/out`;
const REPORT_FOLDER = `${SPIKE_FOLDER}/reports`;
const EXCALIDRAW_ID = "obsidian-excalidraw-plugin";
const RUNS = 3;            // run 1 = cold (fonts and images loading), runs 2..3 = warm
const PNG_SCALE = 2;       // 2x for sharp text on high-density screens
const TIMEOUT_MS = 60_000;
const MAX_DRAWINGS = 10;
const SLOW_MS = 5_000;     // flagged in the report as too slow to run on every publish

type Format = "svg" | "png";

interface Sample {
	drawing: string;
	format: Format;
	run: number;
	ms: number | null;
	bytes: number | null;
	images: number | null;   // <image> elements inside the SVG
	external: number | null; // images not inlined as data: URIs (would break in the reader)
	heapMb: number | null;   // JS heap after the export, where the platform exposes it
	error?: string;
}

/** What the production plugin would check before choosing path A or the auto-export fallback. */
export interface ExcalidrawProbe {
	installed: boolean;
	enabled: boolean;
	version: string | null;
	api: Record<string, boolean>;
	usable: boolean;
	reason: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const REQUIRED_API = ["createSVG", "createPNG"];
const OPTIONAL_API = ["getAPI", "isExcalidrawFile", "destroy", "verifyMinimumPluginVersion"];

function excalidrawPlugin(app: App): Any | null {
	return (app as Any).plugins?.plugins?.[EXCALIDRAW_ID] ?? null;
}

function globalEA(): Any | null {
	return (window as Any).ExcalidrawAutomate ?? null;
}

export function probeExcalidraw(app: App): ExcalidrawProbe {
	const plugins = (app as Any).plugins;
	const installed = !!plugins?.manifests?.[EXCALIDRAW_ID];
	const plugin = excalidrawPlugin(app);
	const enabled = !!plugin;
	const version: string | null = plugin?.manifest?.version ?? plugins?.manifests?.[EXCALIDRAW_ID]?.version ?? null;
	const g = globalEA() ?? plugin?.ea ?? null;
	const api: Record<string, boolean> = {};
	for (const k of [...REQUIRED_API, ...OPTIONAL_API]) api[k] = typeof g?.[k] === "function";
	let reason = "ok";
	if (!installed) reason = "Excalidraw plugin not installed";
	else if (!enabled) reason = "Excalidraw plugin installed but disabled";
	else if (!g) reason = "ExcalidrawAutomate not found";
	else {
		const missing = REQUIRED_API.filter((k) => !api[k]);
		if (missing.length) reason = `API changed: missing ${missing.join(", ")}`;
	}
	return { installed, enabled, version, api, usable: reason === "ok", reason };
}

export function isDrawing(app: App, f: TFile): boolean {
	if (f.extension === "excalidraw" || f.path.endsWith(".excalidraw.md")) return true;
	if (f.extension !== "md") return false;
	const fm = app.metadataCache.getFileCache(f)?.frontmatter;
	return !!fm && Object.prototype.hasOwnProperty.call(fm, "excalidraw-plugin");
}

/** A fresh ExcalidrawAutomate instance per export, so no state leaks between runs. */
function newEA(): { ea: Any; done: () => void } {
	const g = globalEA();
	if (!g) throw new Error("ExcalidrawAutomate not found");
	const ea = typeof g.getAPI === "function" ? g.getAPI() : g;
	if (ea === g && typeof g.reset === "function") g.reset();
	return {
		ea,
		done: () => {
			if (ea !== g && typeof ea.destroy === "function") {
				try { ea.destroy(); } catch { /* ignore */ }
			}
		},
	};
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const t = window.setTimeout(() => reject(new Error(`timeout after ${ms / 1000} s`)), ms);
		p.then((v) => { window.clearTimeout(t); resolve(v); }, (e) => { window.clearTimeout(t); reject(e); });
	});
}

function heapMb(): number | null {
	const m = (performance as Any).memory;
	return m?.usedJSHeapSize ? Math.round(m.usedJSHeapSize / 1048576) : null;
}

function svgStats(svg: Element): { images: number; external: number } {
	const imgs = Array.from(svg.querySelectorAll("image"));
	const external = imgs.filter((i) => {
		const href = i.getAttribute("href") ?? i.getAttribute("xlink:href") ?? "";
		return href !== "" && !href.startsWith("data:");
	}).length;
	return { images: imgs.length, external };
}

export function deviceName(): string {
	if (Platform.isIosApp) return (Platform as Any).isTablet ? "iPad" : "iPhone";
	if (Platform.isAndroidApp) return (Platform as Any).isTablet ? "Android tablet" : "Android";
	if (Platform.isMacOS) return "Mac";
	if (Platform.isWin) return "Windows";
	if (Platform.isLinux) return "Linux";
	return Platform.isMobile ? "Mobile" : "Desktop";
}

function stamp(d = new Date()): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`;
}

function median(xs: number[]): number | null {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

const kb = (n: number | null) => (n === null ? "—" : `${(n / 1024).toFixed(1)} KB`);
const ms = (n: number | null) => (n === null ? "—" : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);

async function ensureFolder(app: App, path: string) {
	const parts = normalizePath(path).split("/");
	let cur = "";
	for (const part of parts) {
		cur = cur ? `${cur}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(cur)) {
			try { await app.vault.createFolder(cur); } catch { /* created concurrently */ }
		}
	}
}

async function writeText(app: App, path: string, text: string) {
	const f = app.vault.getAbstractFileByPath(path);
	if (f instanceof TFile) await app.vault.modify(f, text);
	else await app.vault.create(path, text);
}

async function writeBinary(app: App, path: string, data: ArrayBuffer) {
	const f = app.vault.getAbstractFileByPath(path);
	if (f instanceof TFile) await app.vault.modifyBinary(f, data);
	else await app.vault.createBinary(path, data);
}

function outBase(f: TFile): string {
	return f.name.replace(/\.excalidraw\.md$/, "").replace(/\.(excalidraw|md)$/, "");
}

export class ExcalidrawSpike {
	private running = false;

	constructor(private app: App, private log: (level: "info" | "warn" | "error", msg: string) => void, private pluginVersion: string) {}

	drawingsInSpikeFolder(): TFile[] {
		const folder = this.app.vault.getAbstractFileByPath(SPIKE_FOLDER);
		if (!(folder instanceof TFolder)) return [];
		return folder.children
			.filter((c): c is TFile => c instanceof TFile && isDrawing(this.app, c))
			.sort((a, b) => a.name.localeCompare(b.name))
			.slice(0, MAX_DRAWINGS);
	}

	async run(files: TFile[]): Promise<string | null> {
		if (this.running) { new Notice("Linvau spike: a test is already running."); return null; }
		const probe = probeExcalidraw(this.app);
		if (!files.length) {
			new Notice(`Linvau spike: no drawings found. Put the test drawings in the "${SPIKE_FOLDER}" folder.`);
			return null;
		}
		this.running = true;
		const samples: Sample[] = [];
		const started = Date.now();
		const total = files.length * 2 * RUNS;
		const notice = new Notice("Linvau spike: starting…", 0);
		try {
			if (probe.usable) {
				await ensureFolder(this.app, OUT_FOLDER);
				let n = 0;
				for (const file of files) {
					for (const format of ["svg", "png"] as Format[]) {
						for (let run = 1; run <= RUNS; run++) {
							n++;
							notice.setMessage(`Linvau spike: ${file.basename} · ${format.toUpperCase()} · run ${run}/${RUNS} (${n}/${total})`);
							const s = await this.exportOnce(file, format, run, run === RUNS);
							samples.push(s);
							if (s.error) this.log("warn", `spike ${file.path} ${format} run ${run}: ${s.error}`);
							// Yield so the UI stays responsive between exports on mobile.
							await new Promise((r) => window.setTimeout(r, 50));
						}
					}
				}
			} else {
				this.log("warn", `spike: path A not usable — ${probe.reason}`);
			}
			const report = this.buildReport(probe, files, samples, Date.now() - started);
			await ensureFolder(this.app, REPORT_FOLDER);
			const path = normalizePath(`${REPORT_FOLDER}/Excalidraw A - ${deviceName()} - ${stamp()}.md`);
			await writeText(this.app, path, report);
			this.log("info", `spike report written: ${path}`);
			notice.hide();
			new Notice(probe.usable ? "Linvau spike: done. Report opened." : `Linvau spike: path A not usable (${probe.reason}). Report opened.`);
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile) await this.app.workspace.getLeaf(true).openFile(f);
			return path;
		} catch (e) {
			notice.hide();
			const msg = e instanceof Error ? e.message : String(e);
			this.log("error", `spike failed: ${msg}`);
			new Notice(`Linvau spike failed: ${msg}`);
			return null;
		} finally {
			this.running = false;
		}
	}

	private async exportOnce(file: TFile, format: Format, run: number, save: boolean): Promise<Sample> {
		const s: Sample = { drawing: file.path, format, run, ms: null, bytes: null, images: null, external: null, heapMb: null };
		let handle: { ea: Any; done: () => void } | null = null;
		try {
			handle = newEA();
			const t0 = performance.now();
			if (format === "svg") {
				const svg: SVGSVGElement = await withTimeout(handle.ea.createSVG(file.path, true), TIMEOUT_MS);
				s.ms = Math.round(performance.now() - t0);
				const text = new XMLSerializer().serializeToString(svg);
				s.bytes = new TextEncoder().encode(text).length;
				Object.assign(s, svgStats(svg));
				if (save) await writeText(this.app, normalizePath(`${OUT_FOLDER}/${outBase(file)}.A.svg`), text);
			} else {
				const png: Blob = await withTimeout(handle.ea.createPNG(file.path, PNG_SCALE), TIMEOUT_MS);
				s.ms = Math.round(performance.now() - t0);
				s.bytes = png.size;
				if (save) await writeBinary(this.app, normalizePath(`${OUT_FOLDER}/${outBase(file)}.A.png`), await png.arrayBuffer());
			}
			s.heapMb = heapMb();
		} catch (e) {
			s.error = e instanceof Error ? e.message : String(e);
		} finally {
			handle?.done();
		}
		return s;
	}

	buildReport(probe: ExcalidrawProbe, files: TFile[], samples: Sample[], elapsed: number): string {
		const L: string[] = [];
		L.push(`# Excalidraw path A — ${deviceName()} — ${stamp()}`, "");
		L.push("## Environment", "");
		L.push(`- Device: ${deviceName()}${Platform.isMobile ? " (mobile app)" : " (desktop app)"}`);
		L.push(`- Obsidian API: ${apiVersion}`);
		L.push(`- Linvau plugin: ${this.pluginVersion}`);
		L.push(`- Excalidraw plugin: ${probe.version ?? "not installed"} (${probe.enabled ? "enabled" : "disabled"})`);
		L.push(`- Runs per format: ${RUNS} (run 1 = cold) · PNG scale: ${PNG_SCALE}x · timeout: ${TIMEOUT_MS / 1000} s`);
		L.push(`- Total time: ${ms(elapsed)}`, "");
		L.push("## API check (step 4)", "");
		L.push(`- Result: **${probe.usable ? "usable" : "NOT usable"}** — ${probe.reason}`);
		L.push(`- Functions: ${Object.entries(probe.api).map(([k, v]) => `${k} ${v ? "✓" : "✗"}`).join(" · ")}`, "");

		L.push("## Summary", "");
		L.push("| Drawing | Source | Format | Cold | Warm (median) | Size | Images | Not inlined | Heap | Errors |");
		L.push("|---|---|---|---|---|---|---|---|---|---|");
		for (const f of files) {
			for (const format of ["svg", "png"] as Format[]) {
				const rows = samples.filter((s) => s.drawing === f.path && s.format === format);
				if (!rows.length) continue;
				const ok = rows.filter((r) => r.ms !== null);
				const cold = rows.find((r) => r.run === 1)?.ms ?? null;
				const warm = median(ok.filter((r) => r.run > 1).map((r) => r.ms as number));
				const last = [...ok].reverse()[0];
				const errs = rows.filter((r) => r.error).length;
				const slow = (cold ?? 0) > SLOW_MS || (warm ?? 0) > SLOW_MS ? " ⚠" : "";
				L.push(`| ${outBase(f)} | ${kb(f.stat.size)} | ${format.toUpperCase()} | ${ms(cold)}${slow} | ${ms(warm)} | ${kb(last?.bytes ?? null)} | ${format === "svg" ? last?.images ?? "—" : "—"} | ${format === "svg" ? last?.external ?? "—" : "—"} | ${last?.heapMb != null ? `${last.heapMb} MB` : "—"} | ${errs ? `${errs}/${rows.length}` : "0"} |`);
			}
		}
		L.push("");
		L.push(`⚠ = over ${SLOW_MS / 1000} s. "Not inlined" must be 0: an image referenced by path would not load in the reader.`, "");

		const errors = samples.filter((s) => s.error);
		if (errors.length) {
			L.push("## Errors", "");
			for (const e of errors) L.push(`- ${e.drawing} · ${e.format} · run ${e.run}: ${e.error}`);
			L.push("");
		}

		if (samples.length) {
			L.push("## Visual check", "");
			L.push(`The last run of each export was saved in \`${OUT_FOLDER}\`. Embed them in a test note and publish it to compare with path B:`, "");
			for (const f of files) {
				L.push(`- \`![[${OUT_FOLDER}/${outBase(f)}.A.svg]]\` · \`![[${OUT_FOLDER}/${outBase(f)}.A.png]]\``);
			}
			L.push("");
		}

		L.push("## Raw data", "", "```json");
		L.push(JSON.stringify({ device: deviceName(), obsidian: apiVersion, linvau: this.pluginVersion, probe, samples }, null, 1));
		L.push("```", "");
		return L.join("\n");
	}
}
