/**
 * dsh-copilot-diff — the line diff.
 *
 * A plain LCS line diff with one twist: before walking a region it looks for a
 * long unique anchor line, so a change in a 6000-line file costs a few hundred
 * cells instead of thirty-six million. Regions too large to walk degrade to a
 * bulk replace instead of stalling the host.
 */

/** Context lines kept around every change when a hunk is built. */
const CONTEXT_LINES = 3;

/** Upper bound of DP cells spent on one diff region before falling back to a bulk replace. */
const MAX_DP_CELLS = 1_000_000;

/**
 * Split text into lines, treating an absent file as empty and dropping the
 * empty element a trailing newline produces (the diff never renders a phantom
 * last line for it).
 * @param text - file text, or null/undefined for an absent file.
 * @returns the lines.
 */
function splitLines(text) {
	if (typeof text !== "string" || text.length === 0) return [];
	const lines = text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/**
 * Find one line that occurs exactly once on each side, used to split a large
 * region into two smaller ones before falling back to a bulk replace.
 * The most balanced candidate wins, which keeps recursion shallow.
 * @param a - left lines.
 * @param a0 - left region start (inclusive).
 * @param a1 - left region end (exclusive).
 * @param b - right lines.
 * @param b0 - right region start (inclusive).
 * @param b1 - right region end (exclusive).
 * @returns the anchor pair, or null when the region shares no unique line.
 */
function findAnchor(a, a0, a1, b, b0, b1) {
	const countA = new Map();
	const countB = new Map();
	const posB = new Map();
	for (let i = a0; i < a1; i += 1) countA.set(a[i], (countA.get(a[i]) ?? 0) + 1);
	for (let j = b0; j < b1; j += 1) {
		const line = b[j];
		countB.set(line, (countB.get(line) ?? 0) + 1);
		posB.set(line, j);
	}
	let best = null;
	let bestScore = -1;
	for (let i = a0; i < a1; i += 1) {
		const line = a[i];
		if (countA.get(line) !== 1) continue;
		if (countB.get(line) !== 1) continue;
		const j = posB.get(line);
		const score = Math.min(i - a0, j - b0) + Math.min(a1 - i - 1, b1 - j - 1);
		if (score > bestScore) {
			bestScore = score;
			best = { ai: i, bi: j };
		}
	}
	return best;
}

/**
 * Longest-common-subsequence walk over one small region, emitting context,
 * deletion and addition operations in reading order.
 * @param a - left lines.
 * @param a0 - left region start (inclusive).
 * @param a1 - left region end (exclusive).
 * @param b - right lines.
 * @param b0 - right region start (inclusive).
 * @param b1 - right region end (exclusive).
 * @param out - operation sink.
 */
function lcsWalk(a, a0, a1, b, b0, b1, out) {
	const m = a1 - a0;
	const n = b1 - b0;
	if (m === 0) {
		for (let j = b0; j < b1; j += 1) out.push({ t: "+", s: b[j] });
		return;
	}
	if (n === 0) {
		for (let i = a0; i < a1; i += 1) out.push({ t: "-", s: a[i] });
		return;
	}
	const width = n + 1;
	const dp = new Uint32Array((m + 1) * width);
	for (let i = m - 1; i >= 0; i -= 1) {
		const row = i * width;
		const nextRow = row + width;
		for (let j = n - 1; j >= 0; j -= 1) {
			dp[row + j] =
				a[a0 + i] === b[b0 + j]
					? dp[nextRow + j + 1] + 1
					: Math.max(dp[nextRow + j], dp[row + j + 1]);
		}
	}
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (a[a0 + i] === b[b0 + j]) {
			out.push({ t: " ", s: a[a0 + i] });
			i += 1;
			j += 1;
		} else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
			out.push({ t: "-", s: a[a0 + i] });
			i += 1;
		} else {
			out.push({ t: "+", s: b[b0 + j] });
			j += 1;
		}
	}
	for (; i < m; i += 1) out.push({ t: "-", s: a[a0 + i] });
	for (; j < n; j += 1) out.push({ t: "+", s: b[b0 + j] });
}

/**
 * Diff one region: trim the shared prefix and suffix, split on a unique anchor
 * when the region is large, and fall back to a bulk replace when neither
 * strategy applies.
 * @param a - left lines.
 * @param a0 - left region start (inclusive).
 * @param a1 - left region end (exclusive).
 * @param b - right lines.
 * @param b0 - right region start (inclusive).
 * @param b1 - right region end (exclusive).
 * @param out - operation sink.
 * @param depth - remaining anchor recursion depth.
 */
function diffRegion(a, a0, a1, b, b0, b1, out, depth) {
	while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
		out.push({ t: " ", s: a[a0] });
		a0 += 1;
		b0 += 1;
	}
	let suffix = 0;
	while (a1 - suffix > a0 && b1 - suffix > b0 && a[a1 - suffix - 1] === b[b1 - suffix - 1]) suffix += 1;
	const aEnd = a1 - suffix;
	const bEnd = b1 - suffix;
	if (a0 < aEnd && b0 < bEnd) {
		const anchor = depth > 0 ? findAnchor(a, a0, aEnd, b, b0, bEnd) : null;
		if (anchor !== null) {
			diffRegion(a, a0, anchor.ai, b, b0, anchor.bi, out, depth - 1);
			out.push({ t: " ", s: a[anchor.ai] });
			diffRegion(a, anchor.ai + 1, aEnd, b, anchor.bi + 1, bEnd, out, depth - 1);
		} else if ((aEnd - a0) * (bEnd - b0) <= MAX_DP_CELLS) {
			lcsWalk(a, a0, aEnd, b, b0, bEnd, out);
		} else {
			for (let i = a0; i < aEnd; i += 1) out.push({ t: "-", s: a[i] });
			for (let j = b0; j < bEnd; j += 1) out.push({ t: "+", s: b[j] });
		}
	} else {
		for (let i = a0; i < aEnd; i += 1) out.push({ t: "-", s: a[i] });
		for (let j = b0; j < bEnd; j += 1) out.push({ t: "+", s: b[j] });
	}
	for (let k = suffix; k > 0; k -= 1) out.push({ t: " ", s: a[a1 - k] });
}

/**
 * Build the line rows of a unified diff, with both line numbers and a hunk id.
 * @param before - previous file text, or null for a creation.
 * @param after - new file text, or null for a deletion.
 * @returns hunks, plus the added/removed line counts.
 */
function buildDiff(before, after) {
	const a = splitLines(before);
	const b = splitLines(after);
	const ops = [];
	diffRegion(a, 0, a.length, b, 0, b.length, ops, 3);
	let added = 0;
	let removed = 0;
	let oldNo = 1;
	let newNo = 1;
	const rows = [];
	for (const op of ops) {
		if (op.t === "+") added += 1;
		else if (op.t === "-") removed += 1;
		rows.push({
			t: op.t,
			s: op.s,
			old: op.t === "+" ? null : oldNo,
			new: op.t === "-" ? null : newNo
		});
		if (op.t !== "+") oldNo += 1;
		if (op.t !== "-") newNo += 1;
	}
	const hunks = [];
	let current = null;
	for (let index = 0; index < rows.length; index += 1) {
		if (rows[index].t === " ") continue;
		const from = Math.max(0, index - CONTEXT_LINES);
		const to = Math.min(rows.length - 1, index + CONTEXT_LINES);
		if (current !== null && from <= current.to + 1) {
			current.to = Math.max(current.to, to);
		} else {
			if (current !== null) hunks.push(finishHunk(rows, current.from, current.to));
			current = { from, to };
		}
	}
	if (current !== null) hunks.push(finishHunk(rows, current.from, current.to));
	return { hunks, added, removed };
}

/**
 * Cut one hunk out of the row list and attach its unified header numbers.
 * @param rows - every diff row.
 * @param from - first row index kept.
 * @param to - last row index kept.
 * @returns the hunk.
 */
function finishHunk(rows, from, to) {
	const slice = rows.slice(from, to + 1);
	const oldLines = slice.filter((row) => row.t !== "+");
	const newLines = slice.filter((row) => row.t !== "-");
	return {
		oldStart: oldLines.length > 0 ? oldLines[0].old : 0,
		oldLines: oldLines.length,
		newStart: newLines.length > 0 ? newLines[0].new : 0,
		newLines: newLines.length,
		rows: slice
	};
}

export { buildDiff, splitLines };
