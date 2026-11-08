/**
 * Change summary between the published and the pending text (Review mode). Line based and bounded:
 * common start and end are skipped, and very large differences fall back to counting lines, so a
 * 400 KB note never blocks the editor.
 */
export interface DiffLine { kind: "+" | "-"; text: string }
export interface ChangeSummary {
	added: number; removed: number;
	lines: DiffLine[];            // first changed lines, in order (bounded)
	sections: { title: string; change: "added" | "removed" | "changed" }[];
	titleChanged: boolean;
}

const MAX_CELLS = 4_000_000;
const MAX_LINES_SHOWN = 60;

export function lineDiff(a: string[], b: string[]): DiffLine[] {
	let s = 0;
	while (s < a.length && s < b.length && a[s] === b[s]) s++;
	let ea = a.length, eb = b.length;
	while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
	const A = a.slice(s, ea), B = b.slice(s, eb);
	if (!A.length) return B.map((text) => ({ kind: "+", text }));
	if (!B.length) return A.map((text) => ({ kind: "-", text }));
	if (A.length * B.length > MAX_CELLS) {
		// Too large for an exact diff: report by line counts.
		const left = new Map<string, number>();
		A.forEach((l) => left.set(l, (left.get(l) ?? 0) + 1));
		const out: DiffLine[] = [];
		for (const l of B) { const k = left.get(l) ?? 0; if (k) left.set(l, k - 1); else out.push({ kind: "+", text: l }); }
		for (const [l, k] of left) for (let i = 0; i < k; i++) out.push({ kind: "-", text: l });
		return out;
	}
	// Longest common subsequence, then walk it.
	const n = A.length, m = B.length, w = m + 1;
	const L = new Uint32Array((n + 1) * w);
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
		L[i * w + j] = A[i] === B[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
	}
	const out: DiffLine[] = [];
	let i = 0, j = 0;
	while (i < n && j < m) {
		if (A[i] === B[j]) { i++; j++; }
		else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) out.push({ kind: "-", text: A[i++] });
		else out.push({ kind: "+", text: B[j++] });
	}
	while (i < n) out.push({ kind: "-", text: A[i++] });
	while (j < m) out.push({ kind: "+", text: B[j++] });
	return out;
}

function sectionsOf(text: string): Map<string, string> {
	const out = new Map<string, string>();
	let title = "(beginning of the note)", body: string[] = [];
	const push = () => {
		let key = title, k = 2;
		while (out.has(key)) key = `${title} (${k++})`;
		out.set(key, body.join("\n").trim());
	};
	for (const line of text.split("\n")) {
		const h = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
		if (h) { push(); title = h[1]; body = []; } else body.push(line);
	}
	push();
	if (!out.get("(beginning of the note)")) out.delete("(beginning of the note)");
	return out;
}

export function summarize(published: { title: string; markdown: string } | null, pending: { title: string; markdown: string }): ChangeSummary {
	const before = (published?.markdown ?? "").split("\n"), after = pending.markdown.split("\n");
	const diff = lineDiff(before, after).filter((d) => d.text.trim() !== "");
	const a = sectionsOf(published?.markdown ?? ""), b = sectionsOf(pending.markdown);
	const sections: ChangeSummary["sections"] = [];
	for (const [t, body] of b) {
		if (!a.has(t)) sections.push({ title: t, change: "added" });
		else if (a.get(t) !== body) sections.push({ title: t, change: "changed" });
	}
	for (const t of a.keys()) if (!b.has(t)) sections.push({ title: t, change: "removed" });
	return {
		added: diff.filter((d) => d.kind === "+").length,
		removed: diff.filter((d) => d.kind === "-").length,
		lines: diff.slice(0, MAX_LINES_SHOWN),
		sections,
		titleChanged: !!published && published.title !== pending.title,
	};
}
