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
import { dirname, isAbsolute, join } from "node:path";
import { buildDiff } from "./diff.js";
import { findSessionLog, readSessionEvents, recordsFromEvents } from "./history.js";

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
			const { records, added } = recordsFromEvents(readSessionEvents(file), this.records);
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
		const before = typeof value.before === "string" ? value.before : null;
		const after = typeof value.after === "string" ? value.after : null;
		if (typeof path === "string" && (before !== null || after !== null) && before !== after) {
			return [{ tool: toolName, path, before, after }];
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

	/** Text read just before a call ran, keyed by call id. */
	const snapshots = new Map();

	// Editors replace text through many tool names, and most of those results
	// carry no diff at all, so the before side is read here instead: whatever a
	// tracked call is about to touch is captured before it touches it.
	ctx.on(
		"tools/pre-execute",
		async (exec, next) => {
			if (!TRACKED.has(exec.name)) return next();
			const sessionId = exec.agent?.id;
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

	ctx.on("tools/result", (exec, result) => {
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
					log.add({ ...entry, callId: exec.callId, absPath });
				}
			})
			.catch((error) => ctx.logger?.warn(`copilot-diff: ${errorMessageOf(error)}`));
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
				return { ok: true, value: { ...log.summary(), root: log.cwd() } };
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
			case "keep-turn": {
				const from = typeof payload?.from === "number" ? payload.from : 0;
				const to = typeof payload?.to === "number" ? payload.to : Number.MAX_SAFE_INTEGER;
				let changed = 0;
				for (const record of log.records) {
					if (record.time < from || record.time > to || record.state !== "open") continue;
					if (log.keep(record.id)) changed += 1;
				}
				return { ok: true, value: { changed, ...log.summary() } };
			}
			case "revert-turn": {
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
	}, "copilot-diff: review channel");

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
export { buildDiff, splitLines } from "./diff.js";
export { recordsFromEvents, findSessionLog, readSessionEvents, sessionFileName as historyFileName } from "./history.js";
