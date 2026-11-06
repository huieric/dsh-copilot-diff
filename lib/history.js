/**
 * Reading history out of the session logs.
 *
 * The plugin sees the tool calls that happen while it is loaded. Everything
 * older still exists though: each session keeps a JSONL log that holds every
 * `tool/call` and `tool/result`, and most file mutations carry their own
 * before/after text — the file-review presentation metadata, or the argument
 * pair of a replace-style tool. This module turns such a log into the same
 * records the live path would have written, so a session opened for the first
 * time is not blank.
 *
 * It has no DSH imports: the server half, the CLI (`tools/backfill.mjs`) and
 * the tests all use it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { buildDiff } from "./index.js";

/** Kept in step with the plugin's own retention. */
export const MAX_RECORDS = 400;

/** Longest before/after text stored per record; hunks keep the full picture. */
export const TEXT_CAP = 20_000;

/** Tools that express their change as a text pair in the arguments. */
const PAIR_TOOLS = new Set(["replace_string_in_file", "multi_replace_string_in_file", "edit_file", "multi_edit"]);

/** Tools that create or overwrite a whole file from an argument. */
const CONTENT_TOOLS = new Set(["create_file", "write_to_file"]);

/** Tools that carry their own before/after in the result metadata. */
const META_TOOLS = new Set(["edit", "write", "apply_patch", "str_replace_editor"]);

/** Log file names, most preferred first. */
const LOG_NAMES = ["session.v4.jsonl.zstd", "session.v4.jsonl", "session.jsonl.zstd", "session.jsonl"];

/**
 * One session id as the plugin names its state file.
 * @param sessionId - session identity.
 * @returns the file name.
 */
export function sessionFileName(sessionId) {
	return `${sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-120)}.json`;
}

/**
 * The log of one session, wherever its workspace directory sits.
 * @param sessionsRoot - `$DSH_HOME/sessions`.
 * @param sessionId - session identity.
 * @returns the absolute log path, or undefined.
 */
export function findSessionLog(sessionsRoot, sessionId) {
	if (!existsSync(sessionsRoot)) return undefined;
	for (const workspace of readdirSync(sessionsRoot)) {
		const dir = join(sessionsRoot, workspace, sessionId);
		if (!existsSync(dir)) continue;
		for (const name of LOG_NAMES) {
			const file = join(dir, name);
			if (existsSync(file)) return file;
		}
	}
	return undefined;
}

/**
 * Decoded events of one log.
 * @param file - absolute path.
 * @returns parsed events; unreadable lines are skipped.
 */
export function readSessionEvents(file) {
	const buffer = readFileSync(file);
	const text = file.endsWith(".zstd") ? zstdDecompressSync(buffer).toString("utf8") : buffer.toString("utf8");
	const events = [];
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue;
		try {
			events.push(JSON.parse(line));
		} catch {
			// A torn tail line is not worth failing the whole session over.
		}
	}
	return events;
}

/**
 * A JSON-shaped argument object, or `{}`.
 * @param raw - tool call `arguments`, usually a JSON string.
 * @returns the object.
 */
function argsOf(raw) {
	if (raw !== null && typeof raw === "object") return raw;
	if (typeof raw !== "string" || raw.trim().length === 0) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed !== null && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

/**
 * The file a mutation names.
 * @param item - argument object.
 * @returns the path, or undefined.
 */
function pathOf(item) {
	const path = item.file_path ?? item.filePath ?? item.path ?? item.file ?? item.filename;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

/**
 * Candidate text under any of several key spellings.
 * @param item - argument object.
 * @param keys - spellings, first match wins.
 * @returns the string, or undefined.
 */
function textOf(item, keys) {
	for (const key of keys) {
		const value = item[key];
		if (typeof value === "string") return value;
	}
	return undefined;
}

/**
 * The changes a replace-style argument pair describes.
 * @param args - call arguments.
 * @returns `[{ path, before, after }]`.
 */
function pairsOf(args) {
	const list = Array.isArray(args.replacements) ? args.replacements : Array.isArray(args.edits) ? args.edits : undefined;
	const items = list === undefined ? [args] : list;
	const entries = [];
	for (const item of items) {
		if (item === null || typeof item !== "object") continue;
		const path = pathOf(item);
		if (path === undefined) continue;
		const before = textOf(item, ["oldString", "old_string", "oldText", "old_text"]);
		const after = textOf(item, ["newString", "new_string", "newText", "new_text"]);
		if (after === undefined || before === after) continue;
		entries.push({ path, before: before ?? null, after });
	}
	return entries;
}

/**
 * The change a whole-file argument describes.
 * @param path - the file.
 * @param args - call arguments.
 * @returns `[{ path, before, after }]`.
 */
function contentOf(path, args) {
	const content = textOf(args, ["content", "fileContent", "file_content", "text"]);
	return content === undefined ? [] : [{ path, before: null, after: content }];
}

/**
 * The changes one tool call produced.
 * @param name - wire tool name.
 * @param args - call arguments.
 * @param meta - `dshFileReview` metadata, when the result carried it.
 * @returns `[{ path, before, after }]`.
 */
export function entriesOfCall(name, args, meta) {
	const entries = [];
	const files = Array.isArray(meta?.files) ? meta.files : [];
	for (const file of files) {
		for (const diff of Array.isArray(file?.diffs) ? file.diffs : []) {
			if (typeof diff?.path !== "string") continue;
			const before = typeof diff.oldText === "string" ? diff.oldText : null;
			const after = typeof diff.newText === "string" ? diff.newText : null;
			if (before === null && after === null) continue;
			if (before === after) continue;
			entries.push({ path: diff.path, before, after });
		}
	}
	if (entries.length > 0) return entries;
	if (PAIR_TOOLS.has(name)) return pairsOf(args);
	const path = pathOf(args);
	if (path === undefined) return entries;
	if (CONTENT_TOOLS.has(name)) return contentOf(path, args);
	if (META_TOOLS.has(name)) {
		const before = textOf(args, ["oldString", "old_string", "oldText", "old_text"]);
		const after = textOf(args, ["newString", "new_string", "newText", "new_text"]);
		if (after !== undefined) return before === after ? [] : [{ path, before: before ?? null, after }];
		return contentOf(path, args);
	}
	return entries;
}

/**
 * Stored form of a text, clipped when it would bloat the state file.
 * @param text - before or after text.
 * @returns `[text, clipped]`.
 */
function keepText(text) {
	if (text === null) return [null, false];
	if (text.length <= TEXT_CAP) return [text, false];
	return [`${text.slice(0, TEXT_CAP)}\n… [truncated]`, true];
}

/**
 * Records recovered from one session log, merged over what is already stored.
 *
 * Recovered records are `state: "kept"` on purpose: they are history, and
 * "Undo" on them could not be honest about the file as it stands today.
 * @param events - parsed log.
 * @param existing - records already stored for this session.
 * @returns `{ records, added }`.
 */
export function recordsFromEvents(events, existing) {
	const seen = new Set(existing.map((record) => `${record.callId}\u0000${record.path}`));
	const calls = new Map();
	for (const event of events) {
		if (event?.type === "tool/call" && event.data !== undefined && typeof event.data.name === "string") {
			calls.set(event.data.callId, {
				name: event.data.name,
				args: argsOf(event.data.arguments),
				time: typeof event.time === "number" ? event.time : Date.now()
			});
		}
		if (event?.type === "tool/result" && event.data !== undefined) {
			const callId = event.data.message?.toolCallId ?? event.data.toolCallId;
			const call = calls.get(callId);
			if (call === undefined) continue;
			call.time = typeof event.time === "number" ? event.time : call.time;
			const parts = Array.isArray(event.data.message?.content) ? event.data.message.content : [];
			call.meta = parts.map((part) => part?.dshFileReview).find((value) => value !== undefined);
		}
	}

	const records = [...existing];
	let added = 0;
	let serial = existing.length + 1;
	for (const [callId, call] of calls) {
		const entries = entriesOfCall(call.name, call.args, call.meta);
		for (const entry of entries) {
			const key = `${callId}\u0000${entry.path}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const { hunks, added: addedLines, removed } = buildDiff(entry.before, entry.after);
			const [before, clippedBefore] = keepText(entry.before);
			const [after, clippedAfter] = keepText(entry.after);
			records.push({
				id: `h${serial}`,
				callId,
				tool: call.name,
				path: entry.path,
				absPath: isAbsolute(entry.path) ? entry.path : undefined,
				before,
				after,
				hunks,
				added: addedLines,
				removed,
				created: entry.before === null,
				deleted: entry.after === null,
				time: call.time,
				state: "kept",
				source: "backfill",
				clipped: clippedBefore || clippedAfter
			});
			serial += 1;
			added += 1;
		}
	}
	records.sort((left, right) => (left.time ?? 0) - (right.time ?? 0));
	if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
	return { records, added };
}

/**
 * Directory a state file lives in.
 * @param file - state file path.
 * @returns its directory.
 */
export function stateDir(file) {
	return dirname(file);
}
