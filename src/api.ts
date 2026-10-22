import { requestUrl } from "obsidian";

export class ApiError extends Error {
	body: Record<string, unknown> = {};
	constructor(public status: number, message: string, public code?: string, public retryAfter?: number, public attemptsLeft?: number) {
		super(message);
	}
}

/** The device has no valid session: the author has to connect it (again). */
export const AUTH_LOST_CODES = new Set(["not_connected", "session_expired", "device_revoked", "invalid_token"]);
export const isAuthLost = (e: unknown) => e instanceof ApiError && e.status === 401 && AUTH_LOST_CODES.has(e.code ?? "");

export interface CreatedNote { noteId: string; shareId: string; url: string; state: string; }
export interface PublishedVersion { version: number; publishedAt: string; url: string; unchanged?: boolean; renderMs?: number; assets?: number; panel?: number; }
export interface RemoteNote { noteId: string; shareId: string; url: string; state: string; version: number; hash: string | null; path: string; updatedAt: string; }
export interface Me { ok: boolean; owner: string; legacy: boolean; user: { id: string; email: string } | null; device: { id: string } | null }
export interface LoginResult {
	accessToken: string; accessExpiresAt: string; refreshToken: string; refreshExpiresAt: string;
	user: { id: string; email: string }; device: { id: string; name: string }; claimedNotes: number;
}
export interface RefreshResult { accessToken: string; accessExpiresAt: string; refreshExpiresAt: string }
export interface Device { id: string; name: string; platform: string; createdAt: string; lastSeenAt: string; current: boolean }

/** Supplies a valid access token (renewing it if needed) and can force a renewal. */
export interface TokenSource {
	accessToken(): Promise<string>;
	forceRenew(): Promise<string>;
}

type Raw = { status: number; json: unknown };

export class LinvauApi {
	tokens: TokenSource | null = null;

	constructor(private getBase: () => string) {}

	private base(): string {
		const b = this.getBase().replace(/\/+$/, "");
		if (!b) throw new ApiError(0, "API URL is not configured (Settings → Linvau).");
		return b;
	}

	private async send(method: string, path: string, opts: { token?: string; body?: unknown; binary?: ArrayBuffer } = {}): Promise<Raw> {
		const headers: Record<string, string> = {};
		if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
		let res;
		try {
			res = await requestUrl({
				url: `${this.base()}${path}`,
				method,
				headers,
				...(opts.binary
					? { contentType: "application/octet-stream", body: opts.binary }
					: { contentType: "application/json", body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
				throw: false,
			});
		} catch (e) {
			throw new ApiError(0, `Network error: ${e instanceof Error ? e.message : String(e)}`);
		}
		let json: unknown = null;
		try { json = res.json; } catch { /* non-JSON body */ }
		return { status: res.status, json };
	}

	private fail(r: Raw): never {
		const j = (r.json ?? {}) as { error?: string; code?: string; retryAfter?: number; attemptsLeft?: number };
		const err = new ApiError(r.status, j.error ?? `HTTP ${r.status}`, j.code, j.retryAfter, j.attemptsLeft);
		err.body = (r.json ?? {}) as Record<string, unknown>;
		throw err;
	}

	/** Authenticated call: gets a token, and renews it once if the server says it expired. */
	private async authed<T>(method: string, path: string, opts: { body?: unknown; binary?: ArrayBuffer } = {}): Promise<T> {
		if (!this.tokens) throw new ApiError(401, "Not connected.", "not_connected");
		let r = await this.send(method, path, { ...opts, token: await this.tokens.accessToken() });
		if (r.status === 401 && (r.json as { code?: string } | null)?.code === "token_expired") {
			r = await this.send(method, path, { ...opts, token: await this.tokens.forceRenew() });
		}
		if (r.status >= 400) this.fail(r);
		return r.json as T;
	}

	private async open<T>(method: string, path: string, body?: unknown): Promise<T> {
		const r = await this.send(method, path, { body });
		if (r.status >= 400) this.fail(r);
		return r.json as T;
	}

	// ── public (no session)
	health() { return this.open<{ ok: boolean; service: string; version: string }>("GET", "/health"); }
	requestCode(email: string, lang: string) { return this.open<{ ok: boolean; resendAfter: number; expiresIn: number }>("POST", "/v1/auth/code", { email, lang }); }
	verifyCode(email: string, code: string, deviceName: string, platform: string) {
		return this.open<LoginResult>("POST", "/v1/auth/verify", { email, code, deviceName, platform });
	}
	refresh(refreshToken: string) { return this.open<RefreshResult>("POST", "/v1/auth/refresh", { refreshToken }); }

	// ── session
	me() { return this.authed<Me>("GET", "/v1/me"); }
	logout() { return this.authed<{ ok: boolean }>("POST", "/v1/auth/logout"); }
	devices() { return this.authed<{ devices: Device[] }>("GET", "/v1/devices"); }
	removeDevice(id: string) { return this.authed<{ ok: boolean }>("DELETE", `/v1/devices/${encodeURIComponent(id)}`); }

	// ── notes
	createNote(path: string, title: string) { return this.authed<CreatedNote>("POST", "/v1/notes", { body: { path, title } }); }
	getNote(id: string) { return this.authed<RemoteNote>("GET", `/v1/notes/${id}`); }
	/** Every note of the account that is not deleted: the shared registry of all devices. */
	listNotes() { return this.authed<{ notes: RemoteNote[] }>("GET", "/v1/notes"); }
	updatePath(id: string, path: string) { return this.authed<{ ok: boolean }>("PATCH", `/v1/notes/${id}`, { body: { path } }); }
	publishVersion(id: string, p: { title: string; markdown: string; hash: string; assets: string[]; panel: unknown[]; baseVersion?: number; force?: boolean }) {
		return this.authed<PublishedVersion>("POST", `/v1/notes/${id}/versions`, { body: p });
	}
	/** Which of these attachment hashes the server does not have yet. */
	checkAssets(id: string, hashes: string[]) {
		return this.authed<{ missing: string[] }>("POST", `/v1/notes/${id}/assets/check`, { body: { hashes } });
	}
	async putAsset(id: string, hash: string, ext: string, data: ArrayBuffer): Promise<void> {
		await this.authed<unknown>("PUT", `/v1/notes/${id}/assets/${hash}?ext=${encodeURIComponent(ext)}`, { binary: data });
	}
	suspend(id: string) { return this.authed<{ state: string }>("POST", `/v1/notes/${id}/suspend`); }
	resume(id: string) { return this.authed<{ state: string }>("POST", `/v1/notes/${id}/resume`); }
	regenerate(id: string) { return this.authed<{ shareId: string; url: string }>("POST", `/v1/notes/${id}/regenerate`); }
	remove(id: string) { return this.authed<{ ok: boolean }>("DELETE", `/v1/notes/${id}`); }
}
