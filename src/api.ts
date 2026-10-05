import { requestUrl } from "obsidian";

export class ApiError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}

export interface CreatedNote { noteId: string; shareId: string; url: string; state: string; }
export interface PublishedVersion { version: number; publishedAt: string; url: string; unchanged?: boolean; renderMs?: number; assets?: number; panel?: number; }
export interface RemoteNote { noteId: string; shareId: string; url: string; state: string; version: number; hash: string | null; path: string; updatedAt: string; }

export class LinvauApi {
	constructor(private getBase: () => string, private getToken: () => string | null) {}

	private async call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
		const base = this.getBase().replace(/\/+$/, "");
		if (!base) throw new ApiError(0, "API URL is not configured (Settings → Linvau).");
		const headers: Record<string, string> = { "Content-Type": "application/json" };
		if (auth) {
			const token = this.getToken();
			if (!token) throw new ApiError(0, "Pilot token is not configured (Settings → Linvau).");
			headers["Authorization"] = `Bearer ${token}`;
		}
		let res;
		try {
			res = await requestUrl({
				url: `${base}${path}`,
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				throw: false,
			});
		} catch (e) {
			throw new ApiError(0, `Network error: ${e instanceof Error ? e.message : String(e)}`);
		}
		let json: unknown = null;
		try { json = res.json; } catch { /* non-JSON body */ }
		if (res.status >= 400) {
			const msg = (json as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
			throw new ApiError(res.status, msg);
		}
		return json as T;
	}

	health() { return this.call<{ ok: boolean; service: string; version: string }>("GET", "/health", undefined, false); }
	me() { return this.call<{ ok: boolean; owner: string }>("GET", "/v1/me"); }
	createNote(path: string, title: string) { return this.call<CreatedNote>("POST", "/v1/notes", { path, title }); }
	getNote(id: string) { return this.call<RemoteNote>("GET", `/v1/notes/${id}`); }
	updatePath(id: string, path: string) { return this.call<{ ok: boolean }>("PATCH", `/v1/notes/${id}`, { path }); }
	publishVersion(id: string, p: { title: string; markdown: string; hash: string; assets: string[]; panel: unknown[] }) {
		return this.call<PublishedVersion>("POST", `/v1/notes/${id}/versions`, p);
	}
	/** Which of these attachment hashes the server does not have yet. */
	checkAssets(id: string, hashes: string[]) {
		return this.call<{ missing: string[] }>("POST", `/v1/notes/${id}/assets/check`, { hashes });
	}
	async putAsset(id: string, hash: string, ext: string, data: ArrayBuffer): Promise<void> {
		const base = this.getBase().replace(/\/+$/, "");
		const token = this.getToken();
		if (!base || !token) throw new ApiError(0, "API URL or token is not configured (Settings → Linvau).");
		let res;
		try {
			res = await requestUrl({
				url: `${base}/v1/notes/${id}/assets/${hash}?ext=${encodeURIComponent(ext)}`,
				method: "PUT",
				headers: { Authorization: `Bearer ${token}` },
				contentType: "application/octet-stream",
				body: data,
				throw: false,
			});
		} catch (e) {
			throw new ApiError(0, `Network error: ${e instanceof Error ? e.message : String(e)}`);
		}
		if (res.status >= 400) {
			let msg = `HTTP ${res.status}`;
			try { msg = (res.json as { error?: string }).error ?? msg; } catch { /* non-JSON body */ }
			throw new ApiError(res.status, msg);
		}
	}
	suspend(id: string) { return this.call<{ state: string }>("POST", `/v1/notes/${id}/suspend`); }
	resume(id: string) { return this.call<{ state: string }>("POST", `/v1/notes/${id}/resume`); }
	regenerate(id: string) { return this.call<{ shareId: string; url: string }>("POST", `/v1/notes/${id}/regenerate`); }
	remove(id: string) { return this.call<{ ok: boolean }>("DELETE", `/v1/notes/${id}`); }
}
