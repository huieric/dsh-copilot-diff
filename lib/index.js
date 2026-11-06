/**
 * dsh-live-diff — server half.
 *
 * Records every successful file mutation (`edit`, `write`, `apply_patch`) as an
 * independent, per-call edit entry with its before/after text, computes a
 * unified diff for it, keeps the entries per session, and serves the
 * `/live-diff` connection channel the client bundle uses to render an inline
 * diff on every edit row and a turn-tail summary bar with Keep / Undo.
 *
 * Nothing here touches the model: the agent's tool calls are observed through
 * `tools/result`, so recording stays truthful even when a plugin is reloaded
 * mid-turn (the card then falls back to the un-diffed row).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** Cordis plugin name. */
export const name = "live-diff";

/**
 * Services this plugin needs before it can record or serve anything.
 *
 * `connection.register` installs its route through `owner.webServer.register(...)`,
 * so `webServer` must be declared here too — without it the plugin does not
 * activate at all (`cannot get property "webServer" without inject`).
 */
export const inject = ["fs", "connection", "webServer", "workspaceRegistry"];

/** Connection channel shared with the client bundle. */
const CHANNEL = "/live-diff";

/** Context lines kept around every change when a hunk is built. */
const CONTEXT_LINES = 3;

/** Upper bound of DP cells spent on one diff region before falling back to a bulk replace. */
const MAX_DP_CELLS = 1_000_000;

/** Oldest entries dropped once a session holds more than this. */
const MAX_RECORDS = 400;

/** Pause between a mutation and its debounced write to disk. */
const SAVE_DELAY_MS = 400;

//#region text + diff engine
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
//#endregion

//#region storage
/** Root of this plugin's durable state. */
function storageRoot() {
	const home = process.env.DSH_HOME?.trim();
	return join(home && home.length > 0 ? home : join(homedir(), ".dsh"), "live-diff");
}

/**
 * Turn a session id into a file name that is safe on every platform.
 * @param sessionId - session identity.
 * @returns the file name.
 */
function sessionFileName(sessionId) {
	return `${sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120)}.json`;
}

/**
 * Per-session edit log: order, stats, persistence and the undo primitive.
 */
class EditLog {
	/**
	 * @param sessionId - session this log belongs to.
	 * @param api - plugin services ({ fs, workspaceOf, log }).
	 */
	constructor(sessionId, api) {
		this.sessionId = sessionId;
		this.api = api;
		this.records = [];
		this.revision = 0;
		this.seq = 0;
		this.saveTimer = null;
		this.loaded = false;
	}

	/** Absolute workspace root for this session, or the process directory. */
	cwd() {
		return this.api.workspaceOf(this.sessionId) ?? process.cwd();
	}

	/** Read the persisted log once. */
	load() {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const raw = readFileSync(join(storageRoot(), "sessions", sessionFileName(this.sessionId)), "utf8");
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed.records)) this.records = parsed.records.filter(isRecord);
			if (typeof parsed.seq === "number") this.seq = parsed.seq;
		} catch {
			// A first run (or an unreadable file) simply starts empty.
		}
	}

	/** Schedule a debounced write of the whole log. */
	scheduleSave() {
		if (this.saveTimer !== null) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			this.saveNow();
		}, SAVE_DELAY_MS);
		this.saveTimer.unref?.();
	}

	/** Write the log atomically (temp file + rename). */
	saveNow() {
		try {
			const dir = join(storageRoot(), "sessions");
			mkdirSync(dir, { recursive: true });
			const file = join(dir, sessionFileName(this.sessionId));
			const temp = `${file}.tmp`;
			writeFileSync(temp, JSON.stringify({ version: 1, seq: this.seq, records: this.records }), "utf8");
			renameSync(temp, file);
		} catch (error) {
			this.api.log(`could not persist session ${this.sessionId}: ${errorMessageOf(error)}`);
		}
	}

	/**
	 * Append one mutation as an independent entry.
	 * @param entry - call identity, tool, path and text pair.
	 * @returns the stored record.
	 */
	add(entry) {
		this.load();
		this.seq += 1;
		const { hunks, added, removed } = buildDiff(entry.before, entry.after);
		const record = {
			id: `e${this.seq}`,
			callId: entry.callId,
			tool: entry.tool,
			path: entry.path,
			absPath: entry.absPath,
			before: entry.before,
			after: entry.after,
			hunks,
			added,
			removed,
			created: entry.before === null,
			deleted: entry.after === null,
			time: Date.now(),
			state: "open"
		};
		this.records.push(record);
		if (this.records.length > MAX_RECORDS) {
			const dropped = this.records.length - MAX_RECORDS;
			this.records.splice(0, dropped);
		}
		this.revision += 1;
		this.scheduleSave();
		return record;
	}

	/** Entries for one tool call, in call order. */
	byCall(callId) {
		this.load();
		return this.records.filter((record) => record.callId === callId);
	}

	/** One entry by id. */
	byId(id) {
		this.load();
		return this.records.find((record) => record.id === id);
	}

	/** Session totals over every entry still visible to the reviewer. */
	totals() {
		this.load();
		const paths = new Set();
		const openPaths = new Set();
		let added = 0;
		let removed = 0;
		let open = 0;
		for (const record of this.records) {
			paths.add(record.path);
			added += record.added;
			removed += record.removed;
			if (record.state === "open") {
				open += 1;
				openPaths.add(record.path);
			}
		}
		return {
			edits: this.records.length,
			files: paths.size,
			open,
			openFiles: openPaths.size,
			added,
			removed
		};
	}

	/** Summary shape for the list/stats endpoints (no hunk bodies). */
	summary() {
		const totals = this.totals();
		return {
			revision: this.revision,
			totals,
			records: this.records.map((record) => ({
				id: record.id,
				callId: record.callId,
				tool: record.tool,
				path: record.path,
				added: record.added,
				removed: record.removed,
				created: record.created,
				deleted: record.deleted,
				time: record.time,
				state: record.state
			}))
		};
	}

	/** Mark entries kept, optionally everything still open. */
	keep(id) {
		this.load();
		const targets = id === undefined ? this.records.filter((r) => r.state === "open") : [this.byId(id)];
		let changed = 0;
		for (const record of targets) {
			if (record === undefined || record.state === "kept") continue;
			if (record.state === "reverted") continue;
			record.state = "kept";
			changed += 1;
		}
		if (changed > 0) {
			this.revision += 1;
			this.scheduleSave();
		}
		return changed;
	}

	/**
	 * Undo one entry by writing its `before` text back, but only while the file
	 * still holds exactly the `after` text that edit produced: an undo never
	 * discards a later, unrelated mutation.
	 * @param record - entry to undo.
	 * @returns undefined on success, or a human-readable refusal.
	 */
	async revert(record) {
		const { fs } = this.api;
		if (record.state === "reverted") return "Already undone";
		const cwd = this.cwd();
		let target;
		try {
			target = await fs.resolve(record.absPath, { cwd });
		} catch {
			// The file is gone; an undone creation has nothing left to restore.
			record.state = "reverted";
			this.revision += 1;
			this.scheduleSave();
			return undefined;
		}
		let current = null;
		try {
			current = await fs.readText(target);
		} catch {
			current = null;
		}
		const expected = typeof record.after === "string" ? record.after : null;
		if (current !== expected) {
			return "The file changed after this edit — undo the newest edit first";
		}
		if (record.before === null) {
			try {
				await fs.deleteFile(target);
			} catch (error) {
				return `Could not remove the created file: ${errorMessageOf(error)}`;
			}
		} else {
			try {
				await fs.writeText(target, record.before);
			} catch (error) {
				return `Could not restore the file: ${errorMessageOf(error)}`;
			}
		}
		record.state = "reverted";
		this.revision += 1;
		this.scheduleSave();
		return undefined;
	}
}

/**
 * Whether a parsed row still looks like a usable record (guards old files).
 * @param value - candidate.
 * @returns whether it can be rendered.
 */
function isRecord(value) {
	return (
		value !== null &&
		typeof value === "object" &&
		typeof value.id === "string" &&
		typeof value.callId === "string" &&
		typeof value.path === "string" &&
		Array.isArray(value.hunks)
	);
}

/**
 * Readable text for a thrown value.
 * @param error - thrown value.
 * @returns the message.
 */
function errorMessageOf(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The mutation a tool result describes, or undefined for anything else.
 * `before === after` is a no-op and never becomes an entry.
 * @param toolName - wire tool name.
 * @param value - canonical tool result value.
 * @param cwd - workspace root, for relative display paths.
 * @returns the entries this result produced.
 */
function entriesOf(toolName, value, cwd) {
	if (value === null || typeof value !== "object") return [];
	if (toolName === "edit" || toolName === "write" || toolName === "str_replace_editor") {
		const path = value.path;
		const before = typeof value.before === "string" ? value.before : null;
		const after = typeof value.after === "string" ? value.after : null;
		if (typeof path !== "string" || (before === null && after === null)) return [];
		if (before === after) return [];
		return [{ tool: toolName, path, before, after }];
	}
	if (toolName === "apply_patch") {
		if (!Array.isArray(value.operations)) return [];
		const entries = [];
		for (const operation of value.operations) {
			if (operation?.status !== "completed" || !Array.isArray(operation.changes)) continue;
			for (const change of operation.changes) {
				const path = change?.path;
				const before = typeof change.before === "string" ? change.before : null;
				const after = typeof change.after === "string" ? change.after : null;
				if (typeof path !== "string" || (before === null && after === null)) continue;
				if (before === after) continue;
				entries.push({ tool: "apply_patch", path, before, after });
			}
		}
		return entries;
	}
	return [];
}

/** Wrap a thrown message in the channel's failure shape. */
function rpcError(message) {
	return { ok: false, error: { code: "internal", message, details: {} } };
}
//#endregion

/**
 * Record mutations, keep one log per session, and serve the client channel.
 * @param ctx - host plugin context.
 */
export async function apply(ctx) {
	const logs = new Map();
	/** Workspace root recorded for a session, when the registry knows it. */
	const workspaceOf = (sessionId) => {
		try {
			for (const workspace of ctx.workspaceRegistry.list()) {
				if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) {
					return typeof workspace.path === "string" ? workspace.path : undefined;
				}
			}
		} catch {
			// A registry without entries is not an error here.
		}
		return undefined;
	};
	const api = {
		fs: ctx.fs,
		workspaceOf,
		log: (message) => ctx.logger?.warn(`live-diff: ${message}`)
	};
	const logFor = (sessionId) => {
		let log = logs.get(sessionId);
		if (log === undefined) {
			log = new EditLog(sessionId, api);
			logs.set(sessionId, log);
		}
		return log;
	};

	ctx.on("tools/result", (exec, result) => {
		if (result?.isError !== false) return;
		const sessionId = exec.agent?.id;
		if (typeof sessionId !== "string") return;
		if (exec.name !== "edit" && exec.name !== "write" && exec.name !== "apply_patch") return;
		const log = logFor(sessionId);
		const cwd = log.cwd();
		let entries;
		try {
			entries = entriesOf(exec.name, result.value, cwd);
		} catch {
			return;
		}
		for (const entry of entries) {
			const absPath = isAbsolute(entry.path) ? entry.path : join(cwd, entry.path);
			log.add({ ...entry, callId: exec.callId, absPath });
		}
	});

	const handle = async (endpoint, payload) => {
		// Batch read for the session list: one reply for every visible row, so a
		// sidebar of forty sessions costs one round trip per poll instead of forty.
		if (endpoint === "summaries") {
			const ids = Array.isArray(payload?.sessionIds)
				? payload.sessionIds.filter((id) => typeof id === "string").slice(0, 200)
				: [];
			const sums = {};
			for (const id of ids) {
				const totals = logFor(id).totals();
				if (totals.edits > 0) sums[id] = totals;
			}
			return { ok: true, value: { sums } };
		}
		const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;
		if (sessionId === undefined) return rpcError("A session id is required");
		const log = logFor(sessionId);
		switch (endpoint) {
			case "list":
				return { ok: true, value: log.summary() };
			case "detail": {
				const callId = typeof payload?.callId === "string" ? payload.callId : undefined;
				const records = callId === undefined ? [] : log.byCall(callId);
				return { ok: true, value: { records } };
			}
			case "keep": {
				const id = typeof payload?.id === "string" ? payload.id : undefined;
				return { ok: true, value: { changed: log.keep(id), ...log.summary() } };
			}
			case "keep-all":
				return { ok: true, value: { changed: log.keep(undefined), ...log.summary() } };
			case "revert": {
				const id = typeof payload?.id === "string" ? payload.id : undefined;
				const record = id === undefined ? undefined : log.byId(id);
				if (record === undefined) return rpcError("No such edit");
				const failure = await log.revert(record);
				if (failure !== undefined) return { ok: false, error: { code: "conflict", message: failure, details: {} } };
				return { ok: true, value: log.summary() };
			}
			case "revert-all": {
				const failures = [];
				let reverted = 0;
				const candidates = log.records.filter((record) => record.state === "open").reverse();
				for (const record of candidates) {
					const failure = await log.revert(record);
					if (failure === undefined) reverted += 1;
					else failures.push({ path: record.path, message: failure });
				}
				if (failures.length > 0 && reverted === 0) {
					return {
						ok: false,
						error: { code: "conflict", message: failures[0].message, details: { failures } }
					};
				}
				return { ok: true, value: { reverted, failures, ...log.summary() } };
			}
			case "clear": {
				log.records = [];
				log.revision += 1;
				log.scheduleSave();
				return { ok: true, value: log.summary() };
			}
			default:
				return rpcError(`unknown endpoint ${JSON.stringify(endpoint)}`);
		}
	};

	ctx.effect(() => {
		const service = ctx.connection;
		return typeof service.register === "function"
			? service.register(ctx, CHANNEL, handle, { authority: "trusted-host" })
			: service.rpc.handle(CHANNEL, handle, { authority: "trusted-host" });
	}, "live-diff: review channel");

	return async () => {
		for (const log of logs.values()) {
			if (log.saveTimer !== null) {
				clearTimeout(log.saveTimer);
				log.saveTimer = null;
			}
			log.saveNow();
		}
		logs.clear();
	};
}

// Exposed for the unit tests: the diff engine is pure and independent of the host.
export { buildDiff, splitLines };
