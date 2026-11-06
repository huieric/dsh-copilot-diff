/**
 * dsh-copilot-diff — server half.
 *
 * Records every successful file mutation (`edit`, `write`, `apply_patch`) as an
 * independent, per-call edit entry with its before/after text, computes a
 * unified diff for it, keeps the entries per session, and serves the
 * `/copilot-diff` connection channel the client bundle uses to render an inline
 * diff on every edit row and a turn-tail summary bar with Keep / Undo.
 *
 * Nothing here touches the model: the agent's tool calls are observed through
 * `tools/result`, so recording stays truthful even when a plugin is reloaded
 * mid-turn (the card then falls back to the un-diffed row).
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { buildDiff } from "./diff.js";
import { Checkpoints, totalsFor } from "./checkpoints.js";
import { findSessionLog, gitRecordsForTurn, readSessionEvents, recordsFromEvents, reposUnder, turnWindows } from "./history.js";

/** Cordis plugin name. */
export const name = "copilot-diff";

/**
 * Services this plugin needs before it can record or serve anything.
 *
 * `connection.register` installs its route through `owner.webServer.register(...)`,
 * so `webServer` must be declared here too — without it the plugin does not
 * activate at all (`cannot get property "webServer" without inject`).
 */
export const inject = ["fs", "connection", "webServer", "workspaceRegistry"];

/** Connection channel shared with the client bundle. */
const CHANNEL = "/copilot-diff";

/** Context lines kept around every change when a hunk is built. */

/** Upper bound of DP cells spent on one diff region before falling back to a bulk replace. */

/** Oldest entries dropped once a session holds more than this. */
const MAX_RECORDS = 400;

/** Same bound, used when records from disk are merged back in. */
const MAX_RECORDS_PERSISTED = MAX_RECORDS;

/** Pause between a mutation and its debounced write to disk. */
const SAVE_DELAY_MS = 400;

/** Identity of one stored record, used to merge two writers of the same file. */
function recordKey(record) {
	return `${record.callId}\u0000${record.path}`;
}

/** Modification time of a file, or undefined when it does not exist yet. */
function mtimeOf(file) {
	try {
		return statSync(file).mtimeMs;
	} catch {
		return undefined;
	}
}


//#region storage
/** Root of this plugin's durable state. */
function storageRoot() {
	const home = process.env.DSH_HOME?.trim();
	return join(home && home.length > 0 ? home : join(homedir(), ".dsh"), "copilot-diff");
}

/** Where the log lived before the rename; read once so nothing is lost. */
function legacyStorageRoot() {
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
		this.historyTried = false;
	}

	/** Absolute workspace root for this session, or the process directory. */
	cwd() {
		return this.api.workspaceOf(this.sessionId) ?? process.cwd();
	}

	/** Read the persisted log once. */
	load() {
		if (this.loaded) return;
		this.loaded = true;
		const file = sessionFileName(this.sessionId);
		for (const root of [storageRoot(), legacyStorageRoot()]) {
			const path = join(root, "sessions", file);
			try {
				const text = readFileSync(path, "utf8");
				const parsed = JSON.parse(text);
				if (Array.isArray(parsed.records)) this.records = parsed.records.filter(isRecord);
				if (typeof parsed.seq === "number") this.seq = parsed.seq;
				if (root === storageRoot()) this.wroteAt = mtimeOf(path);
				break;
			} catch {
				// Missing or unreadable: reclaim the next root, then start empty.
			}
		}
		this.file = join(storageRoot(), "sessions", file);
		if (this.records.length === 0) this.recoverHistory();
	}

	/**
	 * Recover a session that predates the plugin from its own log.
	 *
	 * Runs once per process and only for a session with nothing stored: the live
	 * path already wrote down everything it saw.
	 * @returns nothing.
	 */
	recoverHistory() {
		if (this.historyTried === true) return;
		this.historyTried = true;
		try {
			const file = findSessionLog(join(dirname(storageRoot()), "sessions"), this.sessionId);
			if (file === undefined) return;
			const events = readSessionEvents(file);
			const { records, added } = recordsFromEvents(events, this.records);
			if (added === 0 && records.length === 0) {
				// Nothing was recorded through the file tools: the turn's work may have
				// gone through a shell command, which only the repository still knows.
				const cwd = this.cwd();
				for (const window of turnWindows(events)) {
					for (const repo of reposUnder(cwd)) {
						const found = gitRecordsForTurn(repo, window, cwd, records.length + 1);
						for (const record of found.records) records.push(record);
					}
				}
				if (records.length > 0) {
					this.records = records;
					this.seq = Math.max(this.seq, records.length);
					this.revision += 1;
					this.saveNow();
					this.api.log(`copilot-diff: rebuilt ${records.length} changes for session ${this.sessionId}`);
				}
				return;
			}
			if (added === 0) return;
			this.records = records;
			this.seq = Math.max(this.seq, records.length);
			this.revision += 1;
			this.saveNow();
			this.api.log(`copilot-diff: recovered ${added} changes for session ${this.sessionId}`);
		} catch (error) {
			this.api.log(`copilot-diff: could not read the log of ${this.sessionId}: ${errorMessageOf(error)}`);
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

	/**
	 * Write the log atomically (temp file + rename).
	 *
	 * The stored file is shared: `tools/backfill.mjs` and an earlier host process
	 * may have written records this process never saw. When the file changed
	 * underneath us (its mtime is not the one we left), merge its records in
	 * before writing so a stale in-memory list cannot erase recovered history.
	 */
	saveNow() {
		try {
			const dir = join(storageRoot(), "sessions");
			mkdirSync(dir, { recursive: true });
			const file = this.file ?? join(dir, sessionFileName(this.sessionId));
			this.file = file;
			const modified = mtimeOf(file);
			if (modified !== undefined && modified !== this.wroteAt) this.mergeStored(file);
			const temp = `${file}.tmp`;
			writeFileSync(temp, JSON.stringify({ version: 1, seq: this.seq, records: this.records }), "utf8");
			renameSync(temp, file);
			this.wroteAt = mtimeOf(file);
		} catch (error) {
			this.api.log(`could not persist session ${this.sessionId}: ${errorMessageOf(error)}`);
		}
	}

	/**
	 * Adopt records another writer left in the stored file.
	 * @param file - absolute path of this session's log.
	 * @returns nothing.
	 */
	mergeStored(file) {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8"));
			if (!Array.isArray(parsed.records)) return;
			const known = new Set(this.records.map(recordKey));
			let added = 0;
			for (const record of parsed.records.filter(isRecord)) {
				if (known.has(recordKey(record))) continue;
				this.records.push(record);
				known.add(recordKey(record));
				added += 1;
			}
			if (added === 0) return;
			this.records.sort((left, right) => left.time - right.time);
			if (this.records.length > MAX_RECORDS_PERSISTED) this.records = this.records.slice(-MAX_RECORDS_PERSISTED);
			this.seq = Math.max(this.seq, this.records.length);
			this.api.log(`copilot-diff: merged ${added} stored changes for session ${this.sessionId}`);
		} catch {
			// Unreadable: keep what we have and let the write replace it.
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
			state: "open",
			readOnly: entry.readOnly === true
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

	/**
	 * Add a record that already carries its hunks.
	 *
	 * The workspace summary is computed by the Host from git snapshots, so the
	 * turn's changes arrive as hunks rather than as two file revisions; such a
	 * record has no copy to restore and stays informational (`kept`).
	 * @param entry - the record fields.
	 * @returns the stored record.
	 */
	addSnapshot(entry) {
		this.load();
		this.seq += 1;
		const record = {
			id: `w${this.seq}`,
			callId: entry.callId,
			tool: entry.tool,
			path: entry.path,
			absPath: entry.absPath,
			hunks: entry.hunks,
			added: entry.added,
			removed: entry.removed,
			created: entry.created === true,
			deleted: entry.deleted === true,
			time: entry.time,
			state: "kept"
		};
		this.records.push(record);
		if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS);
		this.revision += 1;
		this.scheduleSave();
		return record;
	}

	/**
	 * Replace one turn's workspace records.
	 *
	 * A later summary of the same turn (another tool changed a file) supersedes
	 * the earlier one, and a path a tool record already explains keeps its
	 * reversible record instead.
	 * @param turn - the turn number.
	 * @param records - the records that summary produced.
	 * @param covered - absolute paths already recorded by a tool call.
	 */
	absorbTurn(turn, records, covered) {
		this.load();
		const callId = `workspace:${turn}`;
		this.records = this.records.filter((record) => record.callId !== callId);
		for (const record of records) {
			if (covered.has(record.absPath)) continue;
			this.addSnapshot({ ...record, callId });
		}
	}

	/** Records whose timestamp falls inside one turn. */
	recordsIn(from, to) {
		this.load();
		return this.records.filter((record) => record.time >= from && record.time <= to);
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
		if (record.readOnly || (typeof record.before !== "string" && record.before !== null) || (typeof record.after !== "string" && record.after !== null)) return "Full original content unavailable; this record cannot be restored";
		let policy;
		try { policy = this.api.policy?.(this.sessionId); } catch (error) { return errorMessageOf(error); }
		if (policy?.mode === "read-only") return "Session filesystem policy is read-only";
		if (record.state === "reverted") return "Already undone";
		const cwd = this.cwd();
		let target;
		try {
			target = await fs.resolve(record.absPath, { cwd });
		} catch (error) {
			return `Could not resolve restore target: ${errorMessageOf(error)}`;
		}
		let current = null;
		try {
			current = await fs.readText(target);
		} catch (error) {
			if (error?.code !== "ENOENT") return `Could not read restore target: ${errorMessageOf(error)}`;
			current = null;
		}
		const expected = typeof record.after === "string" ? record.after : null;
		if (current !== expected) {
			return "The file changed after this edit — undo the newest edit first";
		}
		if (record.before === null) {
			try {
				await fs.deleteFile(target, undefined, undefined, policy);
			} catch (error) {
				return `Could not remove the created file: ${errorMessageOf(error)}`;
			}
		} else {
			try {
				await fs.writeText(target, record.before, undefined, undefined, policy);
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
/** Argument keys that name the file a tool mutates. */
const PATH_KEYS = ["filePath", "path", "file", "filename"];
/** Tools that express their change as text pairs in the arguments. */
const PAIR_TOOLS = new Set(["replace_string_in_file", "multi_replace_string_in_file", "edit_file", "multi_edit"]);
/** Tools that write a whole file from the arguments. */
const CONTENT_TOOLS = new Set(["create_file", "write_to_file"]);
/** Tools whose result value already carries the before/after text. */
const VALUE_TOOLS = new Set(["edit", "write", "str_replace_editor"]);
/** Every tool name this plugin records. */
const TRACKED = new Set([...VALUE_TOOLS, ...PAIR_TOOLS, ...CONTENT_TOOLS, "apply_patch"]);

/**
 * The file path a tool argument block names, if any. Editors disagree on the
 * key, so the common spellings are accepted.
 * @param args - raw tool arguments.
 * @returns the path, or undefined.
 */
function pathOf(args) {
	if (args === null || typeof args !== "object") return undefined;
	for (const key of PATH_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/**
 * Every (path, oldString, newString) triple a tool argument block expresses.
 * @param args - raw tool arguments.
 * @returns the pairs, empty for anything that is not a text replacement.
 */
function pairsOf(args) {
	if (args === null || typeof args !== "object") return [];
	const list = Array.isArray(args.replacements) ? args.replacements : Array.isArray(args.edits) ? args.edits : undefined;
	if (list !== undefined) {
		const pairs = [];
		for (const item of list) {
			const path = pathOf(item);
			const oldString = item?.oldString ?? item?.oldText;
			const newString = item?.newString ?? item?.newText;
			if (path !== undefined && typeof oldString === "string" && typeof newString === "string") {
				pairs.push({ path, oldString, newString });
			}
		}
		return pairs;
	}
	const path = pathOf(args);
	const oldString = args.oldString ?? args.oldText;
	const newString = args.newString ?? args.newText;
	if (path !== undefined && typeof oldString === "string" && typeof newString === "string") {
		return [{ path, oldString, newString }];
	}
	return [];
}

/**
 * Every file a tracked call is about to touch.
 * @param args - raw tool arguments.
 * @returns the distinct paths named by the arguments.
 */
function pathsOf(args) {
	const paths = new Set();
	const direct = pathOf(args);
	if (direct !== undefined) paths.add(direct);
	for (const pair of pairsOf(args)) paths.add(pair.path);
	return paths;
}

/**
 * Read a file's text, tolerating a missing or unreadable file.
 * @param fs - host filesystem service.
 * @param absPath - absolute path to read.
 * @param cwd - workspace root, for path resolution.
 * @returns the text, or undefined when the file cannot be read.
 */
async function readTextAt(fs, absPath, cwd) {
	try {
		const target = await fs.resolve(absPath, { cwd });
		return await fs.readText(target);
	} catch {
		return undefined;
	}
}

/**
 * The mutation a tool result describes, or nothing for anything else.
 * The snapshot taken before the call wins, because it is the only honest
 * before side for tools whose result carries no diff. Editor-style tools that
 * express their change as `oldString`/`newString` fall back to those fragments.
 * @param toolName - wire tool name.
 * @param value - canonical tool result value.
 * @param args - raw tool arguments.
 * @param snapshot - absolute path to text captured before the call ran.
 * @param cwd - workspace root, for relative display paths.
 * @param fs - host filesystem service.
 * @returns the entries this result produced.
 */
async function entriesOf(toolName, value, args, snapshot, cwd, fs) {
	if (VALUE_TOOLS.has(toolName) && value !== null && typeof value === "object") {
		const path = value.path;
		const abs = typeof path === "string" ? (isAbsolute(path) ? path : join(cwd, path)) : undefined;
		const captured = snapshot?.get(abs);
		const before = typeof captured === "string" ? captured : typeof value.before === "string" ? value.before : null;
		const actual = abs && snapshot ? await readTextAt(fs, abs, cwd) : undefined;
		const after = typeof actual === "string" ? actual : typeof value.after === "string" ? value.after : null;
		if (typeof path === "string" && (before !== null || after !== null) && before !== after) {
			const readOnly = before === null && value.created !== true && (value.before === undefined || value.kind === "update" || value.operation === "update") && typeof captured !== "string";
			return [{ tool: toolName, path, before, after, readOnly }];
		}
	}
	if (toolName === "apply_patch" && value !== null && typeof value === "object" && Array.isArray(value.operations)) {
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
	const entries = [];
	for (const named of pathsOf(args)) {
		const absPath = isAbsolute(named) ? named : join(cwd, named);
		const before = snapshot?.get(absPath);
		const current = await readTextAt(fs, absPath, cwd);
		if (typeof before === "string" || typeof current === "string") {
			const from = typeof before === "string" ? before : null;
			const to = typeof current === "string" ? current : null;
			if (from !== to) entries.push({ tool: toolName, path: absPath, before: from, after: to });
			continue;
		}
		// No snapshot and an unreadable file: show the fragments the arguments
		// carry, so an editor replace still renders a diff instead of nothing.
		const pairs = pairsOf(args).filter((pair) => (isAbsolute(pair.path) ? pair.path : join(cwd, pair.path)) === absPath);
		if (pairs.length === 0) continue;
		const from = pairs.map((pair) => pair.oldString).join("\n");
		const to = pairs.map((pair) => pair.newString).join("\n");
		if (from !== to) entries.push({ tool: toolName, path: absPath, before: from, after: to });
	}
	return entries;
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
		log: (message) => ctx.logger?.warn(`copilot-diff: ${message}`)
	};
	const logFor = (sessionId) => {
		let log = logs.get(sessionId);
		if (log === undefined) {
			log = new EditLog(sessionId, api);
			logs.set(sessionId, log);
		}
		return log;
	};

	const agents = new Map();
	let runtimeServices;
	if (typeof ctx.inject === "function") ctx.inject(["sessions", "sandboxPolicy", "agents"], scope => { runtimeServices = scope; });
	const writePolicy = (id) => {
		if (runtimeServices) {
			const session = runtimeServices.sessions.get(id);
			if (!session) throw new Error("Session unavailable for restore policy");
			return runtimeServices.sandboxPolicy.resolve({ session });
		}
		if (ctx.fs.sandboxMode !== undefined) throw new Error("Session sandbox policy unavailable; restore refused");
		return undefined;
	};
	const checkpoints = new Map();
	api.policy = writePolicy;
	const checkpointFor = (id) => {
		if (!checkpoints.has(id)) checkpoints.set(id, new Checkpoints(id, { root: () => workspaceOf(id), storage: storageRoot(), fs: ctx.fs, policy: () => writePolicy(id) }));
		return checkpoints.get(id);
	};
	const visibleRecords = (log, cp) => {
		log.load();
		const captured = cp.turns.filter(c => c.before && c.status !== "unavailable");
		return [...log.records.filter(r => !captured.some(c => {
			const inTurn = r.turn === c.turn || r.callId === `workspace:${c.turn}` || (r.time >= c.time && r.time <= (c.endTime ?? (cp.active === c.turn ? Infinity : c.time)));
			const path = relative(c.root, r.absPath ?? resolve(c.root, r.path));
			return inTurn && c.covered?.includes(path);
		})), ...captured.flatMap(c => c.records)];
	};
	const summaryFor = (log, cp) => {
		const records = visibleRecords(log, cp);
		return { revision: log.revision + cp.turns.reduce((n, c) => n + c.records.length, 0), records: records.map(({ before, after, hunks, ...r }) => r), totals: totalsFor(records), root: log.cwd(), checkpoints: cp.summaries() };
	};
	const keepCheckpoint = (cp, predicate) => cp.run(() => {
		let changed = 0;
		for (const r of cp.records()) if (predicate(r) && r.state === "open") { r.state = "kept"; changed += 1; }
		cp.persist(); return changed;
	});

	/** Text read just before a call ran, keyed by call id. */
	const snapshots = new Map();

	// Editors replace text through many tool names, and most of those results
	// carry no diff at all, so the before side is read here instead: whatever a
	// tracked call is about to touch is captured before it touches it.
	ctx.on(
		"tools/pre-execute",
		async (exec, next) => {
			const sessionId = exec.agent?.id;
			if (typeof sessionId === "string") {
				agents.set(sessionId, exec.agent);
				const cp = checkpointFor(sessionId);
				if (cp.active === null) {
					// Reloaded mid-turn: the actual session event stream supplies the numeric identity.
					const events = exec.agent?.session?.snapshotEvents?.() ?? [];
					const start = [...events].reverse().find(e => e.type === "turn/start" || e.type === "turn/end");
					if (start?.type === "turn/start") {
						const earlierTools = events.slice(events.indexOf(start) + 1).some(e => /tool/.test(e.type));
						await cp.start(start.data.turn, start.time);
						if (earlierTools) await cp.run(() => {
							const c = cp.turns.find(c => c.turn === start.data.turn);
							if (c && c.time === start.time) { c.before = undefined; c.status = "unavailable"; c.limitations.push("Plugin attached after tools had already run"); cp.persist(); }
						});
					}
				}
				await cp.queue;
			}
			if (!TRACKED.has(exec.name)) return next();
			if (typeof sessionId === "string") {
				try {
					const cwd = logFor(sessionId).cwd();
					const paths = pathsOf(exec.arguments);
					if (paths.size > 0) {
						const before = new Map();
						for (const named of paths) {
							const absPath = isAbsolute(named) ? named : join(cwd, named);
							before.set(absPath, await readTextAt(ctx.fs, absPath, cwd));
						}
						snapshots.set(exec.callId, before);
					}
				} catch {
					// A snapshot is an optimisation; the argument fragments remain.
				}
			}
			return next();
		},
		{ prepend: true }
	);

	ctx.on("tools/result", async (exec, result) => {
		const observedTurn = typeof exec.agent?.id === "string" ? checkpointFor(exec.agent.id).active : null;
		const session = exec.agent?.id;
		if (typeof session === "string") await checkpointFor(session).capture();
		const snapshot = snapshots.get(exec.callId);
		snapshots.delete(exec.callId);
		if (result?.isError !== false) return;
		const sessionId = exec.agent?.id;
		if (typeof sessionId !== "string") return;
		if (!TRACKED.has(exec.name)) return;
		const log = logFor(sessionId);
		const cwd = log.cwd();
		return entriesOf(exec.name, result.value, exec.arguments, snapshot, cwd, ctx.fs)
			.then((entries) => {
				for (const entry of entries) {
					const absPath = isAbsolute(entry.path) ? entry.path : join(cwd, entry.path);
					const record = log.add({ ...entry, callId: exec.callId, absPath });
					record.turn = observedTurn;
				}
			})
			.catch((error) => ctx.logger?.warn(`copilot-diff: ${errorMessageOf(error)}`));
	});

	// The Host snapshots the workspace around every turn (git tree ids) and
	// announces the outcome as `workspace/changes`. That summary is the only
	// source that also sees changes a shell command made, so it fills the turn
	// with records the file tools never reported. The service is optional: a
	// profile without `workspace-changes` keeps the tool-level records.
	let workspaceService;
	if (typeof ctx.inject === "function") {
		ctx.inject(["workspaceChanges"], (scope) => {
			const service = scope.workspaceChanges;
			attachWorkspaceSummaries(scope, service);
		});
	}

	function attachWorkspaceSummaries(_scope, service) { workspaceService = service; }
	ctx.on("agent/turn-stopping", async ({ agent, turn }) => {
		if (typeof agent?.id === "string") {
			agents.set(agent.id, agent);
			await checkpointFor(agent.id).capture(turn);
		}
	});
	const turnStarts = new Map();
	ctx.on("session/event", (session, event) => {
		const sessionId = session?.id;
		if (typeof sessionId !== "string") return;
		if (event.type === "turn/start") {
			const windows = turnStarts.get(sessionId) ?? new Map();
			windows.set(event.data.turn, event.time);
			turnStarts.set(sessionId, windows);
			return checkpointFor(sessionId).start(event.data.turn, event.time);
		}
		if (event.type === "turn/end") {
			const cp = checkpointFor(sessionId);
			const turn = event.data?.turn ?? cp.active;
			return cp.end(turn).then(() => { const c = cp.turns.find(c => c.turn === turn); if (c) { c.endTime = event.time; cp.persist(); } });
		}
		if (event.type !== "workspace/changes") return;
		const service = workspaceService;
		if (service === undefined) return;
		if (checkpointFor(sessionId).turns.some(c => c.turn === event.data.turn && c.before)) return;
		const turn = event.data.turn;
		const start = turnStarts.get(sessionId)?.get(turn) ?? 0;
		const finish = event.time;
		const log = logFor(sessionId);
		void (async () => {
			try {
				const summary = service.summary(sessionId, event.seq);
				if (summary === undefined || summary.files.length === 0) return;
				const controller = new AbortController();
				const records = [];
				for (let index = 0; index < summary.files.length; index += 1) {
					const file = summary.files[index];
					if (file.binary === true || file.oversized === true) continue;
					const diff = await service.diff(sessionId, event.seq, index, controller.signal);
					if (diff === undefined || diff.kind !== "text" || diff.hunks.length === 0) continue;
					const absPath = isAbsolute(file.path) ? file.path : resolve(log.cwd(), file.path);
					records.push({
						tool: "workspace",
						path: file.display ?? file.path,
						absPath,
						hunks: diff.hunks.map((hunk) => ({
							oldStart: hunk.oldStart,
							oldLines: hunk.oldLines,
							newStart: hunk.newStart,
							newLines: hunk.newLines,
							lines: hunk.lines
						})),
						added: file.added,
						removed: file.deleted,
						created: diff.before === false,
						deleted: diff.after === false,
						time: finish
					});
				}
				if (records.length === 0) return;
				const covered = new Set(
					log
						.recordsIn(start, finish)
						.filter((record) => typeof record.callId === "string" && !record.callId.startsWith("workspace:"))
						.map((record) => record.absPath)
				);
				log.absorbTurn(turn, records, covered);
			} catch (error) {
				ctx.logger?.warn(`copilot-diff: workspace summary failed: ${errorMessageOf(error)}`);
			}
		})();
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
				const cp = checkpointFor(id);
				await cp.queue;
				const totals = summaryFor(logFor(id), cp).totals;
				if (totals.edits > 0) sums[id] = totals;
			}
			return { ok: true, value: { sums } };
		}
		const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : undefined;
		if (sessionId === undefined) return rpcError("A session id is required");
		const log = logFor(sessionId);
		const cp = checkpointFor(sessionId);
		await cp.queue;
		const summary = () => summaryFor(log, cp);
		const restore = async (turn, only) => {
			let result;
			try {
				const agent = runtimeServices?.agents.get(sessionId) ?? agents.get(sessionId);
				result = await (typeof agent?.runMaintenance === "function" ? agent.runMaintenance(() => cp.restore(turn, only)) : cp.restore(turn, only));
			} catch (error) { return { ok: false, error: { code: "conflict", message: errorMessageOf(error), details: {} } }; }
			if (result.conflict) return { ok: false, error: { code: "conflict", message: result.conflict, details: { failures: result.failures ?? [] } } };
			return { ok: true, value: { ...summary(), ...result } };
		};
		switch (endpoint) {
			case "checkpoints": return { ok: true, value: { checkpoints: cp.summaries() } };
			case "review-turn": {
				if (!Number.isSafeInteger(payload.turn)) return rpcError("A numeric turn is required");
				const checkpoint = cp.turns.find(c => c.turn === payload.turn);
				const records = checkpoint?.before ? visibleRecords(log, cp).filter(r => r.turn === payload.turn || r.callId === `workspace:${payload.turn}`) : log.records.filter(r => r.turn === payload.turn || r.callId === `workspace:${payload.turn}`);
				return { ok: true, value: { records, totals: totalsFor(records), root: log.cwd() } };
			}
			case "restore-checkpoint": return restore(payload.turn);
			case "list":
				return { ok: true, value: summary() };
			case "detail": {
				const callId = typeof payload?.callId === "string" ? payload.callId : undefined;
				const records = callId === undefined ? [] : [...log.byCall(callId), ...cp.records().filter(r => r.callId === callId)];
				return { ok: true, value: { records } };
			}
			case "keep": {
				const id = typeof payload?.id === "string" ? payload.id : undefined;
				const changed = log.keep(id) + await keepCheckpoint(cp, r => id === undefined || r.id === id);
				return { ok: true, value: { changed, ...summary() } };
			}
			case "keep-all":
				return { ok: true, value: { changed: log.keep(undefined) + await keepCheckpoint(cp, () => true), ...summary() } };
			case "revert": {
				const net = cp.records().find(r => r.id === payload.id);
				if (net) return restore(net.turn, r => r.id === net.id);
				const id = typeof payload?.id === "string" ? payload.id : undefined;
				const record = id === undefined ? undefined : log.byId(id);
				if (record === undefined) return rpcError("No such edit");
				const failure = await log.revert(record);
				if (failure !== undefined) return { ok: false, error: { code: "conflict", message: failure, details: {} } };
				return { ok: true, value: summary() };
			}
			case "revert-all": {
				const first = cp.turns.find(c => c.records.some(r => r.state === "open"));
				if (first) {
					const uncovered = visibleRecords(log, cp).filter(r => r.state === "open" && !r.id.startsWith("checkpoint:"));
					if (uncovered.length) return { ok: false, error: { code: "conflict", message: "Some files lack checkpoint coverage; undo those individual edits first", details: { paths: uncovered.map(r => r.path) } } };
					return restore(first.turn, r => r.state === "open");
				}
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
				return { ok: true, value: { reverted, failures, ...summary() } };
			}
			case "keep-turn": {
				if (Number.isSafeInteger(payload.turn)) {
					let changed = await keepCheckpoint(cp, r => r.turn === payload.turn);
					for (const r of log.records.filter(r => r.turn === payload.turn)) changed += log.keep(r.id);
					return { ok: true, value: { changed, ...summary() } };
				}
				const from = typeof payload?.from === "number" ? payload.from : 0;
				const to = typeof payload?.to === "number" ? payload.to : Number.MAX_SAFE_INTEGER;
				let changed = 0;
				for (const record of log.records) {
					if (record.time < from || record.time > to || record.state !== "open") continue;
					if (log.keep(record.id)) changed += 1;
				}
				return { ok: true, value: { changed, ...summary() } };
			}
			case "revert-turn": {
				if (Number.isSafeInteger(payload.turn)) {
					const uncovered = visibleRecords(log, cp).filter(r => r.turn === payload.turn && r.state === "open" && !r.id.startsWith("checkpoint:"));
					if (uncovered.length) return { ok: false, error: { code: "conflict", message: "Some turn files lack checkpoint coverage; undo those individual edits first", details: { paths: uncovered.map(r => r.path) } } };
					return restore(payload.turn, r => r.turn === payload.turn && r.state === "open");
				}
				const from = typeof payload?.from === "number" ? payload.from : 0;
				const to = typeof payload?.to === "number" ? payload.to : Number.MAX_SAFE_INTEGER;
				const failures = [];
				let reverted = 0;
				const candidates = log.records
					.filter((record) => record.time >= from && record.time <= to && record.state === "open")
					.reverse();
				for (const record of candidates) {
					const failure = await log.revert(record);
					if (failure === undefined) reverted += 1;
					else failures.push({ path: record.path, message: failure });
				}
				if (failures.length > 0 && reverted === 0) {
					return { ok: false, error: { code: "conflict", message: failures[0].message, details: { failures } } };
				}
				return { ok: true, value: { reverted, failures, ...summary() } };
			}
			case "clear": {
				await keepCheckpoint(cp, () => true);
				log.records = [];
				log.revision += 1;
				log.scheduleSave();
				return { ok: true, value: summary() };
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
	}, "copilot-diff: review channel");

	return async () => {
		for (const cp of checkpoints.values()) await cp.queue;
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
export { buildDiff, splitLines } from "./diff.js";
export { recordsFromEvents, findSessionLog, readSessionEvents, sessionFileName as historyFileName } from "./history.js";
