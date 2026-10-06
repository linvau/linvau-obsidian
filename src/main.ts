import { Menu, Notice, Platform, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { ApiError, LinvauApi } from "./api";
import { Logger } from "./logger";
import { LinvauLogView, LOG_VIEW_TYPE } from "./logView";
import { ConfirmModal, LinvauSettingTab } from "./settings";
import { SyncEngine } from "./sync";
import {
	DEFAULT_SETTINGS, LatencySample, MAX_LATENCY_SAMPLES, NoteRecord, PluginData, TOKEN_KEY,
} from "./types";
import { ago, errMsg, fmtMs, percentile } from "./util";
import { ContentBuilder, type BuildOptions, type Payload } from "./content";
import { EmbedsModal } from "./embedsModal";

export default class LinvauPlugin extends Plugin {
	data!: PluginData;
	logger = new Logger();
	api!: LinvauApi;
	sync!: SyncEngine;
	builder!: ContentBuilder;
	/** note path → files its published content depends on (attachments, approved embedded notes). */
	private deps = new Map<string, Set<string>>();
	private lastSkipped = new Map<string, string>();
	private statusEl: HTMLElement | null = null;
	private uiQueued = false;

	async onload() {
		await this.loadState();
		this.logger.entries = [...(this.data.log ?? [])];
		this.logger.verbose = this.data.settings.verbose;
		this.api = new LinvauApi(() => this.data.settings.apiBase, () => this.getToken());
		this.sync = new SyncEngine(this);
		this.builder = new ContentBuilder(this.app);

		this.addSettingTab(new LinvauSettingTab(this.app, this));
		this.registerView(LOG_VIEW_TYPE, (leaf: WorkspaceLeaf) => new LinvauLogView(leaf, this));
		this.addRibbonIcon("radio", "Linvau pilot panel", () => void this.openLogView());

		if (!Platform.isMobile) {
			this.statusEl = this.addStatusBarItem();
			this.statusEl.addClass("mod-clickable", "linvau-status");
			this.registerDomEvent(this.statusEl, "click", () => void this.openLogView());
		}

		this.registerCommands();

		this.registerEvent(this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
			if (file instanceof TFile && file.extension === "md") this.addMenuItems(menu, file);
		}));
		this.registerEvent(this.app.workspace.on("editor-menu", (menu: Menu, _editor, info) => {
			if (info.file instanceof TFile && info.file.extension === "md") this.addMenuItems(menu, info.file);
		}));

		this.registerEvent(this.app.workspace.on("file-open", () => this.refreshUi()));
		this.registerInterval(window.setInterval(() => this.refreshUi(), 30_000));
		this.registerDomEvent(window, "online", () => {
			this.logger.info("back online");
			this.sync.flushAllPending("online");
		});
		this.registerDomEvent(window, "offline", () => this.logger.warn("device went offline"));
		this.registerDomEvent(activeDocument, "visibilitychange", () => {
			if (!Platform.isMobile) return;
			if (activeDocument.visibilityState === "hidden") {
				this.sync.flushNow("app to background");
				void this.saveState();
			} else {
				this.sync.markHeldInBackground();
				this.sync.flushAllPending("app to foreground");
			}
		});

		// Vault events are only registered after the layout is ready, so the initial vault
		// indexing (which fires "create" for every file) is not mistaken for user edits.
		this.app.workspace.onLayoutReady(() => {
			this.registerVaultEvents();
			void this.reconcile();
			void this.ensureLogView();
		});

		this.logger.info(`Linvau pilot ${this.manifest.version} loaded (${this.platformName()})`);
	}

	onunload() {
		void this.saveState();
		this.sync?.unload();
	}

	// ─────────────────────────────── State

	async loadState() {
		const raw = (await this.loadData()) as Partial<PluginData> | null;
		this.data = {
			settings: { ...DEFAULT_SETTINGS, ...(raw?.settings ?? {}) },
			notes: raw?.notes ?? {},
			// Samples from 0.0.1 measured from the first save of a session; they are not comparable.
			latencies: (raw?.latencies ?? [])
				.filter((l) => typeof (l as LatencySample).sinceLastSave === "number")
				// Samples recorded before 0.0.5 had no cause. Anything slower than a minute cannot be a
				// normal online publish (max wait is ≤ 120 s but applies to session length, not to this
				// measure), so it is kept but reported apart instead of silently dropped.
				.map((l) => (!l.cause && raw?.log === undefined && l.sinceLastSave > 60_000 ? { ...l, cause: "legacy-outlier" as const } : l)),
			log: raw?.log ?? [],
		};
	}

	async saveState() {
		this.data.log = this.logger.entries.slice(-200);
		await this.saveData(this.data);
	}

	getToken(): string | null {
		const t = this.app.loadLocalStorage(TOKEN_KEY) as unknown;
		return typeof t === "string" && t ? t : null;
	}

	setToken(token: string | null) {
		this.app.saveLocalStorage(TOKEN_KEY, token);
	}

	recordLatency(s: LatencySample) {
		this.data.latencies.push(s);
		if (this.data.latencies.length > MAX_LATENCY_SAMPLES) {
			this.data.latencies.splice(0, this.data.latencies.length - MAX_LATENCY_SAMPLES);
		}
	}

	notify(msg: string) {
		new Notice(msg, 8000);
	}

	// ─────────────────────────────── Vault API events

	private registerVaultEvents() {
		const { vault, metadataCache } = this.app;

		this.registerEvent(vault.on("modify", (f) => {
			if (!(f instanceof TFile)) return;
			this.sync.markDirty(f.path, "modify");
			this.markDependents(f.path);
		}));

		// Fires after the metadata cache is updated (e.g. title property changed).
		this.registerEvent(metadataCache.on("changed", (f) => this.sync.markDirty(f.path, "metadata")));

		this.registerEvent(vault.on("rename", (f, oldPath) => {
			this.markDependents(oldPath);
			// Approvals follow the embedded note when it is renamed or moved.
			for (const r of Object.values(this.data.notes)) {
				const i = r.approvedEmbeds?.indexOf(oldPath) ?? -1;
				if (i >= 0) r.approvedEmbeds![i] = f.path;
			}
			const rec = this.data.notes[oldPath];
			if (!rec) return;
			delete this.data.notes[oldPath];
			rec.path = f.path;
			this.data.notes[f.path] = rec;
			this.sync.rename(oldPath, f.path);
			this.deps.delete(oldPath);
			this.logger.info(`renamed: ${oldPath} → ${f.path} (link unchanged)`);
			void this.saveState();
			this.api.updatePath(rec.noteId, f.path)
				.catch((e) => this.logger.warn(`could not update path on server: ${errMsg(e)}`));
			// A rename can change the title (basename) → republish.
			this.sync.markDirty(f.path, "rename");
		}));

		this.registerEvent(vault.on("delete", (f) => {
			this.markDependents(f.path);
			const rec = this.data.notes[f.path];
			if (!rec) return;
			this.sync.cancel(f.path);
			rec.state = "ORPHAN";
			void this.saveState();
			this.logger.warn(`local file deleted → pausing link: ${f.path}`);
			this.api.suspend(rec.noteId)
				.then(() => this.logger.info(`link paused on server: ${f.path}`))
				.catch((e) => this.logger.error(`could not pause link on server: ${errMsg(e)}`));
			this.notify(`Linvau: “${f.name}” was deleted, so its link was paused. Restore the file and run “Resume” to reactivate it.`);
			this.refreshUi();
		}));

		this.registerEvent(vault.on("create", (f) => {
			const rec = this.data.notes[f.path];
			if (rec?.state === "ORPHAN") {
				this.logger.info(`file restored: ${f.path} — run “Resume link” to reactivate`);
				this.refreshUi();
			}
		}));
	}

	/** A file that a published note shows (an image, an approved embedded note) changed: republish that note. */
	private markDependents(path: string) {
		for (const [notePath, files] of this.deps) {
			if (files.has(path)) this.sync.markDirty(notePath, "dependency");
		}
	}

	buildOptions(rec: Pick<NoteRecord, "assetsEnabled" | "approvedEmbeds">): BuildOptions {
		return {
			assetsEnabled: rec.assetsEnabled !== false,
			approvedEmbeds: new Set(rec.approvedEmbeds ?? []),
			publishedNoteId: (p) => {
				const r = this.data.notes[p];
				return r && (r.state === "ACTIVE" || r.state === "PUBLISHING") ? r.noteId : null;
			},
		};
	}

	/** Builds what will be published for a note and keeps the author informed about what is left out. */
	async buildFor(file: TFile, rec: NoteRecord): Promise<Payload> {
		const payload = await this.builder.build(file, this.buildOptions(rec));
		this.deps.set(rec.path, new Set(payload.deps));

		const known = new Set(rec.pendingEmbeds ?? []);
		const fresh = payload.pendingEmbeds.filter((p) => !known.has(p));
		rec.pendingEmbeds = payload.pendingEmbeds;
		if (fresh.length) {
			this.logger.warn(`${fresh.length} embedded note(s) not published until you approve them: ${rec.path}`);
			this.notify(`Linvau: ${fresh.length} embedded note(s) in “${file.basename}” are not published. Right-click the note → “Embedded content…” to approve them.`);
		}
		const sig = payload.skipped.join(" | ");
		if (sig && this.lastSkipped.get(rec.path) !== sig) {
			payload.skipped.forEach((m) => this.logger.warn(`not published — ${m}`));
		}
		this.lastSkipped.set(rec.path, sig);
		return payload;
	}

	/** Startup reconciliation: catch changes made while the plugin was not running (other devices, git, external editors). */
	async reconcile() {
		const t0 = Date.now();
		const recs = Object.values(this.data.notes);
		if (!recs.length) return;
		let changed = 0, missing = 0, drift = 0;
		for (const [i, rec] of recs.entries()) {
			const file = this.app.vault.getAbstractFileByPath(rec.path);
			if (!(file instanceof TFile)) {
				if (rec.state !== "ORPHAN") {
					missing++;
					this.logger.warn(`reconcile: file missing locally: ${rec.path}`);
				}
				continue;
			}
			if (rec.state === "SUSPENDED" || rec.state === "ORPHAN") continue;
			try {
				const payload = await this.buildFor(file, rec);
				if (payload.hash !== rec.hash || rec.state !== "ACTIVE") {
					changed++;
					this.sync.markDirty(rec.path, "reconcile");
					this.sync.schedule(rec.path, 1000 + i * 300);
				}
				const remote = await this.api.getNote(rec.noteId);
				if (remote.version !== rec.version || remote.state !== rec.state) {
					drift++;
					this.logger.warn(`reconcile: server has v${remote.version}/${remote.state}, device has v${rec.version}/${rec.state}: ${rec.path}`);
				}
			} catch (e) {
				this.logger.warn(`reconcile check failed for ${rec.path}: ${errMsg(e)}`);
			}
		}
		this.logger.info(`reconcile: ${recs.length} note(s), ${changed} changed offline, ${missing} missing, ${drift} drift — ${fmtMs(Date.now() - t0)}`);
		this.refreshUi();
	}

	// ─────────────────────────────── Commands

	private registerCommands() {
		const withActive = (fn: (f: TFile) => void, needsRecord = false) => (checking: boolean) => {
			const f = this.app.workspace.getActiveFile();
			if (!f || f.extension !== "md") return false;
			if (needsRecord && !this.data.notes[f.path]) return false;
			if (!checking) fn(f);
			return true;
		};

		this.addCommand({ id: "publish-current", name: "Publish current note (or sync now)", icon: "radio",
			checkCallback: withActive((f) => void this.publish(f)) });
		this.addCommand({ id: "copy-link", name: "Copy link of current note", icon: "link",
			checkCallback: withActive((f) => void this.copyLink(this.data.notes[f.path]), true) });
		this.addCommand({ id: "suspend-current", name: "Pause link of current note", icon: "pause",
			checkCallback: withActive((f) => void this.suspend(f), true) });
		this.addCommand({ id: "resume-current", name: "Resume link of current note", icon: "play",
			checkCallback: withActive((f) => void this.resume(f), true) });
		this.addCommand({ id: "regenerate-current", name: "Regenerate link of current note (old link stops working)", icon: "rotate-ccw",
			checkCallback: withActive((f) => this.confirmRegenerate(f), true) });
		this.addCommand({ id: "unpublish-current", name: "Unpublish current note", icon: "x-circle",
			checkCallback: withActive((f) => this.confirmUnpublish(f), true) });
		this.addCommand({ id: "embedded-content", name: "Embedded content of current note…", icon: "layers",
			checkCallback: withActive((f) => void this.openEmbeds(f), true) });
		this.addCommand({ id: "open-panel", name: "Open pilot panel", icon: "radio", callback: () => void this.openLogView() });
		this.addCommand({ id: "sync-all", name: "Sync all published notes", icon: "refresh-cw", callback: () => this.syncAll() });
		this.addCommand({ id: "copy-diagnostics", name: "Copy diagnostics to clipboard", icon: "clipboard-copy",
			callback: () => void this.copyDiagnostics() });
	}

	private confirm(title: string, body: string, cta: string, fn: () => void) {
		new ConfirmModal(this.app, title, body, cta, fn).open();
	}

	confirmRegenerate(f: TFile) {
		this.confirm("Regenerate link?",
			"The current link (and any QR code printed with it) will stop working immediately. A new link will be created.",
			"Regenerate", () => void this.regenerate(f));
	}

	confirmUnpublish(f: { path: string }) {
		this.confirm("Unpublish note?",
			"The link will stop working and all published versions will be removed from the pilot server. Your local note is not touched.",
			"Unpublish", () => void this.unpublish(f));
	}

	/** Context menu (file explorer, tab header and editor right-click). Options depend on the link state. */
	private addMenuItems(menu: Menu, file: TFile) {
		const rec = this.data.notes[file.path];
		const add = (title: string, icon: string, fn: () => void, warning = false) =>
			menu.addItem((i) => {
				i.setSection("linvau").setTitle(title).setIcon(icon).onClick(fn);
				if (warning) i.setWarning(true);
			});

		if (!rec) {
			add("Linvau: publish note", "radio", () => void this.publish(file));
			add("Linvau: open pilot panel", "activity", () => void this.openLogView());
			return;
		}
		// P8: the author sees which version is live right in the menu.
		menu.addItem((i) => i.setSection("linvau").setTitle(`Linvau · v${rec.version} · ${rec.state.toLowerCase()} · ${ago(rec.lastSyncAt)}`)
			.setIcon("info").setDisabled(true));

		if (rec.state === "ORPHAN") {
			add("Linvau: resume link", "play", () => void this.resume(file));
		} else if (rec.state === "SUSPENDED") {
			add("Linvau: copy link", "link", () => void this.copyLink(rec));
			add("Linvau: resume link", "play", () => void this.resume(file));
		} else {
			add("Linvau: sync now", "refresh-cw", () => void this.publish(file));
			add("Linvau: copy link", "link", () => void this.copyLink(rec));
			add("Linvau: pause link", "pause", () => void this.suspend(file));
			const n = rec.pendingEmbeds?.length ?? 0;
			add(`Linvau: embedded content…${n ? ` (${n} pending)` : ""}`, "layers", () => void this.openEmbeds(file));
		}
		add("Linvau: regenerate link…", "rotate-ccw", () => this.confirmRegenerate(file));
		add("Linvau: unpublish…", "x-circle", () => this.confirmUnpublish(file), true);
		add("Linvau: open pilot panel", "activity", () => void this.openLogView());
	}

	async publish(file: TFile) {
		const existing = this.data.notes[file.path];
		if (existing && existing.state !== "ORPHAN") {
			if (existing.state === "SUSPENDED") {
				new Notice("Linvau: this link is paused. Use “Resume link” first.");
				return;
			}
			this.sync.markDirty(file.path, "manual");
			await this.sync.flush(file.path);
			await this.copyLink(existing);
			return;
		}
		try {
			// Look at what the note contains before anything leaves the device.
			const scan = await this.builder.build(file, this.buildOptions({}));
			if (scan.assets.length || scan.pendingEmbeds.length || scan.panel.length || scan.skipped.length) {
				new EmbedsModal(this.app, this, file, { assetsEnabled: true, approvedEmbeds: [] }, "publish",
					(choice) => void this.createAndPublish(file, choice)).open();
			} else {
				await this.createAndPublish(file, { assetsEnabled: true, approvedEmbeds: [] });
			}
		} catch (e) {
			this.logger.error(`publish failed: ${errMsg(e)}`);
			new Notice(`Linvau: ${errMsg(e)}`);
		}
	}

	private async createAndPublish(file: TFile, choice: { assetsEnabled: boolean; approvedEmbeds: string[] }) {
		try {
			const created = await this.api.createNote(file.path, file.basename);
			const rec: NoteRecord = {
				noteId: created.noteId, shareId: created.shareId, url: created.url, path: file.path,
				state: "PUBLISHING", version: 0, hash: null, lastSyncAt: null,
				assetsEnabled: choice.assetsEnabled, approvedEmbeds: choice.approvedEmbeds,
				// Embeds the author just saw in the dialog and left unchecked need no second notice.
				pendingEmbeds: (await this.builder.build(file, this.buildOptions(choice))).pendingEmbeds,
			};
			this.data.notes[file.path] = rec;
			await this.saveState();
			this.logger.info(`published new note: ${file.path}`);
			this.sync.markDirty(file.path, "publish");
			await this.sync.flush(file.path);
			await this.copyLink(rec);
		} catch (e) {
			this.logger.error(`publish failed: ${errMsg(e)}`);
			new Notice(`Linvau: ${errMsg(e)}`);
		}
	}

	/** Review what a published note brings along: attachments, embedded notes, side panel. */
	async openEmbeds(file: TFile) {
		const rec = this.data.notes[file.path];
		if (!rec) return;
		new EmbedsModal(this.app, this, file,
			{ assetsEnabled: rec.assetsEnabled !== false, approvedEmbeds: rec.approvedEmbeds ?? [] }, "manage",
			(choice) => {
				rec.assetsEnabled = choice.assetsEnabled;
				rec.approvedEmbeds = choice.approvedEmbeds;
				this.logger.info(`embedded content updated (${choice.approvedEmbeds.length} note(s) approved, attachments ${choice.assetsEnabled ? "on" : "off"}): ${file.path}`);
				void this.saveState();
				this.sync.markDirty(file.path, "embeds");
				void this.sync.flush(file.path);
			}).open();
	}

	async copyLink(rec: NoteRecord | undefined) {
		if (!rec) return;
		try {
			await navigator.clipboard.writeText(rec.url);
			new Notice(`Linvau: link copied — v${rec.version}, ${rec.state.toLowerCase()}`);
		} catch {
			new Notice(`Linvau link: ${rec.url}`, 10_000);
		}
	}

	async suspend(file: TFile) {
		const rec = this.data.notes[file.path];
		if (!rec) return;
		try {
			const t0 = Date.now();
			await this.api.suspend(rec.noteId);
			this.sync.cancel(file.path);
			rec.state = "SUSPENDED";
			await this.saveState();
			this.logger.info(`link paused in ${fmtMs(Date.now() - t0)} (server ack): ${file.path}`);
			new Notice("Linvau: link paused. Readers now see “paused by the author”.");
		} catch (e) {
			new Notice(`Linvau: ${errMsg(e)}`);
		}
		this.refreshUi();
	}

	async resume(file: TFile) {
		const rec = this.data.notes[file.path];
		if (!rec) return;
		try {
			await this.api.resume(rec.noteId);
			rec.state = "ACTIVE";
			await this.saveState();
			this.logger.info(`link resumed: ${file.path}`);
			this.sync.markDirty(file.path, "resume");
			await this.sync.flush(file.path);
			new Notice("Linvau: link active again (same link and QR).");
		} catch (e) {
			new Notice(`Linvau: ${errMsg(e)}`);
		}
		this.refreshUi();
	}

	async regenerate(file: TFile) {
		const rec = this.data.notes[file.path];
		if (!rec) return;
		try {
			const res = await this.api.regenerate(rec.noteId);
			this.logger.info(`link regenerated (old share id ${rec.shareId} revoked): ${file.path}`);
			rec.shareId = res.shareId;
			rec.url = res.url;
			await this.saveState();
			await this.copyLink(rec);
		} catch (e) {
			new Notice(`Linvau: ${errMsg(e)}`);
		}
	}

	/** Works by path, so links whose local file was deleted (ORPHAN) can still be removed. */
	async unpublish(file: { path: string }) {
		const rec = this.data.notes[file.path];
		if (!rec) return;
		try {
			await this.api.remove(rec.noteId);
		} catch (e) {
			if (!(e instanceof ApiError && e.status === 404)) {
				new Notice(`Linvau: ${errMsg(e)}`);
				return;
			}
		}
		this.sync.cancel(file.path);
		delete this.data.notes[file.path];
		await this.saveState();
		this.logger.info(`unpublished: ${file.path}`);
		new Notice("Linvau: note unpublished.");
		this.refreshUi();
	}

	syncAll() {
		const paths = Object.values(this.data.notes).filter((n) => n.state !== "SUSPENDED" && n.state !== "ORPHAN").map((n) => n.path);
		paths.forEach((p, i) => {
			this.sync.markDirty(p, "sync-all");
			this.sync.schedule(p, 300 * i);
		});
		this.logger.info(`sync all: ${paths.length} note(s) queued`);
	}

	// ─────────────────────────────── Diagnostics (exported manually by the author; no telemetry)

	async copyDiagnostics() {
		const normal = this.data.latencies.filter((s) => !s.cause);
		const delayed = this.data.latencies.filter((s) => s.cause);
		const since = normal.map((s) => s.sinceLastSave);
		const session = normal.map((s) => s.sinceFirstSave);
		const api = this.data.latencies.map((s) => s.api);
		const byCause: Record<string, { count: number; max: number }> = {};
		for (const d of delayed) {
			const c = (byCause[d.cause!] ??= { count: 0, max: 0 });
			c.count++;
			c.max = Math.max(c.max, d.sinceLastSave);
		}
		const diag = {
			generatedAt: new Date().toISOString(),
			plugin: this.manifest.version,
			platform: this.platformName(),
			online: navigator.onLine,
			settings: {
				apiBase: this.data.settings.apiBase, debounceSeconds: this.data.settings.debounceSeconds,
				maxWaitSeconds: this.data.settings.maxWaitSeconds, tokenSet: !!this.getToken(),
			},
			latency: {
				samples: since.length,
				afterLastSaveP50: percentile(since, 50), afterLastSaveP95: percentile(since, 95), afterLastSaveMax: since.length ? Math.max(...since) : null,
				sessionP95: percentile(session, 95),
				delayedByCause: byCause,
				apiP50: percentile(api, 50), apiP95: percentile(api, 95),
			},
			notes: Object.values(this.data.notes).map((n) => ({
				path: n.path, state: n.state, version: n.version, lastSync: ago(n.lastSyncAt), lastError: n.lastError ?? null,
				attachments: n.assetsEnabled !== false, approvedEmbeds: n.approvedEmbeds?.length ?? 0, pendingEmbeds: n.pendingEmbeds?.length ?? 0,
			})),
			log: this.logger.entries.slice(-200).map((e) => `${new Date(e.ts).toISOString()} ${e.level.toUpperCase()} ${e.msg}`),
		};
		try {
			await navigator.clipboard.writeText(JSON.stringify(diag, null, 2));
			new Notice("Linvau: diagnostics copied to clipboard.");
		} catch (e) {
			new Notice(`Linvau: could not copy (${errMsg(e)})`);
		}
	}

	async clearDiagnostics() {
		this.data.latencies = [];
		this.logger.clear();
		await this.saveState();
	}

	platformName(): string {
		if (Platform.isIosApp) return "iOS";
		if (Platform.isAndroidApp) return "Android";
		if (Platform.isMacOS) return "macOS";
		if (Platform.isWin) return "Windows";
		if (Platform.isLinux) return "Linux";
		return "unknown";
	}

	// ─────────────────────────────── UI

	/**
	 * Keeps the pilot panel available in the right sidebar without opening it. On phones the
	 * sidebar's view list is the main way to reach it, and a view only appears there once it exists.
	 */
	private async ensureLogView() {
		// When the plugin is updated or re-enabled, a panel saved in the workspace takes a moment to
		// come back. Checking too early would not see it and would add a second one.
		await new Promise((r) => window.setTimeout(r, 2000));
		const leaves = this.app.workspace.getLeavesOfType(LOG_VIEW_TYPE);
		leaves.slice(1).forEach((l) => l.detach());   // also cleans up duplicates left by 0.1.1
		if (leaves.length) return;
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) await leaf.setViewState({ type: LOG_VIEW_TYPE, active: false });
	}

	async openLogView() {
		const existing = this.app.workspace.getLeavesOfType(LOG_VIEW_TYPE)[0];
		if (existing) {
			void this.app.workspace.revealLeaf(existing);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (!leaf) return;
		await leaf.setViewState({ type: LOG_VIEW_TYPE, active: true });
		void this.app.workspace.revealLeaf(leaf);
	}

	refreshUi() {
		if (this.uiQueued) return;
		this.uiQueued = true;
		window.setTimeout(() => {
			this.uiQueued = false;
			this.updateStatusBar();
			for (const leaf of this.app.workspace.getLeavesOfType(LOG_VIEW_TYPE)) {
				(leaf.view as LinvauLogView).requestRender?.();
			}
		}, 100);
	}

	/** PRD principle P8: the author always knows which version is live. */
	private updateStatusBar() {
		if (!this.statusEl) return;
		const f = this.app.workspace.getActiveFile();
		const rec = f ? this.data.notes[f.path] : undefined;
		if (!f || !rec) {
			this.statusEl.setText("");
			this.statusEl.toggle(false);
			return;
		}
		this.statusEl.toggle(true);
		let text: string;
		if (this.sync.isInFlight(f.path)) text = "Linvau · publishing…";
		else if (rec.state === "SUSPENDED") text = `Linvau · paused · v${rec.version}`;
		else if (rec.state === "ORPHAN") text = "Linvau · file was deleted · link paused";
		else if (rec.state === "ERROR") text = `Linvau · error · v${rec.version} live`;
		else if (this.sync.isDirty(f.path)) text = `Linvau · v${rec.version} live · changes pending`;
		else text = `Linvau · v${rec.version} · ${ago(rec.lastSyncAt)}`;
		const pending = rec.pendingEmbeds?.length ?? 0;
		if (pending && rec.state !== "ORPHAN") text += ` · ${pending} embed${pending > 1 ? "s" : ""} pending`;
		this.statusEl.setText(text);
		this.statusEl.setAttr("aria-label", rec.lastError ?? rec.url);
	}
}
