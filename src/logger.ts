export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
	ts: number;
	level: LogLevel;
	msg: string;
}

const MAX_ENTRIES = 300;

/** In-memory log. Nothing leaves the device unless the author explicitly exports it (no telemetry). */
export class Logger {
	entries: LogEntry[] = [];
	verbose = false;
	private listeners = new Set<() => void>();

	debug(msg: string) { this.push("debug", msg); }
	info(msg: string) { this.push("info", msg); }
	warn(msg: string) { this.push("warn", msg); }
	error(msg: string) { this.push("error", msg); }

	private push(level: LogLevel, msg: string) {
		if (level === "debug" && !this.verbose) return;
		this.entries.push({ ts: Date.now(), level, msg });
		if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
		this.listeners.forEach((fn) => fn());
	}

	clear() {
		this.entries = [];
		this.listeners.forEach((fn) => fn());
	}

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}
}
