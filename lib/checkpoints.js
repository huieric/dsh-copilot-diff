import { lstatSync, readdirSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { buildDiff } from "./diff.js";

export const LIMITS = Object.freeze({ files: 1000, entries: 5000, bytes: 8 * 1024 * 1024, fileBytes: 512 * 1024, depth: 12, turns: 200, historyBytes: 64 * 1024 * 1024 });
const EXCLUDED = new Set([".git", "node_modules", ".dsh", ".superpowers", ".worktrees", ".codex", ".claude", ".copilot", ".bsk", ".orca", ".ssh", ".gnupg", ".aws", ".azure", ".config", ".cache", ".npm", ".nvm", ".venv", "venv", "__pycache__", "dist", "build", "coverage", ".next", ".turbo"]);
const excluded = (name) => EXCLUDED.has(name) || /^\.env(?:\.|$)/.test(name);
const message = (error) => error instanceof Error ? error.message : String(error);
function stateAt(snapshot, path) {
	if (Object.hasOwn(snapshot.files, path)) return snapshot.files[path];
	const parts = path.split(sep);
	for (let i = 1; i < parts.length; i += 1) if (Object.hasOwn(snapshot.files, parts.slice(0, i).join(sep)) && snapshot.files[parts.slice(0, i).join(sep)]?.error !== "Directory excluded as file") return undefined;
	return snapshot.complete ? null : undefined;
}
const inside = (root, file) => { const rel = relative(root, file); return rel !== ".." && !rel.startsWith(`..${sep}`) && !resolve(file).startsWith(`${root}${sep}..${sep}`); };

/** Never follow a symlink, including an ancestor replaced after capture. */
function safePath(root, path) {
	const abs = resolve(root, path);
	if (!inside(root, abs) || path.split(/[\\/]/).some(excluded)) throw new Error("Path outside capture scope");
	const parts = relative(root, abs).split(sep).filter(Boolean);
	let cursor = root;
	for (let i = -1; i < parts.length; i += 1) {
		if (i >= 0) cursor = join(cursor, parts[i]);
		try { if (lstatSync(cursor).isSymbolicLink()) throw new Error("Symlink excluded"); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
	}
	return abs;
}

function textAt(root, path, limit = LIMITS.fileBytes) {
	try {
		const abs = safePath(root, path);
		const stat = lstatSync(abs);
		if (!stat.isFile()) return { error: "Not a regular file" };
		if (stat.size > limit) return { error: "Oversized file" };
		const bytes = readFileSync(abs);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (bytes.includes(0) || !Buffer.from(text).equals(bytes)) return { error: "Binary or non-UTF-8 file" };
		return text;
	} catch (error) {
		return error.code === "ENOENT" ? null : { error: message(error) };
	}
}

/** Bounded discovery includes dirty/untracked files and nested repositories without using git. */
export function captureWorkspace(root, overrides = {}) {
	root = resolve(root);
	const limits = { ...LIMITS, ...overrides };
	const files = Object.create(null);
	const limitations = new Set(["Text files only; dependencies, build outputs, internal and secret stores are excluded"]);
	let entries = 0, bytes = 0, count = 0, complete = true;
	const stop = (reason) => { complete = false; limitations.add(reason); };
	const homeRoot = root === resolve(homedir()) || root === dirname(root);
	if (homeRoot) limitations.add("Home/filesystem root: immediate files and immediate child git repositories only");
	function walk(dir, depth) {
		let names;
		try { safePath(root, relative(root, dir)); names = readdirSync(dir).sort(); }
		catch (error) { stop(`Cannot enumerate ${relative(root, dir) || "."}: ${message(error)}`); return; }
		for (const name of names) {
			if (++entries > limits.entries) { stop("Entry limit reached"); return; }
			if (excluded(name)) continue;
			const abs = join(dir, name), path = relative(root, abs);
			let stat;
			try { stat = lstatSync(abs); } catch (error) { files[path] = { error: message(error) }; continue; }
			if (stat.isSymbolicLink()) { files[path] = { error: "Symlink excluded" }; continue; }
			if (stat.isDirectory()) {
				files[path] = { error: "Directory excluded as file" };
				if (homeRoot && depth === 0) {
					try { const git = lstatSync(join(abs, ".git")); if (git.isSymbolicLink() || (!git.isDirectory() && !git.isFile())) { files[path] = { error: "Home subdirectory excluded" }; continue; } }
					catch { files[path] = { error: "Home subdirectory excluded" }; continue; }
				}
				if (depth >= limits.depth) { files[path] = { error: "Directory depth limit reached" }; stop("Directory depth limit reached"); continue; }
				walk(abs, depth + 1); continue;
			}
			if (!stat.isFile()) { files[path] = { error: "Special file excluded" }; continue; }
			if (stat.size > limits.fileBytes) { files[path] = { error: "Oversized file" }; continue; }
			if (++count > limits.files || bytes + stat.size > limits.bytes) { stop("File/total byte limit reached"); return; }
			files[path] = textAt(root, path, limits.fileBytes);
			if (typeof files[path] === "string") bytes += Buffer.byteLength(files[path]);
		}
	}
	walk(root, 0);
	for (const [path, value] of Object.entries(files)) if (value && typeof value === "object" && value.error !== "Directory excluded as file") limitations.add(`${path}: ${value.error}`);
	return { root, files, complete, limitations: [...limitations].slice(0, 100), bytes };
}

export function totalsFor(records) {
	return { edits: records.length, files: new Set(records.map(r => r.path)).size, open: records.filter(r => r.state === "open").length, openFiles: new Set(records.filter(r => r.state === "open").map(r => r.path)).size, added: records.reduce((n, r) => n + r.added, 0), removed: records.reduce((n, r) => n + r.removed, 0) };
}

const validPath = path => typeof path === "string" && path.length > 0 && path.length < 4096 && !isAbsolute(path) && !path.includes("\\") && path.split("/").every(p => p && p !== "." && p !== ".." && !excluded(p));
function validateHistory(parsed, sessionId, limits) {
	const fail = () => { throw new Error("Invalid checkpoint history"); };
	const text = v => v === null || (typeof v === "string" && Buffer.byteLength(v) <= limits.fileBytes);
	const strings = v => Array.isArray(v) && v.length <= 100 && v.every(s => typeof s === "string" && s.length <= 8192);
	if (parsed?.version !== 1 || parsed.sessionId !== sessionId || !Array.isArray(parsed.turns) || parsed.turns.length > limits.turns) fail();
	const seen = new Set();
	for (const cp of parsed.turns) {
		if (!cp || !Number.isSafeInteger(cp.turn) || cp.turn < 0 || seen.has(cp.turn) || !Number.isFinite(cp.time) || !["running", "available", "limited", "unavailable", "interrupted", "restored"].includes(cp.status) || !strings(cp.limitations) || !Array.isArray(cp.records) || cp.records.length > limits.files * 2 || (cp.endTime !== undefined && !Number.isFinite(cp.endTime))) fail();
		seen.add(cp.turn);
		if (cp.root !== undefined && (typeof cp.root !== "string" || !isAbsolute(cp.root) || resolve(cp.root) !== cp.root)) fail();
		if (cp.before) {
			const snap = cp.before;
			if (!cp.root || snap.root !== cp.root || typeof snap.complete !== "boolean" || !strings(snap.limitations) || !snap.files || typeof snap.files !== "object" || Array.isArray(snap.files) || Object.keys(snap.files).length > limits.entries) fail();
			let bytes = 0;
			for (const [path, value] of Object.entries(snap.files)) {
				if (!validPath(path) || !(text(value) || (value && typeof value.error === "string" && value.error.length <= 8192))) fail();
				if (typeof value === "string") bytes += Buffer.byteLength(value);
			}
			if (bytes > limits.bytes) fail();
		} else if (cp.status !== "unavailable") fail();
		if (cp.covered !== undefined && (!Array.isArray(cp.covered) || cp.covered.length > limits.entries * 2 || !cp.covered.every(validPath))) fail();
		const paths = new Set();
		for (const r of cp.records) {
			if (!cp.before || !validPath(r.path) || paths.has(r.path) || r.turn !== cp.turn || r.id !== `checkpoint:${cp.turn}:${r.path}` || r.callId !== `checkpoint:${cp.turn}` || r.absPath !== resolve(cp.root, r.path) || !text(r.before) || !text(r.after) || r.before !== stateAt(cp.before, r.path) || !["open", "kept", "reverted"].includes(r.state)) fail();
			paths.add(r.path);
			Object.assign(r, buildDiff(r.before, r.after));
		}
	}
	return parsed.turns;
}

/** One serialized queue protects capture, persistence and restore for a session. */
export class Checkpoints {
	constructor(sessionId, { root, storage, fs, limits = {}, policy = () => undefined }) {
		this.sessionId = sessionId; this.rootOf = root; this.fs = fs; this.policy = policy; this.limits = { ...LIMITS, ...limits }; this.queue = Promise.resolve(); this.active = null;
		this.file = join(storage, "checkpoints", `${createHash("sha256").update(sessionId).digest("hex")}.json`);
		this.turns = [];
		try {
			if (lstatSync(this.file).size > this.limits.historyBytes) throw new Error("Persistent history byte limit reached");
			const parsed = JSON.parse(readFileSync(this.file, "utf8"));
			this.turns = validateHistory(parsed, sessionId, this.limits);
			if (parsed.coverage && Number.isSafeInteger(parsed.coverage.from) && Number.isSafeInteger(parsed.coverage.to) && parsed.coverage.to >= parsed.coverage.from) this.coverage = parsed.coverage;
			for (const cp of this.turns) if (cp.status === "running") { cp.status = "interrupted"; cp.limitations.push("Process ended during turn; after state may be incomplete"); }
		} catch (error) { if (error.code !== "ENOENT") this.loadError = `Checkpoint state unreadable: ${message(error)}`; }
	}
	run(fn) { const task = this.queue.then(fn); this.queue = task.catch(() => {}); return task; }
	persist() {
		if (this.loadError) throw new Error(this.loadError);
		mkdirSync(dirname(this.file), { recursive: true });
		const temp = `${this.file}.${process.pid}.tmp`;
		const text = JSON.stringify({ version: 1, sessionId: this.sessionId, turns: this.turns, coverage: this.coverage });
		if (Buffer.byteLength(text) > this.limits.historyBytes) throw new Error("Persistent history byte limit reached");
		writeFileSync(temp, text);
		renameSync(temp, this.file);
	}
	start(turn, time = Date.now()) {
		if (!Number.isSafeInteger(turn) || turn < 0) return Promise.resolve();
		this.active = turn;
		return this.run(() => {
			if (this.turns.some(cp => cp.turn === turn)) return;
			if (this.loadError) return;
			if (this.coverage || this.turns.length >= this.limits.turns || Buffer.byteLength(JSON.stringify(this.turns)) >= this.limits.historyBytes - this.limits.bytes * 4) {
				this.coverage = { from: this.coverage?.from ?? turn, to: turn };
				try { this.persist(); } catch (error) { this.loadError = `Checkpoint state unavailable: ${message(error)}`; }
				return;
			}
			const root = this.rootOf();
			const cp = { turn, time, root: root && resolve(root), status: "running", records: [], limitations: [] };
			if (!root || this.loadError || this.turns.length >= this.limits.turns || Buffer.byteLength(JSON.stringify(this.turns)) >= this.limits.historyBytes - this.limits.bytes * 4) {
				cp.status = "unavailable"; cp.limitations = [this.loadError || (!root ? "Workspace root unavailable" : "Persistent history byte limit reached")];
			} else {
				cp.before = captureWorkspace(root, this.limits); cp.limitations = cp.before.limitations;
				if (cp.before.limitations.some(s => s.startsWith("Cannot enumerate .:"))) { cp.before = undefined; cp.status = "unavailable"; }
			}
			this.turns.push(cp);
			try { this.persist(); } catch (error) { cp.status = "unavailable"; cp.before = undefined; cp.limitations.push(`Persistence failed: ${message(error)}`); }
		});
	}
	capture(turn = this.active, end = false) {
		return this.run(() => {
			const cp = this.turns.find(cp => cp.turn === turn);
			if (!cp?.before || cp.status === "restored" || cp.status === "unavailable") return;
			const after = captureWorkspace(cp.root, this.limits);
			cp.limitations = [...new Set([...cp.before.limitations, ...after.limitations])].slice(0, 100);
			const states = new Map(cp.records.map(r => [r.path, r.state]));
			cp.records = [];
			cp.covered = [];
			for (const path of new Set([...Object.keys(cp.before.files), ...Object.keys(after.files)])) {
				const before = stateAt(cp.before, path);
				const next = stateAt(after, path);
				if (typeof before === "string" && after.files[path]?.error === "Directory excluded as file") cp.limitations.push(`${path}: Directory replaced captured file; restore unavailable`);
				if ((typeof before !== "string" && before !== null) || (typeof next !== "string" && next !== null) ) continue;
				cp.covered.push(path);
				if (before === next) continue;
				cp.records.push({ id: `checkpoint:${turn}:${path}`, callId: `checkpoint:${turn}`, tool: "workspace", turn, path, absPath: resolve(cp.root, path), before, after: next, ...buildDiff(before, next), created: before === null, deleted: next === null, time: cp.time, state: states.get(path) ?? "open" });
			}
			cp.complete = cp.before.complete && after.complete;
			if (end) cp.status = cp.complete && cp.limitations.length === 1 ? "available" : "limited";
			try { this.persist(); } catch (error) { cp.status = "unavailable"; cp.limitations.push(`Persistence failed: ${message(error)}`); }
		});
	}
	end(turn) { const task = this.capture(turn, true); return task.finally(() => { if (this.active === turn) this.active = null; }); }
	summaries() { return [...this.turns.map(cp => ({ turn: cp.turn, time: cp.time, status: this.active === cp.turn ? "running" : cp.status, files: cp.records.length, limitations: cp.limitations })), ...(this.loadError ? [{ status: "unavailable", limitations: [this.loadError] }] : []), ...(this.coverage ? [{ turn: this.coverage.to, status: "unavailable", limitations: [`Checkpoint acquisition stopped; turns ${this.coverage.from}–${this.coverage.to} have no capture coverage`] }] : [])]; }
	records(turn) { return this.turns.filter(cp => turn === undefined || cp.turn === turn).flatMap(cp => cp.records); }
	async restore(turn, only) {
		if (this.loadError) return { conflict: this.loadError };
		if (this.active !== null) return { conflict: "Cannot restore while a turn is running" };
		return this.run(async () => {
			if (this.active !== null) return { conflict: "Cannot restore while a turn is running" };
			const index = this.turns.findIndex(cp => cp.turn === turn);
			const chosen = this.turns[index];
			if (!chosen?.before || ["unavailable", "interrupted"].includes(chosen.status)) return { conflict: "Checkpoint unavailable" };
			const later = (only ? this.turns.filter(cp => cp.records.some(r => r.state !== "reverted" && only(r))) : this.turns.slice(index)).filter(cp => cp.status !== "restored");
			if (!only && this.coverage && this.coverage.to >= turn) return { conflict: "Later turns have unavailable capture coverage" };
			if (later.some(cp => !cp.before || cp.status === "interrupted" || cp.root !== chosen.root)) return { conflict: "Later turn has unavailable capture coverage" };
			const changes = new Map();
			for (const cp of later) for (const r of cp.records) {
				if (only && (r.state === "reverted" || !only(r))) continue;
				const effective = r.state === "reverted" ? r.before : r.after;
				if (!changes.has(r.path)) {
					const before = only ? r.before : stateAt(chosen.before, r.path);
					if (typeof before !== "string" && before !== null) return { conflict: `Original state unavailable: ${r.path}` };
					if (before !== r.before) return { conflict: `Unrecorded change between turns: ${r.path}` };
					changes.set(r.path, { before, after: effective });
				} else {
					if (changes.get(r.path).after !== r.before) return { conflict: `Unrecorded change between turns: ${r.path}` };
					changes.get(r.path).after = effective;
				}
			}
			let policy;
			try { policy = this.policy(); } catch (error) { return { conflict: message(error) }; }
			const targets = [], failures = [];
			for (const [path, change] of changes) {
				const current = textAt(chosen.root, path);
				if (current !== change.after) { failures.push({ path, message: "File changed after capture or is unreadable" }); continue; }
				try { const abs = safePath(chosen.root, path); const target = await this.fs.resolve(abs, { cwd: chosen.root });
					let info;
					try { info = typeof this.fs.stat === "function" ? await this.fs.stat(target) : undefined; }
					catch (error) { if (change.after !== null || !["ENOENT", "FS_NOT_FOUND"].includes(error?.code)) throw error; }
					if (textAt(chosen.root, path) !== change.after) throw new Error("File changed during preflight");
					targets.push({ path, change, target, info }); }
				catch (error) { failures.push({ path, message: message(error) }); }
			}
			if (failures.length) return { conflict: failures[0].message, failures };
			if (policy?.mode === "read-only") return { conflict: "Session filesystem policy is read-only" };
			let restored = 0;
			for (const { path, change, target, info } of targets) {
				if (change.before === change.after) continue;
				try {
					if (textAt(chosen.root, path) !== change.after) throw new Error("File changed during restore");
					safePath(chosen.root, path);
					if (change.before === null) await this.fs.deleteFile(target, info ? { version: info.version } : undefined, undefined, policy); else await this.fs.writeText(target, change.before, info ? { kind: "replaceIfVersion", version: info.version } : change.after === null ? { kind: "createIfAbsent" } : undefined, undefined, policy);
					restored += 1;
				} catch (error) { failures.push({ path, message: message(error) }); }
			}
			if (failures.length === 0) for (const cp of later) {
				for (const record of cp.records) if (!only || only(record)) record.state = "reverted";
				if (!only) cp.status = "restored";
			}
			else for (const cp of later) for (const r of cp.records) if (textAt(chosen.root, r.path) === changes.get(r.path)?.before) r.state = "reverted";
			try { this.persist(); } catch (error) { failures.push({ path: "", message: `Persistence failed: ${message(error)}` }); }
			return { restored, failures };
		});
	}
}
