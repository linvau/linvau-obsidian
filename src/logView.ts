import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import type LinvauPlugin from "./main";
import { ago, fmtMs, percentile } from "./util";

export const LOG_VIEW_TYPE = "linvau-log";

const SLA_SYNC_P95_MS = 15_000;

/** Pilot diagnostics panel: sync metrics (P50/P95), published notes and the event log. DOM API only, no innerHTML. */
export class LinvauLogView extends ItemView {
	private off: (() => void) | null = null;
	private pending = false;

	constructor(leaf: WorkspaceLeaf, private plugin: LinvauPlugin) {
		super(leaf);
	}

	getViewType() { return LOG_VIEW_TYPE; }
	getDisplayText() { return "Linvau pilot"; }
	getIcon() { return "radio"; }

	async onOpen() {
		this.off = this.plugin.logger.onChange(() => this.requestRender());
		this.registerInterval(window.setInterval(() => this.requestRender(), 30_000));
		this.render();
	}

	async onClose() {
		this.off?.();
	}

	requestRender() {
		if (this.pending) return;
		this.pending = true;
		window.setTimeout(() => {
			this.pending = false;
			this.render();
		}, 200);
	}

	/** Read-only view with link controls: the file is on another device, so content cannot change from here. */
	private renderOtherNotes() {
		const { contentEl, plugin } = this;
		const others = plugin.otherNotes();
		const head = contentEl.createDiv({ cls: "linvau-section-head" });
		head.createEl("h4", { text: plugin.accountNotes ? `On other devices or vaults (${others.length})` : "On other devices or vaults" });
		const refresh = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Refresh from the account" } });
		setIcon(refresh, "refresh-cw");
		refresh.addEventListener("click", () => {
			refresh.disabled = true;
			void plugin.syncRegistry("manual").finally(() => { refresh.disabled = false; });
		});

		if (!plugin.accountNotes) {
			contentEl.createDiv({ cls: "linvau-muted", text: "Not read from the account yet. Use ↻ to check now." });
			return;
		}
		contentEl.createDiv({
			cls: "linvau-muted",
			text: `Their files are not on this device: you can open, pause or unpublish the link, but edits only come from the device that has the file. Checked ${ago(plugin.accountCheckedAt)}.`,
		});
		if (!others.length) {
			contentEl.createDiv({ cls: "linvau-muted", text: "Every published note of your account is in this vault." });
			return;
		}
		const list = contentEl.createDiv({ cls: "linvau-notes linvau-others" });
		for (const r of [...others].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
			const row = list.createDiv({ cls: "linvau-note-row" });
			row.createSpan({ cls: `linvau-badge state-${r.state.toLowerCase()}`, text: r.state });
			row.createSpan({ cls: "linvau-remote-path", text: r.path });
			row.createSpan({ cls: "linvau-muted", text: ` v${r.version} · ${ago(Date.parse(r.updatedAt) || null)}` });
			const actions = row.createDiv({ cls: "linvau-row-actions" });
			const act = (label: string, icon: string, run: () => void | Promise<void>, warning = false) => {
				const b = actions.createEl("button", { attr: { "aria-label": label } });
				const i = b.createSpan({ cls: "linvau-btn-icon" });
				setIcon(i, icon);
				b.createSpan({ text: label });
				if (warning) b.addClass("mod-warning");
				b.addEventListener("click", async () => {
					actions.querySelectorAll("button").forEach((x) => (x.disabled = true));
					try { await run(); } finally { actions.querySelectorAll("button").forEach((x) => (x.disabled = false)); }
				});
			};
			if (r.state === "ACTIVE") act("Open", "external-link", () => { window.open(r.url, "_blank"); });
			act("Copy link", "link", () => plugin.copyRemoteLink(r));
			if (r.state === "SUSPENDED") act("Resume", "play", () => plugin.remoteResume(r));
			else act("Pause", "pause", () => plugin.remoteSuspend(r));
			act("Unpublish", "trash-2", () => plugin.confirmRemoteUnpublish(r), true);
		}
	}

	private render() {
		const { contentEl } = this;
		const { plugin } = this;
		contentEl.empty();
		contentEl.addClass("linvau-log");

		// ── Account (visible on mobile, where there is no status bar)
		const acct = contentEl.createDiv({ cls: `linvau-account ${plugin.session.connected ? "is-ok" : "is-bad"}` });
		if (plugin.session.connected) {
			acct.createSpan({ text: `Connected as ${plugin.session.email}` });
		} else {
			acct.createSpan({ text: "Not connected — edits are not published." });
			const btn = acct.createEl("button", { text: "Connect", cls: "mod-cta" });
			btn.addEventListener("click", () => void plugin.ensureConnected());
		}

		// ── Metrics
		const all = plugin.data.latencies;
		const samples = all.filter((s) => !s.cause);
		const delayed = all.filter((s) => s.cause);
		const since = samples.map((s) => s.sinceLastSave);
		const session = samples.map((s) => s.sinceFirstSave);
		const api = all.map((s) => s.api);
		const p95 = percentile(since, 95);

		const metrics = contentEl.createDiv({ cls: "linvau-metrics" });
		metrics.createEl("h4", { text: "Sync latency (last save → live)" });
		const grid = metrics.createDiv({ cls: "linvau-grid" });
		const stat = (label: string, value: string) => {
			const cell = grid.createDiv({ cls: "linvau-stat" });
			cell.createDiv({ cls: "linvau-stat-value", text: value });
			cell.createDiv({ cls: "linvau-stat-label", text: label });
		};
		stat("samples", String(samples.length));
		stat("P50", fmtMs(percentile(since, 50)));
		stat("P95", fmtMs(p95));
		stat("API P95", fmtMs(percentile(api, 95)));
		stat("Session P95", fmtMs(percentile(session, 95)));

		if (p95 !== null) {
			const ok = p95 < SLA_SYNC_P95_MS;
			metrics.createDiv({
				cls: `linvau-sla ${ok ? "is-ok" : "is-bad"}`,
				text: ok ? "Within target (P95 < 15 s)" : "Above target (P95 ≥ 15 s)",
			});
		}
		metrics.createDiv({
			cls: "linvau-muted",
			text: `Includes the ${plugin.data.settings.debounceSeconds}s debounce (max ${plugin.data.settings.maxWaitSeconds}s while typing). Pending: ${plugin.sync.pendingCount()}. Online: ${navigator.onLine ? "yes" : "no"}.`,
		});

		if (delayed.length) {
			const counts: Record<string, number> = {};
			for (const d of delayed) counts[d.cause!] = (counts[d.cause!] ?? 0) + 1;
			const max = Math.max(...delayed.map((d) => d.sinceLastSave));
			metrics.createDiv({
				cls: "linvau-muted",
				text: `Not counted in the target — delayed publishes: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")} (longest ${fmtMs(max)}).`,
			});
		}

		const actions = metrics.createDiv({ cls: "linvau-actions" });
		const btn = (label: string, icon: string, onClick: () => void) => {
			const b = actions.createEl("button", { text: label });
			const i = b.createSpan({ cls: "linvau-btn-icon" });
			setIcon(i, icon);
			b.prepend(i);
			b.addEventListener("click", onClick);
		};
		btn("Copy diagnostics", "clipboard-copy", () => void this.plugin.copyDiagnostics());
		btn("Sync all", "refresh-cw", () => this.plugin.syncAll());
		btn("Clear", "trash-2", () => void this.plugin.clearDiagnostics());

		// ── Notes
		const notes = Object.values(plugin.data.notes);
		contentEl.createEl("h4", { text: `Published notes in this vault (${notes.length})` });
		if (!notes.length) {
			contentEl.createDiv({ cls: "linvau-muted", text: "None yet. Open a note and run “Linvau: Publish current note”." });
		} else {
			const list = contentEl.createDiv({ cls: "linvau-notes" });
			for (const n of notes.sort((a, b) => (b.lastSyncAt ?? 0) - (a.lastSyncAt ?? 0))) {
				const row = list.createDiv({ cls: "linvau-note-row" });
				const state = plugin.sync.isInFlight(n.path) ? "PUBLISHING" : plugin.sync.isDirty(n.path) && n.state === "ACTIVE" ? "PENDING" : n.state;
				row.createSpan({ cls: `linvau-badge state-${state.toLowerCase()}`, text: state });
				const link = row.createEl("a", { text: n.path, href: "#" });
				link.addEventListener("click", (ev) => {
					ev.preventDefault();
					void this.app.workspace.openLinkText(n.path, "", false);
				});
				row.createSpan({ cls: "linvau-muted", text: ` v${n.version} · ${ago(n.lastSyncAt)}` });
				if (n.lastError) row.createDiv({ cls: "linvau-error", text: n.lastError });
				if (n.state === "ORPHAN" && !this.app.vault.getAbstractFileByPath(n.path)) {
					const box = row.createDiv({ cls: "linvau-orphan" });
					box.createSpan({ cls: "linvau-muted", text: "Local file deleted; link paused. Restore the file and resume, or remove the link: " });
					const b = box.createEl("button", { text: "Unpublish" });
					b.addClass("mod-warning");
					b.addEventListener("click", () => this.plugin.confirmUnpublish({ path: n.path }));
				}
			}
		}

		// ── Notes of the account that are not in this vault (published from other devices or vaults)
		if (plugin.session.connected) this.renderOtherNotes();

		// ── Log
		contentEl.createEl("h4", { text: "Event log" });
		const log = contentEl.createDiv({ cls: "linvau-entries" });
		const entries = [...plugin.logger.entries].reverse();
		if (!entries.length) log.createDiv({ cls: "linvau-muted", text: "No events yet." });
		for (const e of entries) {
			const row = log.createDiv({ cls: `linvau-entry level-${e.level}` });
			row.createSpan({ cls: "linvau-time", text: new Date(e.ts).toLocaleTimeString() });
			row.createSpan({ text: ` ${e.msg}` });
		}
	}
}
