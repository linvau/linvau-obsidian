import { TFile } from "obsidian";
import type LinvauPlugin from "./main";
import { ApiError } from "./api";
import { buildPayload, errMsg, fmtMs } from "./util";
import { MAX_NOTE_BYTES } from "./types";

const RETRY_DELAYS_MS = [5_000, 15_000, 60_000];

/**
 * Per-note debounced sync.
 * - Every save of a published note marks it dirty and (re)starts its debounce timer.
 * - On flush, the content is hashed; if the hash equals the last published one, nothing is sent.
 * - One request in flight per note; edits during a request trigger a follow-up flush.
 * - Offline: the note stays dirty and is flushed on the window "online" event.
 */
export class SyncEngine {
	private timers = new Map<string, number>();
	private dirtySince = new Map<string, number>();
	private inFlight = new Set<string>();
	private rerun = new Set<string>();
	private retries = new Map<string, number>();
	/** Saves that happen while a request is in flight start a new latency window. */
	private dirtyDuringFlight = new Map<string, number>();

	constructor(private plugin: LinvauPlugin) {}

	isDirty(path: string) { return this.dirtySince.has(path); }
	isInFlight(path: string) { return this.inFlight.has(path); }
	pendingCount() { return this.dirtySince.size; }

	markDirty(path: string, reason: string) {
		const rec = this.plugin.data.notes[path];
		if (!rec || rec.state === "SUSPENDED" || rec.state === "ORPHAN") return;
		if (this.inFlight.has(path) && !this.dirtyDuringFlight.has(path)) {
			this.dirtyDuringFlight.set(path, Date.now());
		} else if (!this.dirtySince.has(path)) {
			this.dirtySince.set(path, Date.now());
			this.plugin.logger.debug(`dirty (${reason}): ${path}`);
		}
		this.schedule(path, this.plugin.data.settings.debounceSeconds * 1000);
		this.plugin.refreshUi();
	}

	schedule(path: string, delayMs: number) {
		const t = this.timers.get(path);
		if (t !== undefined) window.clearTimeout(t);
		this.timers.set(path, window.setTimeout(() => {
			this.timers.delete(path);
			void this.flush(path);
		}, delayMs));
	}

	cancel(path: string) {
		const t = this.timers.get(path);
		if (t !== undefined) window.clearTimeout(t);
		this.timers.delete(path);
		this.dirtySince.delete(path);
		this.retries.delete(path);
		this.rerun.delete(path);
		this.dirtyDuringFlight.delete(path);
	}

	rename(oldPath: string, newPath: string) {
		const since = this.dirtySince.get(oldPath);
		this.cancel(oldPath);
		if (since !== undefined) {
			this.dirtySince.set(newPath, since);
			this.schedule(newPath, this.plugin.data.settings.debounceSeconds * 1000);
		}
	}

	flushAllPending(reason: string) {
		const paths = [...this.dirtySince.keys()];
		if (!paths.length) return;
		this.plugin.logger.info(`${reason}: flushing ${paths.length} pending note(s)`);
		paths.forEach((p, i) => this.schedule(p, 250 * i));
	}

	unload() {
		this.timers.forEach((t) => window.clearTimeout(t));
		this.timers.clear();
	}

	private settleDirty(path: string) {
		const next = this.dirtyDuringFlight.get(path);
		this.dirtyDuringFlight.delete(path);
		if (next !== undefined) this.dirtySince.set(path, next);
		else this.dirtySince.delete(path);
	}

	async flush(path: string): Promise<void> {
		const { plugin } = this;
		const rec = plugin.data.notes[path];
		if (!rec || rec.state === "SUSPENDED" || rec.state === "ORPHAN") {
			this.dirtySince.delete(path);
			return;
		}
		if (this.inFlight.has(path)) {
			this.rerun.add(path);
			return;
		}
		if (!navigator.onLine) {
			plugin.logger.warn(`offline — keeping changes pending: ${path}`);
			plugin.refreshUi();
			return;
		}
		const file = plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			this.dirtySince.delete(path);
			return;
		}

		this.inFlight.add(path);
		plugin.refreshUi();
		try {
			const payload = await buildPayload(plugin.app, file);
			if (payload.hash === rec.hash && rec.state === "ACTIVE") {
				plugin.logger.debug(`no content change (hash equal), skipped: ${path}`);
				this.settleDirty(path);
				return;
			}
			if (payload.bytes > MAX_NOTE_BYTES) {
				throw new ApiError(413, `Note is ${Math.round(payload.bytes / 1024)} KB; the pilot limit is ${MAX_NOTE_BYTES / 1000} KB.`);
			}
			const t0 = Date.now();
			const res = await plugin.api.publishVersion(rec.noteId, payload);
			const now = Date.now();
			const api = now - t0;
			const sinceEdit = now - (this.dirtySince.get(path) ?? t0);

			// The record may have been renamed while the request was in flight.
			const current = plugin.data.notes[path] ?? rec;
			current.version = res.version;
			current.hash = payload.hash;
			current.lastSyncAt = now;
			current.state = "ACTIVE";
			delete current.lastError;
			this.settleDirty(path);
			this.retries.delete(path);

			if (res.unchanged) {
				plugin.logger.info(`server already had this content (v${res.version}): ${path}`);
			} else {
				plugin.recordLatency({ ts: now, sinceEdit, api, bytes: payload.bytes });
				plugin.logger.info(`v${res.version} live — ${fmtMs(sinceEdit)} since save, API ${fmtMs(api)}: ${path}`);
			}
			await plugin.saveState();
		} catch (e) {
			const msg = errMsg(e);
			rec.state = "ERROR";
			rec.lastError = msg;
			const status = e instanceof ApiError ? e.status : 0;
			const permanent = status === 401 || status === 403 || status === 404 || status === 410 || status === 413;
			const attempt = (this.retries.get(path) ?? 0) + 1;
			if (!permanent && attempt <= RETRY_DELAYS_MS.length) {
				this.retries.set(path, attempt);
				const delay = RETRY_DELAYS_MS[attempt - 1];
				plugin.logger.warn(`publish failed (${msg}); retry ${attempt}/${RETRY_DELAYS_MS.length} in ${delay / 1000}s: ${path}`);
				this.schedule(path, delay);
			} else {
				this.retries.delete(path);
				plugin.logger.error(`publish failed, giving up (${msg}): ${path}`);
				plugin.notify(`Linvau: could not publish “${file.basename}”. ${msg}`);
			}
			await plugin.saveState();
		} finally {
			this.inFlight.delete(path);
			const again = this.rerun.delete(path);
			if (this.dirtyDuringFlight.has(path)) {
				// Failed request with a newer save pending: keep the oldest start time.
				if (!this.dirtySince.has(path)) this.dirtySince.set(path, this.dirtyDuringFlight.get(path)!);
				this.dirtyDuringFlight.delete(path);
			}
			if (again) this.schedule(path, 500);
			plugin.refreshUi();
		}
	}
}
