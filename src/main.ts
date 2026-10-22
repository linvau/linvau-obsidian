import { Menu, Notice, Platform, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { ApiError, LinvauApi, isAuthLost, type RemoteNote } from "./api";
import { ChoiceModal } from "./choiceModal";
import { Logger } from "./logger";
import { LinvauLogView, LOG_VIEW_TYPE } from "./logView";
import { ConfirmModal, LinvauSettingTab } from "./settings";
import { SyncEngine } from "./sync";
import {
	DEFAULT_API_BASE, DEFAULT_SETTINGS, LatencySample, MAX_LATENCY_SAMPLES, NoteRecord, PluginData,
} from "./types";
import { ago, errMsg, fmtMs, percentile } from "./util";
import { ContentBuilder, type BuildOptions, type Payload } from "./content";
import { EmbedsModal } from "./embedsModal";
import { LEGACY_TOKEN_KEY, Session } from "./session";
import { ConnectModal, connectedNotice } from "./connectModal";

/** How long a removed file may stay away before its link is paused (sync tools replace files as delete + create). */
const DELETE_GRACE_MS = 5 * 60_000;
/** How long to wait for the vault sync to bring a newer version from another device before asking the author. */
const CONFLICT_WAIT_MS = 10 * 60_000;
const CONFLICT_RECHECK_MS = 60_000;
const REGISTRY_INTERVAL_MS = 5 * 60_000;

export default class LinvauPlugin extends Plugin {
	data!: PluginData;
	logger = new Logger();
	api!: LinvauApi;
	session!: Session;
	private connecting: Promise<boolean> | null = null;
	private authLostNotified = false;
	private lastNotConnectedHint = 0;
	/** Files that disappeared: the link is paused only if they do not come back within the grace period. */
	private pendingDeletes = new Map<string, number>();
	private registryRun: Promise<void> | null = null;
	/** Last answer of the account's note list (all devices and vaults). Null until the first successful read. */
	accountNotes: RemoteNote[] | null = null;
	accountCheckedAt: number | null = null;
	private lastRegistrySummary = "";
	private lastConflictNotice = new Map<string, number>();
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
		this.api = new LinvauApi(() => this.apiBase());
		this.session = new Session(this.app, this.api, (level, msg) => this.logger[level](msg));
		this.api.tokens = this.session;
		this.register(this.session.onChange(() => this.refreshUi()));
		// 0.1.5: the fixed pilot token is replaced by an account; remove it from this device.
		if (this.app.loadLocalStorage(LEGACY_TOKEN_KEY)) {
			this.app.saveLocalStorage(LEGACY_TOKEN_KEY, null);
			this.logger.info("pilot token removed from this device; connect with your email to publish");
		}
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

		this.registerEvent(this.app.workspace.on("file-open", (f) => {
			this.refreshUi();
			this.hintIfNotConnected(f);
		}));
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
			void this.syncRegistry("startup").then(() => this.reconcile());
			void this.ensureLogView();
			// Other devices may publish, rename or unpublish notes: refresh the shared registry regularly.
			this.registerInterval(window.setInterval(() => void this.syncRegistry("periodic"), REGISTRY_INTERVAL_MS));
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
		// 0.1.8: the server address is built in. A stored copy of it is dropped so future defaults apply.
		const stored = this.data.settings.apiBase.trim().replace(/\/+$/, "");
		this.data.settings.apiBase = stored === DEFAULT_API_BASE ? "" : stored;
	}

	/** The server this device talks to: the built-in one unless a development URL is set. */
	apiBase(): string {
		return this.data.settings.apiBase || DEFAULT_API_BASE;
	}

	async saveState() {
		this.data.log = this.logger.entries.slice(-200);
		await this.saveData(this.data);
	}

	// ─────────────────────────────── Account (PRD 2.4: account at the first publish, login with an emailed code)

	/** Resolves true when this device has a session, asking the author to connect if needed. */
	ensureConnected(reason: string | null = null): Promise<boolean> {
		if (this.session.connected) return Promise.resolve(true);
		if (this.connecting) return this.connecting;
		this.connecting = new Promise<boolean>((resolve) => {
			new ConnectModal(this.app, this.api, this.deviceInfo(), reason, (r) => {
				this.connecting = null;
				if (!r) { resolve(false); return; }
				this.session.start(r);
				this.authLostNotified = false;
				this.logger.info(`connected this device (${r.device.name})${r.claimedNotes ? `; ${r.claimedNotes} pilot note(s) moved to the account` : ""}`);
				connectedNotice(r);
				// Link notes published from other devices, then send what could not sync while disconnected.
				void this.syncRegistry("connected").then(() => this.syncAll());
				resolve(true);
			}).open();
		});
		return this.connecting;
	}

	confirmDisconnect() {
		if (!this.session.connected) { new Notice("Linvau: this device is not connected."); return; }
		this.confirm("Disconnect this device?",
			"Links you published stay online. This device stops syncing until you connect it again.",
			"Disconnect", () => void this.disconnect());
	}

	async disconnect() {
		try { await this.api.logout(); } catch (e) { this.logger.warn(`logout request failed (${errMsg(e)}); the session is removed from this device anyway`); }
		this.session.clear("disconnected by the author");
		this.accountNotes = null;
		new Notice("Linvau: this device is disconnected.");
	}

	/** Called by the sync engine when the server says this device has no valid session. */
	onAuthLost(code?: string) {
		// The server no longer accepts this device: forget the session so the UI shows "not connected".
		if (code && code !== "not_connected") this.session.clear(code);
		if (this.authLostNotified) return;
		this.authLostNotified = true;
		this.notify("Linvau: this device is no longer connected, so changes are not being published. Run “Linvau: Connect this device”.");
	}

	/**
	 * Mobile has no status bar: when a published note is opened on a device without a session,
	 * say so (at most every 10 minutes) so edits are not silently left unpublished.
	 */
	private hintIfNotConnected(f: TFile | null) {
		if (!f || this.session.connected || !this.data.notes[f.path]) return;
		const rec = this.data.notes[f.path];
		if (rec.state === "SUSPENDED" || rec.state === "ORPHAN") return;
		if (Date.now() - this.lastNotConnectedHint < 10 * 60_000) return;
		this.lastNotConnectedHint = Date.now();
		new Notice("Linvau: this device is not connected, so edits to this note are not published. Run “Linvau: Connect this device”.", 8000);
	}

	// ─────────────────────────────── Shared registry (T-1 / D-59): the server knows every published note

	/** Notes published from other devices become known here; renames and unpublishes are mirrored. */
	syncRegistry(reason: string): Promise<void> {
		if (!this.session.connected) return Promise.resolve();
		if (this.registryRun) return this.registryRun;
		this.registryRun = this.doSyncRegistry(reason).finally(() => { this.registryRun = null; });
		return this.registryRun;
	}

	private async doSyncRegistry(reason: string) {
		let remote: RemoteNote[];
		try {
			remote = (await this.api.listNotes()).notes;
		} catch (e) {
			this.logger.warn(`could not read the account's notes (${reason}): ${errMsg(e)}`);
			return;
		}
		const byId = new Map(remote.map((n) => [n.noteId, n]));
		let adopted = 0, removed = 0, moved = 0;

		for (const rec of Object.values(this.data.notes)) {
			const r = byId.get(rec.noteId);
			if (!r) {
				// Unpublished from another device (or deleted on the server).
				delete this.data.notes[rec.path];
				this.sync.cancel(rec.path);
				this.clearDeleteGrace(rec.path);
				removed++;
				this.logger.info(`no longer published (unpublished from another device): ${rec.path}`);
				continue;
			}
			if (r.path !== rec.path && !this.data.notes[r.path]) {
				const f = this.app.vault.getAbstractFileByPath(r.path);
				if (f instanceof TFile) {
					// Renamed on another device: the sync delivered it here as delete + create.
					delete this.data.notes[rec.path];
					this.clearDeleteGrace(rec.path);
					this.sync.rename(rec.path, r.path);
					rec.path = r.path;
					this.data.notes[r.path] = rec;
					moved++;
					this.logger.info(`renamed on another device, link kept: ${r.path}`);
					if (rec.state === "ORPHAN" && rec.autoPaused) void this.autoResume(f);
				}
			}
			if (rec.state === "SUSPENDED" && r.state === "ACTIVE") {
				// Resumed from another device: publish what was edited here while it was paused.
				rec.state = "ACTIVE";
				this.logger.info(`link resumed from another device: ${rec.path}`);
				if (this.app.vault.getAbstractFileByPath(rec.path) instanceof TFile) {
					this.sync.markDirty(rec.path, "resumed elsewhere");
					this.sync.schedule(rec.path, 0);
				}
			}
			else if (rec.state === "ACTIVE" && r.state === "SUSPENDED") {
				rec.state = "SUSPENDED";
				this.sync.cancel(rec.path);
				this.logger.info(`link paused from another device: ${rec.path}`);
			}
		}

		const known = new Set(Object.values(this.data.notes).map((n) => n.noteId));
		for (const r of remote) {
			if (known.has(r.noteId) || this.data.notes[r.path]) continue;
			const f = this.app.vault.getAbstractFileByPath(r.path);
			if (!(f instanceof TFile)) continue;
			this.data.notes[r.path] = this.recordFromRemote(r, true);
			adopted++;
			this.logger.info(`linked note published from another device: ${r.path} (v${r.version})`);
		}

		if (adopted || removed || moved) {
			await this.saveState();
			this.logger.info(`registry (${reason}): ${adopted} linked, ${moved} renamed, ${removed} removed`);
			if (adopted) new Notice(`Linvau: ${adopted} note(s) published from your other devices are now linked here.`);
		}

		this.accountNotes = remote;
		this.accountCheckedAt = Date.now();
		const here = new Set(Object.values(this.data.notes).map((n) => n.noteId));
		const inVault = remote.filter((r) => here.has(r.noteId)).length;
		const summary = `${remote.length} in the account, ${inVault} in this vault, ${remote.length - inVault} elsewhere`;
		// Every read is logged, except periodic ones that found nothing new (they run every 5 min).
		if (reason !== "periodic" || summary !== this.lastRegistrySummary) this.logger.info(`registry (${reason}): ${summary}`);
		this.lastRegistrySummary = summary;
		this.refreshUi();
	}

	/** Notes of the account that are not in this vault: published from other devices or vaults. */
	otherNotes(): RemoteNote[] {
		if (!this.accountNotes) return [];
		const here = new Set(Object.values(this.data.notes).map((n) => n.noteId));
		return this.accountNotes.filter((r) => !here.has(r.noteId));
	}

	// ── Control of links whose file is not on this device (D-54: pause or unpublish any link from any device)

	private setRemoteState(noteId: string, state: string | null) {
		if (!this.accountNotes) return;
		this.accountNotes = state === null
			? this.accountNotes.filter((r) => r.noteId !== noteId)
			: this.accountNotes.map((r) => (r.noteId === noteId ? { ...r, state, updatedAt: new Date().toISOString() } : r));
		this.refreshUi();
	}

	async remoteSuspend(r: RemoteNote) {
		try {
			await this.api.suspend(r.noteId);
			this.setRemoteState(r.noteId, "SUSPENDED");
			this.logger.info(`link paused from this device (file on another device): ${r.path}`);
			new Notice("Linvau: link paused. Readers now see “paused by the author”.");
		} catch (e) { this.remoteFailed(r, e); }
	}

	async remoteResume(r: RemoteNote) {
		try {
			const res = await this.api.resume(r.noteId);
			this.setRemoteState(r.noteId, res.state);
			this.logger.info(`link resumed from this device (file on another device): ${r.path}`);
			new Notice("Linvau: link active again. It shows the last published version; new edits come from the device that has the file.");
		} catch (e) { this.remoteFailed(r, e); }
	}

	confirmRemoteUnpublish(r: RemoteNote) {
		this.confirm("Unpublish this note?",
			`“${r.path}” is published from another device. The link stops working for everyone and its files are deleted from Linvau. The note itself stays on that device. If that device edits it again, it will not be republished unless someone publishes it again.`,
			"Unpublish", () => void this.remoteUnpublish(r));
	}

	async remoteUnpublish(r: RemoteNote) {
		try {
			await this.api.remove(r.noteId);
		} catch (e) {
			if (!(e instanceof ApiError && e.status === 404)) { this.remoteFailed(r, e); return; }
		}
		this.setRemoteState(r.noteId, null);
		this.logger.info(`unpublished from this device (file on another device): ${r.path}`);
		new Notice("Linvau: note unpublished.");
	}

	private remoteFailed(r: RemoteNote, e: unknown) {
		if (e instanceof ApiError && e.status === 404) {
			this.setRemoteState(r.noteId, null);
			new Notice("Linvau: this note was already unpublished.");
			return;
		}
		if (isAuthLost(e)) this.onAuthLost((e as ApiError).code);
		new Notice(`Linvau: ${errMsg(e)}`);
	}

	async copyRemoteLink(r: RemoteNote) {
		try {
			await navigator.clipboard.writeText(r.url);
			new Notice(`Linvau: link copied — v${r.version}, ${r.state.toLowerCase()}`);
		} catch {
			new Notice(`Linvau link: ${r.url}`, 10_000);
		}
	}

	private recordFromRemote(r: RemoteNote, awaitLocalEdit: boolean): NoteRecord {
		return {
			noteId: r.noteId, shareId: r.shareId, url: r.url, path: r.path,
			state: r.state === "SUSPENDED" ? "SUSPENDED" : "ACTIVE",
			version: r.version, hash: r.hash, lastSyncAt: Date.parse(r.updatedAt) || null,
			assetsEnabled: true, approvedEmbeds: [], pendingEmbeds: [],
			...(awaitLocalEdit ? { awaitLocalEdit: true } : {}),
		};
	}

	private async findRemote(path: string): Promise<RemoteNote | null> {
		try {
			const { notes } = await this.api.listNotes();
			return notes.find((n) => n.path === path) ?? null;
		} catch (e) {
			this.logger.warn(`could not check the account's notes: ${errMsg(e)}`);
			return null;
		}
	}

	private async adoptAndPublish(file: TFile, remote: RemoteNote) {
		const rec = this.recordFromRemote(remote, false);
		rec.path = file.path;
		this.data.notes[file.path] = rec;
		await this.saveState();
		this.logger.info(`using the existing link for ${file.path} (v${remote.version})`);
		if (rec.state === "SUSPENDED") {
			new Notice("Linvau: linked to the existing link, which is paused. Use “Resume link” to reactivate it.");
		} else {
			this.sync.markDirty(file.path, "publish");
			await this.sync.flush(file.path);
		}
		await this.copyLink(rec);
		this.refreshUi();
	}

	// ─────────────────────────────── Deleted files: wait before pausing (sync tools replace files)

	private startDeleteGrace(path: string) {
		this.clearDeleteGrace(path);
		this.logger.warn(`file removed locally; the link is paused in ${DELETE_GRACE_MS / 60000} min unless it comes back: ${path}`);
		const t = window.setTimeout(() => void this.finishDelete(path), DELETE_GRACE_MS);
		this.pendingDeletes.set(path, t);
		this.refreshUi();
	}

	private clearDeleteGrace(path: string) {
		const t = this.pendingDeletes.get(path);
		if (t !== undefined) window.clearTimeout(t);
		this.pendingDeletes.delete(path);
	}

	private async finishDelete(path: string) {
		this.pendingDeletes.delete(path);
		const before = this.data.notes[path];
		if (!before) return;
		const noteId = before.noteId;
		// A rename on another device arrives as delete + create: the registry knows the new path.
		await this.syncRegistry("file removed");
		const rec = Object.values(this.data.notes).find((n) => n.noteId === noteId);
		if (!rec || rec.state === "ORPHAN") return;
		if (this.app.vault.getAbstractFileByPath(rec.path) instanceof TFile) return;
		rec.state = "ORPHAN";
		rec.autoPaused = true;
		await this.saveState();
		try {
			await this.api.suspend(rec.noteId);
			this.logger.warn(`file still missing after ${DELETE_GRACE_MS / 60000} min → link paused: ${rec.path}`);
		} catch (e) {
			this.logger.error(`could not pause link on server: ${errMsg(e)}`);
		}
		this.notify(`Linvau: “${rec.path.split("/").pop()}” was deleted, so its link was paused. It reactivates by itself if the file comes back.`);
		this.refreshUi();
	}

	private async autoResume(file: TFile) {
		const rec = this.data.notes[file.path];
		if (!rec) return;
		try {
			await this.api.resume(rec.noteId);
			rec.state = "ACTIVE";
			delete rec.autoPaused;
			await this.saveState();
			this.logger.info(`file is back → link reactivated: ${file.path}`);
			new Notice(`Linvau: “${file.basename}” is back, so its link is active again.`);
			this.sync.markDirty(file.path, "restored");
			await this.sync.flush(file.path);
		} catch (e) {
			this.logger.error(`could not reactivate link: ${errMsg(e)}`);
		}
		this.refreshUi();
	}

	// ─────────────────────────────── Newer version from another device (D-60)

	onNewerVersion(rec: NoteRecord, e: ApiError) {
		const now = Date.now();
		rec.serverVersion = Number(e.body.serverVersion) || rec.serverVersion;
		rec.serverHash = (e.body.serverHash as string | null | undefined) ?? rec.serverHash ?? null;
		rec.conflictSince ??= now;
		if (now - rec.conflictSince < CONFLICT_WAIT_MS) {
			if (rec.state !== "CONFLICT") rec.state = "ACTIVE";
			this.logger.warn(`v${rec.serverVersion} was published from another device; waiting for the vault sync before publishing this copy: ${rec.path}`);
			this.sync.schedule(rec.path, CONFLICT_RECHECK_MS);
		} else {
			rec.state = "CONFLICT";
			this.logger.error(`conflict: this device's copy still differs from v${rec.serverVersion} published from another device: ${rec.path}`);
			const last = this.lastConflictNotice.get(rec.path) ?? 0;
			if (now - last > 30 * 60_000) {
				this.lastConflictNotice.set(rec.path, now);
				this.notify(`Linvau: “${rec.path.split("/").pop()}” was changed on another device and differs from this copy. Run “Linvau: Resolve conflict” to choose which version stays published.`);
			}
		}
		this.refreshUi();
	}

	resolveConflict(rec: NoteRecord, how: "synced" | "keep-published" | "publish-local") {
		if (how === "publish-local") {
			rec.forcePublish = true;
			rec.state = "ACTIVE";
			this.logger.info(`conflict: the author chose this device's version: ${rec.path}`);
			this.sync.markDirty(rec.path, "conflict");
			void this.sync.flush(rec.path);
		} else {
			rec.version = rec.serverVersion ?? rec.version;
			rec.hash = rec.serverHash ?? rec.hash;
			rec.state = "ACTIVE";
			delete rec.conflictSince; delete rec.serverVersion; delete rec.serverHash; delete rec.forcePublish;
			this.logger.info(how === "synced"
				? `in sync with v${rec.version} from another device: ${rec.path}`
				: `conflict: the author kept the published v${rec.version}: ${rec.path}`);
		}
		void this.saveState();
		this.refreshUi();
	}

	openConflict(file: TFile) {
		const rec = this.data.notes[file.path];
		if (!rec || rec.state !== "CONFLICT") return;
		new ChoiceModal(this.app, "Which version stays published?", [
			`Another device published version ${rec.serverVersion ?? "?"} of “${file.basename}”, and this device's copy is different.`,
			"Usually the vault sync settles it on its own. If it did not, choose: keeping the published version leaves the link as readers see it now; publishing this copy replaces it.",
		], [
			{ label: "Keep the published version", run: () => this.resolveConflict(rec, "keep-published") },
			{ label: "Publish this device's copy", cta: true, run: () => this.resolveConflict(rec, "publish-local") },
		]).open();
	}

	deviceInfo(): { name: string; platform: string; lang: string } {
		const platform = Platform.isIosApp ? "ios" : Platform.isAndroidApp ? "android" : Platform.isMacOS ? "macos" : Platform.isWin ? "windows" : Platform.isLinux ? "linux" : "unknown";
		const lang = (window.localStorage.getItem("language") || navigator.language || "en").slice(0, 2);
		return { name: `${this.platformName()} · ${this.app.vault.getName()}`.slice(0, 60), platform, lang };
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
			const rec = this.data.notes[f.path];
			if (rec?.awaitLocalEdit) {
				delete rec.awaitLocalEdit;
				this.logger.info(`first edit on this device of a note linked from another device: ${f.path}`);
			}
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
			if (!rec || rec.state === "ORPHAN") return;
			this.sync.cancel(f.path);
			this.startDeleteGrace(f.path);
		}));

		this.registerEvent(vault.on("create", (f) => {
			if (!(f instanceof TFile)) return;
			const pending = this.pendingDeletes.get(f.path);
			if (pending !== undefined) {
				window.clearTimeout(pending);
				this.pendingDeletes.delete(f.path);
				this.logger.info(`file is back within the grace period, link untouched: ${f.path}`);
				this.sync.markDirty(f.path, "restored");
				this.refreshUi();
				return;
			}
			const rec = this.data.notes[f.path];
			if (rec?.state === "ORPHAN") {
				if (rec.autoPaused) void this.autoResume(f);
				else {
					this.logger.info(`file restored: ${f.path} — run “Resume link” to reactivate`);
					this.refreshUi();
				}
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
		if (!this.session.connected) {
			this.logger.warn("reconcile skipped: this device is not connected to Linvau");
			return;
		}
		let changed = 0, missing = 0, drift = 0;
		for (const [i, rec] of recs.entries()) {
			const file = this.app.vault.getAbstractFileByPath(rec.path);
			if (!(file instanceof TFile)) {
				if (rec.state !== "ORPHAN" && !this.pendingDeletes.has(rec.path)) {
					missing++;
					this.logger.warn(`reconcile: file missing locally: ${rec.path}`);
					this.startDeleteGrace(rec.path);
				}
				continue;
			}
			if (rec.state === "SUSPENDED" || rec.state === "ORPHAN" || rec.awaitLocalEdit) continue;
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
		this.addCommand({ id: "resolve-conflict", name: "Resolve conflict of current note", icon: "git-compare",
			checkCallback: (checking: boolean) => {
				const f = this.app.workspace.getActiveFile();
				if (!f || this.data.notes[f.path]?.state !== "CONFLICT") return false;
				if (!checking) this.openConflict(f);
				return true;
			} });
		this.addCommand({ id: "connect", name: "Connect this device", icon: "log-in",
			callback: () => void this.ensureConnected() });
		this.addCommand({ id: "disconnect", name: "Disconnect this device", icon: "log-out",
			callback: () => this.confirmDisconnect() });
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

		if (rec.state === "CONFLICT") {
			add("Linvau: resolve conflict…", "git-compare", () => this.openConflict(file));
			add("Linvau: copy link", "link", () => void this.copyLink(rec));
		} else if (rec.state === "ORPHAN") {
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
		if (!(await this.ensureConnected("Publishing needs a free Linvau account."))) return;
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
		// The note may already be published from another device: offer its link instead of a second one.
		const remote = await this.findRemote(file.path);
		if (remote) {
			new ChoiceModal(this.app, "This note already has a link", [
				`It was published from another device of your account (version ${remote.version}${remote.state === "SUSPENDED" ? ", paused" : ""}).`,
				"Use the same link so readers keep a single address and this device updates it too.",
			], [
				{ label: "Create a new link", run: () => void this.publishNew(file) },
				{ label: "Use the existing link", cta: true, run: () => void this.adoptAndPublish(file, remote) },
			]).open();
			return;
		}
		await this.publishNew(file);
	}

	private async publishNew(file: TFile) {
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
			delete rec.autoPaused;
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
				apiBase: this.apiBase(), customApi: !!this.data.settings.apiBase, debounceSeconds: this.data.settings.debounceSeconds,
				maxWaitSeconds: this.data.settings.maxWaitSeconds, connected: this.session.connected,
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
		if (!this.session.connected) text = `Linvau · not connected · v${rec.version} live`;
		else if (this.sync.isInFlight(f.path)) text = "Linvau · publishing…";
		else if (rec.state === "SUSPENDED") text = `Linvau · paused · v${rec.version}`;
		else if (this.pendingDeletes.has(f.path)) text = "Linvau · file removed · waiting before pausing";
		else if (rec.state === "ORPHAN") text = "Linvau · file was deleted · link paused";
		else if (rec.state === "CONFLICT") text = "Linvau · conflict · choose which version stays";
		else if (rec.conflictSince) text = `Linvau · waiting for the vault sync (v${rec.serverVersion} from another device)`;
		else if (rec.state === "ERROR") text = `Linvau · error · v${rec.version} live`;
		else if (this.sync.isDirty(f.path)) text = `Linvau · v${rec.version} live · changes pending`;
		else text = `Linvau · v${rec.version} · ${ago(rec.lastSyncAt)}`;
		const pending = rec.pendingEmbeds?.length ?? 0;
		if (pending && rec.state !== "ORPHAN") text += ` · ${pending} embed${pending > 1 ? "s" : ""} pending`;
		this.statusEl.setText(text);
		this.statusEl.setAttr("aria-label", rec.lastError ?? rec.url);
	}
}
