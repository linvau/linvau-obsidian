import type { App } from "obsidian";
import { ApiError, type LinvauApi, type LoginResult, type TokenSource } from "./api";

/** Stored in this device's local storage (per vault), never in the vault: it does not travel with sync or git. */
const SESSION_KEY = "linvau-session";
/** The fixed pilot token of 0.0.x–0.1.4. Removed on first load of 0.1.5. */
export const LEGACY_TOKEN_KEY = "linvau-token";
/** Renew a little before the access token expires, so a request never leaves with a stale one. */
const RENEW_MARGIN_MS = 30_000;

interface StoredSession {
	email: string;
	deviceId: string;
	deviceName: string;
	refreshToken: string;
	accessToken: string;
	accessExpiresAt: string;
}

export class Session implements TokenSource {
	private data: StoredSession | null = null;
	private renewing: Promise<string> | null = null;
	private listeners = new Set<() => void>();

	constructor(private app: App, private api: LinvauApi, private log: (level: "info" | "warn", msg: string) => void) {
		const raw = this.app.loadLocalStorage(SESSION_KEY) as unknown;
		if (raw && typeof raw === "object" && typeof (raw as StoredSession).refreshToken === "string") this.data = raw as StoredSession;
	}

	get connected() { return !!this.data; }
	get email() { return this.data?.email ?? null; }
	get deviceName() { return this.data?.deviceName ?? null; }
	get deviceId() { return this.data?.deviceId ?? null; }

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private save() {
		this.app.saveLocalStorage(SESSION_KEY, this.data);
		this.listeners.forEach((fn) => fn());
	}

	/** Called after a successful code verification. */
	start(r: LoginResult) {
		this.data = {
			email: r.user.email, deviceId: r.device.id, deviceName: r.device.name,
			refreshToken: r.refreshToken, accessToken: r.accessToken, accessExpiresAt: r.accessExpiresAt,
		};
		this.save();
	}

	/** Forget the session on this device (the server side is revoked separately, when possible). */
	clear(reason: string) {
		if (!this.data) return;
		this.log("warn", `session ended on this device: ${reason}`);
		this.data = null;
		this.renewing = null;
		this.save();
	}

	async accessToken(): Promise<string> {
		if (!this.data) throw new ApiError(401, "This device is not connected to Linvau. Run “Linvau: Connect this device”.", "not_connected");
		if (Date.parse(this.data.accessExpiresAt) - Date.now() > RENEW_MARGIN_MS) return this.data.accessToken;
		return this.forceRenew();
	}

	/** One renewal at a time, shared by every request that needs it. */
	forceRenew(): Promise<string> {
		if (!this.data) return Promise.reject(new ApiError(401, "This device is not connected to Linvau. Run “Linvau: Connect this device”.", "not_connected"));
		if (!this.renewing) {
			const rt = this.data.refreshToken;
			this.renewing = this.api.refresh(rt)
				.then((r) => {
					if (this.data && this.data.refreshToken === rt) {
						this.data.accessToken = r.accessToken;
						this.data.accessExpiresAt = r.accessExpiresAt;
						this.save();
					}
					this.log("info", "session token renewed");
					return r.accessToken;
				})
				.catch((e) => {
					// A network error keeps the session (retry later); a refused refresh ends it.
					if (e instanceof ApiError && e.status === 401) this.clear(e.code ?? "refresh refused");
					throw e instanceof ApiError && e.status === 401
						? new ApiError(401, "Your Linvau session on this device ended. Connect it again.", "session_expired")
						: e;
				})
				.finally(() => { this.renewing = null; });
		}
		return this.renewing;
	}
}
