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
	verbose: boolean;
}

export interface LatencySample {
	ts: number;
	/** From the first local save (vault "modify") to the API acknowledging the version. SLA target: P95 < 15 s. */
	sinceEdit: number;
	/** Round trip of the publish request alone. */
	api: number;
	bytes: number;
}

export interface PluginData {
	settings: LinvauSettings;
	notes: Record<string, NoteRecord>;
	latencies: LatencySample[];
}

export const DEFAULT_SETTINGS: LinvauSettings = {
	apiBase: "",
	debounceSeconds: 5,
	verbose: false,
};

export const MAX_LATENCY_SAMPLES = 500;
export const MAX_NOTE_BYTES = 1_000_000;
export const TOKEN_KEY = "linvau-token";
