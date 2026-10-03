export type NoteState = "PUBLISHING" | "ACTIVE" | "SUSPENDED" | "ERROR" | "ORPHAN";

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
}

export interface LinvauSettings {
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
	cause?: "offline" | "retry" | "reconcile" | "background" | "legacy-outlier";
}

export interface PluginData {
	settings: LinvauSettings;
	notes: Record<string, NoteRecord>;
	latencies: LatencySample[];
	/** Last log lines, kept across restarts so diagnostics survive closing the app. Stays on the device. */
	log?: { ts: number; level: "debug" | "info" | "warn" | "error"; msg: string }[];
}

export const DEFAULT_SETTINGS: LinvauSettings = {
	apiBase: "",
	debounceSeconds: 5,
	maxWaitSeconds: 30,
	verbose: false,
};

export const MAX_LATENCY_SAMPLES = 500;
export const MAX_NOTE_BYTES = 1_000_000;
export const TOKEN_KEY = "linvau-token";
