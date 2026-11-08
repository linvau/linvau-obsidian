export type NoteState = "PUBLISHING" | "ACTIVE" | "SUSPENDED" | "ERROR" | "ORPHAN" | "CONFLICT";

export interface NoteRecord {
	noteId: string;
	shareId: string;
	url: string;
	path: string;
	state: NoteState;
	version: number;
	hash: string | null;
	lastSyncAt: number | null;
	lastError?: string;
	/** Publish images and attachments embedded in the note. Default: true. */
	assetsEnabled?: boolean;
	/** Vault paths of embedded notes the author approved for this link. */
	approvedEmbeds?: string[];
	/** Embedded notes still waiting for approval (kept to notify only once and to show a count). */
	pendingEmbeds?: string[];
	/** The plugin (not the author) paused the link because the file disappeared: resume it when the file is back. */
	autoPaused?: boolean;
	/** Linked from the account list (published on another device): publish only after a local edit. */
	awaitLocalEdit?: boolean;
	/** Another device published a newer version: when this device first noticed, and what the server has. */
	conflictSince?: number;
	serverVersion?: number;
	serverHash?: string | null;
	/** The author chose "publish this device's version" for a conflict. */
	forcePublish?: boolean;
	/** Readers need a password to open the link (API 0.4.0). Known from the server; the password itself is never stored here. */
	protected?: boolean;
	/** Live: every save is published. Review: saves wait as a pending version until "Publish revision" (API 0.5.0). */
	mode?: "LIVE" | "REVIEW";
	/** Number of the pending version waiting for review (Review mode), if any. */
	pendingVersion?: number | null;
}

export interface LinvauSettings {
	/** Empty = the Linvau server (DEFAULT_API_BASE). Only set for development (Settings → Advanced). */
	apiBase: string;
	debounceSeconds: number;
	maxWaitSeconds: number;
	verbose: boolean;
}

export interface LatencySample {
	ts: number;
	/** From the LAST local save to the API acknowledging the version. SLA target: P95 < 15 s. */
	sinceLastSave: number;
	/** From the first save of the editing session (informational: how long a session was). */
	sinceFirstSave: number;
	/** Round trip of the publish request alone. */
	api: number;
	bytes: number;
	/**
	 * Why this publish was not a normal "save → live" flow. Such samples are reported apart and
	 * do not count toward the online sync SLA. Absent = normal online publish.
	 */
	cause?: "offline" | "retry" | "reconcile" | "background" | "upload" | "legacy-outlier";
}

export interface PluginData {
	settings: LinvauSettings;
	notes: Record<string, NoteRecord>;
	latencies: LatencySample[];
	/** Last log lines, kept across restarts so diagnostics survive closing the app. Stays on the device. */
	log?: { ts: number; level: "debug" | "info" | "warn" | "error"; msg: string }[];
}

/** The Linvau server. Built in: users never type it (D-54). */
export const DEFAULT_API_BASE = "https://api.linvau.com";

/** Earlier built-in addresses of the same server (D-63): a stored copy is treated as "use the built-in one". */
export const LEGACY_API_BASES = ["https://linvau-api-mock.linvau.workers.dev"];

export const DEFAULT_SETTINGS: LinvauSettings = {
	apiBase: "",
	debounceSeconds: 5,
	maxWaitSeconds: 30,
	verbose: false,
};

export const MAX_LATENCY_SAMPLES = 500;
/** Text limit per note (P-10): 400 KB, about 200 pages. The server checks it too. */
export const MAX_NOTE_BYTES = 400 * 1024;
