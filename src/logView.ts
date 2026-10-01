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

	private render() {
		const { contentEl } = this;
		const { plugin } = this;
		contentEl.empty();
		contentEl.addClass("linvau-log");

		// ── Metrics
		const samples = plugin.data.latencies;
		const since = samples.map((s) => s.sinceLastSave);
		const session = samples.map((s) => s.sinceFirstSave);
		const api = samples.map((s) => s.api);
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
		contentEl.createEl("h4", { text: `Published notes (${notes.length})` });
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
			}
		}

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
