#!/usr/bin/env node
/**
 * Backfill edit history for sessions that ran before this plugin existed.
 *
 * The plugin recovers history lazily, one session at a time, as those sessions
 * are opened. This script does the same thing in bulk — handy right after an
 * install, so the session list shows its numbers on first paint instead of
 * filling in as each conversation is visited.
 *
 * Usage:
 *   node tools/backfill.mjs                 # write the history
 *   node tools/backfill.mjs --dry           # report only, touch nothing
 *   node tools/backfill.mjs --only=<text>   # only sessions whose id contains <text>
 *   node tools/backfill.mjs --since=2026-10-01
 *   node tools/backfill.mjs --home=/other/.dsh
 *   node tools/backfill.mjs --no-git        # skip the commit-history pass
 *
 * Restart `dsh web` afterwards: a running host keeps its copy of a session in
 * memory and writes it back over the files this script just produced.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	findSessionLog,
	gitRecordsForTurn,
	readSessionEvents,
	recordsFromEvents,
	reposUnder,
	sessionFileName,
	turnWindows
} from "../lib/history.js";

/**
 * Options from argv.
 * @returns `{ dry, git, only, since, home }`.
 */
function options() {
	const argv = process.argv.slice(2);
	const read = (name) => {
		const hit = argv.find((value) => value.startsWith(`--${name}=`));
		return hit === undefined ? undefined : hit.slice(name.length + 3);
	};
	const since = read("since");
	return {
		git: !argv.includes("--no-git"),
		dry: argv.includes("--dry"),
		only: read("only"),
		since: since === undefined ? undefined : Date.parse(`${since}T00:00:00`),
		home: read("home")
	};
}

/**
 * DSH home directory.
 * @param override - `--home` value.
 * @returns the absolute path.
 */
function dshHome(override) {
	if (override !== undefined && override.length > 0) return override;
	const env = process.env.DSH_HOME?.trim();
	return env !== undefined && env.length > 0 ? env : join(homedir(), ".dsh");
}

/**
 * Every session id on disk, with its workspace.
 * @param root - `$DSH_HOME`.
 * @returns `[{ workspace, sessionId }]`.
 */
function sessionsOnDisk(root) {
	const base = join(root, "sessions");
	const found = [];
	if (!existsSync(base)) return found;
	for (const workspace of readdirSync(base)) {
		const workspaceDir = join(base, workspace);
		if (!statSync(workspaceDir).isDirectory()) continue;
		for (const sessionId of readdirSync(workspaceDir)) {
			const dir = join(workspaceDir, sessionId);
			if (statSync(dir).isDirectory()) found.push({ workspace, sessionId });
		}
	}
	return found;
}

/**
 * Write one session's state file.
 * @param file - state file path.
 * @param records - records to store.
 * @param seq - last record serial.
 * @returns nothing.
 */
function writeSession(file, records, seq) {
	mkdirSync(join(file, ".."), { recursive: true });
	const temp = `${file}.tmp`;
	writeFileSync(temp, JSON.stringify({ version: 1, seq, records }), "utf8");
	renameSync(temp, file);
}

const conf = options();
const root = dshHome(conf.home);
const storage = join(root, "copilot-diff", "sessions");
const report = [];
let touched = 0;
let totalAdded = 0;
let totalStored = 0;

for (const { workspace, sessionId } of sessionsOnDisk(root)) {
	if (conf.only !== undefined && !sessionId.includes(conf.only)) continue;
	const log = findSessionLog(join(root, "sessions"), sessionId);
	if (log === undefined) continue;
	const events = readSessionEvents(log);
	if (conf.since !== undefined) {
		const newest = events.reduce((max, event) => (typeof event?.time === "number" && event.time > max ? event.time : max), 0);
		if (newest !== 0 && newest < conf.since) continue;
	}
	const stateFile = join(storage, sessionFileName(sessionId));
	let existing = [];
	if (existsSync(stateFile)) {
		try {
			const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
			if (Array.isArray(parsed.records)) existing = parsed.records;
		} catch {
			existing = [];
		}
	}
	const { records, added } = recordsFromEvents(events, existing);
	let gitAdded = 0;
	if (conf.git) {
		// A turn whose files changed through a shell command has no tool record,
		// but its work still sits in the repository commits made inside the turn.
		const cwd = typeof events[0]?.cwd === "string" ? events[0].cwd : process.cwd();
		const repos = reposUnder(cwd);
		if (repos.length > 0) {
			const windows = turnWindows(events);
			for (const window of windows) {
				const busy = records.some(
					(record) => typeof record.time === "number" && record.time >= window.from && record.time <= window.to
				);
				if (busy) continue;
				const seenPaths = new Set();
				for (const repo of repos) {
					const found = gitRecordsForTurn(repo, window, cwd, records.length + 1);
					for (const record of found.records) {
						if (seenPaths.has(record.path)) continue;
						seenPaths.add(record.path);
						records.push(record);
						gitAdded += 1;
					}
				}
			}
			if (gitAdded > 0) {
				records.sort((left, right) => (left.time ?? 0) - (right.time ?? 0));
				if (records.length > 400) records.splice(0, records.length - 400);
				records.forEach((record, index) => {
					record.id = record.source === "git" ? `g${index + 1}` : record.id;
				});
			}
		}
	}
	if (added + gitAdded === 0) continue;
	touched += 1;
	totalAdded += added + gitAdded;
	totalStored += records.length;
	report.push({ session: sessionId, workspace, added: added + gitAdded, total: records.length });
	if (!conf.dry) writeSession(stateFile, records, Math.max(existing.length, records.length));
}

report.sort((left, right) => right.added - left.added);
for (const row of report.slice(0, 15)) {
	console.log(`${String(row.added).padStart(5)} new  ${String(row.total).padStart(5)} total  ${row.session}`);
}
console.log(
	`${conf.dry ? "[dry run] " : ""}${touched} sessions · +${totalAdded} records · ${totalStored} stored · ${storage}`
);
if (!conf.dry && touched > 0) console.log("Restart `dsh web` so the host reloads what it holds in memory.");
