import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { apply, inject } from "../lib/index.js";

/**
 * Cordis hands a plugin only the services it declares in `inject`; touching any
 * other one fails at plugin activation (`cannot get property "x" without
 * inject`). The guard below turns that runtime rule into a test failure instead
 * of a bundle that installs cleanly and silently never activates.
 */
const DECLARED = new Set([...inject, "logger", "on", "effect"]);

function guarded(ctx) {
	return new Proxy(ctx, {
		get(target, key, receiver) {
			if (typeof key === "string" && !DECLARED.has(key)) {
				throw new Error(`cannot get property ${JSON.stringify(key)} without inject`);
			}
			return Reflect.get(target, key, receiver);
		}
	});
}

test("declares every service it touches, so activation cannot fail on inject", () => {
	assert.deepEqual(
		[...inject].sort(),
		["connection", "fs", "webServer", "workspaceRegistry"]
	);
});

/**
 * Host stand-in: an in-memory file system, one workspace, and the two host
 * hooks the plugin uses (`connection.register`, `on("tools/result")`).
 */
function makeHost() {
	const files = new Map();
	const listeners = new Map();
	let handle = null;
	const fs = {
		resolve: async (path) => ({ targetKey: path, displayPath: path }),
		processPath: (target) => target.targetKey,
		readText: async (target) => {
			if (!files.has(target.targetKey)) throw new Error("no such file");
			return files.get(target.targetKey);
		},
		writeText: async (target, text) => {
			files.set(target.targetKey, text);
			return { version: 1 };
		},
		deleteFile: async (target) => {
			files.delete(target.targetKey);
		}
	};
	const ctx = {
		fs,
		connection: {
			register: (_ctx, _channel, handler) => {
				handle = handler;
				return () => {
					handle = null;
				};
			}
		},
		workspaceRegistry: { list: () => [{ path: "/work", sessionIds: ["s1"] }] },
		logger: { warn: () => {} },
		on: (event, listener) => {
			listeners.set(event, listener);
			return () => listeners.delete(event);
		},
		effect: (fn) => fn()
	};
	const emit = (exec, result) => listeners.get("tools/result")(exec, result);
	const preExec = (exec) => listeners.get("tools/pre-execute")(exec, async () => ({ kind: "allow" }));
	/** Run a whole editor-style call: snapshot first, then the result. */
	const run = async (name, callId, args, value) => {
		const exec = { name, callId, agent: { id: "s1" }, arguments: args };
		await preExec(exec);
		return emit(exec, { isError: false, value });
	};
	return {
		ctx: guarded(ctx),
		files,
		preExec,
		run,
		emitExec: (exec, value) => emit(exec, { isError: false, value }),
		call: (endpoint, payload) => handle(endpoint, payload),
		edit: (callId, path, before, after) =>
			emit(
				{ name: "edit", callId, agent: { id: "s1" } },
				{ isError: false, value: { path, before, after } }
			),
		patch: (callId, operations) =>
			emit(
				{ name: "apply_patch", callId, agent: { id: "s1" } },
				{ isError: false, value: { phase: "commit", cancelled: false, operations, affectedPaths: [] } }
			),
		fail: (callId) =>
			emit({ name: "edit", callId, agent: { id: "s1" } }, { isError: true, error: { message: "nope" } })
	};
}

/** Run `fn` with an isolated DSH home. */
async function withHome(fn) {
	const dir = mkdtempSync(join(tmpdir(), "live-diff-"));
	const previous = process.env.DSH_HOME;
	process.env.DSH_HOME = dir;
	try {
		await fn(dir);
	} finally {
		if (previous === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previous;
		rmSync(dir, { recursive: true, force: true });
	}
}

test("an edit becomes one entry with stats and hunks", async () => {
	await withHome(async () => {
		const host = makeHost();
		const dispose = await apply(host.ctx);
		host.files.set("/work/a.js", "one\ntwo\nthree\n");
		await host.edit("c1", "/work/a.js", "one\ntwo\nthree\n", "one\nTWO\nthree\n");

		const listed = await host.call("list", { sessionId: "s1" });
		assert.equal(listed.ok, true);
		assert.equal(listed.value.totals.edits, 1);
		assert.equal(listed.value.totals.files, 1);
		assert.equal(listed.value.totals.added, 1);
		assert.equal(listed.value.totals.removed, 1);
		assert.equal(listed.value.records[0].state, "open");

		const detail = await host.call("detail", { sessionId: "s1", callId: "c1" });
		assert.equal(detail.value.records.length, 1);
		const hunks = detail.value.records[0].hunks;
		assert.ok(hunks.length > 0);
		const changed = hunks[0].rows.filter((row) => row.t !== " ");
		assert.deepEqual(
			changed.map((row) => [row.t, row.s]),
			[
				["-", "two"],
				["+", "TWO"]
			]
		);
		await dispose();
	});
});

test("a no-op edit, a failed call and a foreign tool are all ignored", async () => {
	await withHome(async () => {
		const host = makeHost();
		const dispose = await apply(host.ctx);
		await host.edit("c1", "/work/a.js", "same\n", "same\n");
		await host.fail("c2");
		host.ctx.on("tools/result");
		const listed = await host.call("list", { sessionId: "s1" });
		assert.equal(listed.value.totals.edits, 0);
		await dispose();
	});
});

test("one apply_patch yields one entry per changed file", async () => {
	await withHome(async () => {
		const host = makeHost();
		const dispose = await apply(host.ctx);
		await host.patch("c1", [
			{
				index: 0,
				kind: "update",
				path: "/work/a.js",
				status: "completed",
				changes: [{ path: "/work/a.js", before: "a\n", after: "b\n" }]
			},
			{
				index: 1,
				kind: "add",
				path: "/work/new.js",
				status: "completed",
				changes: [{ path: "/work/new.js", before: null, after: "fresh\n" }]
			},
			{
				index: 2,
				kind: "update",
				path: "/work/skip.js",
				status: "failed",
				changes: [{ path: "/work/skip.js", before: "x\n", after: "y\n" }]
			}
		]);
		const listed = await host.call("list", { sessionId: "s1" });
		assert.equal(listed.value.totals.edits, 2);
		assert.equal(listed.value.totals.files, 2);
		assert.equal(listed.value.totals.added, 2);
		assert.equal(listed.value.totals.removed, 1);
		const created = listed.value.records.find((record) => record.path === "/work/new.js");
		assert.equal(created.created, true);
		assert.equal(created.deleted, false);
		await dispose();
	});
});

test("undo restores the previous text, and refuses after a later edit", async () => {
	await withHome(async () => {
		const host = makeHost();
		const dispose = await apply(host.ctx);
		host.files.set("/work/a.js", "v1\n");
		await host.edit("c1", "/work/a.js", "v1\n", "v2\n");
		host.files.set("/work/a.js", "v2\n"); // the edit tool already wrote it
		assert.equal(host.files.get("/work/a.js"), "v2\n");

		const undone = await host.call("revert", { sessionId: "s1", id: "e1" });
		assert.equal(undone.ok, true);
		assert.equal(host.files.get("/work/a.js"), "v1\n");
		assert.equal(undone.value.records[0].state, "reverted");

		// A second edit, then a change made outside the plugin: the older undo must refuse.
		await host.edit("c2", "/work/a.js", "v1\n", "v2\n");
		host.files.set("/work/a.js", "v2\n");
		host.files.set("/work/a.js", "hand edited\n");
		const refused = await host.call("revert", { sessionId: "s1", id: "e2" });
		assert.equal(refused.ok, false);
		assert.match(refused.error.message, /changed after this edit/);
		assert.equal(host.files.get("/work/a.js"), "hand edited\n");
		await dispose();
	});
});

test("undoing a creation removes the file", async () => {
	await withHome(async () => {
		const host = makeHost();
		const dispose = await apply(host.ctx);
		host.files.set("/work/new.js", "fresh\n");
		await host.edit("c1", "/work/new.js", null, "fresh\n");
		const undone = await host.call("revert", { sessionId: "s1", id: "e1" });
		assert.equal(undone.ok, true);
		assert.equal(host.files.has("/work/new.js"), false);
		await dispose();
	});
});

test("keep marks entries kept and keep-all closes every open entry", async () => {
	await withHome(async () => {
		const host = makeHost();
		const dispose = await apply(host.ctx);
		await host.edit("c1", "/work/a.js", "a\n", "b\n");
		await host.edit("c2", "/work/b.js", "c\n", "d\n");

		const kept = await host.call("keep", { sessionId: "s1", id: "e1" });
		assert.equal(kept.value.changed, 1);
		assert.equal(kept.value.totals.open, 1);

		const all = await host.call("keep-all", { sessionId: "s1" });
		assert.equal(all.value.changed, 1);
		assert.equal(all.value.totals.open, 0);
		await dispose();
	});
});

test("revert-all walks back in reverse order and reports leftovers", async () => {
	await withHome(async () => {
		const host = makeHost();
		const dispose = await apply(host.ctx);
		host.files.set("/work/a.js", "1\n");
		await host.edit("c1", "/work/a.js", "1\n", "2\n");
		host.files.set("/work/a.js", "2\n");
		await host.edit("c2", "/work/a.js", "2\n", "3\n");
		host.files.set("/work/a.js", "3\n");
		const reverted = await host.call("revert-all", { sessionId: "s1" });
		assert.equal(reverted.ok, true);
		assert.equal(reverted.value.reverted, 2);
		assert.equal(host.files.get("/work/a.js"), "1\n");
		await dispose();
	});
});

test("the log survives a restart", async () => {
	await withHome(async (dir) => {
		const first = makeHost();
		const disposeFirst = await apply(first.ctx);
		await first.edit("c1", "/work/a.js", "a\n", "b\n");
		first.files.set("/work/a.js", "b\n");
		await disposeFirst();

		const persisted = JSON.parse(
			readFileSync(join(dir, "live-diff", "sessions", "s1.json"), "utf8")
		);
		assert.equal(persisted.records.length, 1);
		assert.equal(persisted.records[0].path, "/work/a.js");

		const second = makeHost();
		const disposeSecond = await apply(second.ctx);
		const listed = await second.call("list", { sessionId: "s1" });
		assert.equal(listed.value.totals.edits, 1);
		assert.equal(listed.value.totals.added, 1);
		await disposeSecond();
	});
});

test("unknown endpoints and missing session ids are refused", async () => {
	await withHome(async () => {
		const host = makeHost();
		const dispose = await apply(host.ctx);
		const unknown = await host.call("nope", { sessionId: "s1" });
		assert.equal(unknown.ok, false);
		const noSession = await host.call("list", {});
		assert.equal(noSession.ok, false);
		const missing = await host.call("revert", { sessionId: "s1", id: "e404" });
		assert.equal(missing.ok, false);
		await dispose();
	});
});


test("an editor replace shows the whole file, not just the swapped fragment", async () => {
	await withHome(async () => {
		const host = makeHost();
		await apply(host.ctx);
		host.files.set("/work/a.js", "one\ntwo\nthree\n");

		const exec = {
			name: "replace_string_in_file",
			callId: "r1",
			agent: { id: "s1" },
			arguments: { filePath: "/work/a.js", oldString: "two", newString: "TWO" }
		};
		await host.preExec(exec);
		host.files.set("/work/a.js", "one\nTWO\nthree\n");
		await host.emitExec(exec, { ok: true });

		const detail = await host.call("detail", { sessionId: "s1", callId: "r1" });
		assert.equal(detail.ok, true);
		assert.equal(detail.value.records.length, 1);
		const [record] = detail.value.records;
		assert.equal(record.tool, "replace_string_in_file");
		assert.equal(record.path, "/work/a.js");
		assert.equal(record.before, "one\ntwo\nthree\n");
		assert.equal(record.after, "one\nTWO\nthree\n");
		assert.equal(record.added, 1);
		assert.equal(record.removed, 1);
	});
});

test("a multi-file editor replace becomes one entry per file", async () => {
	await withHome(async () => {
		const host = makeHost();
		await apply(host.ctx);
		host.files.set("/work/a.js", "alpha\n");
		host.files.set("/work/b.js", "beta\n");

		const exec = {
			name: "multi_replace_string_in_file",
			callId: "m1",
			agent: { id: "s1" },
			arguments: {
				explanation: "rename",
				replacements: [
					{ filePath: "/work/a.js", oldString: "alpha", newString: "ALPHA" },
					{ filePath: "/work/b.js", oldString: "beta", newString: "BETA" }
				]
			}
		};
		await host.preExec(exec);
		host.files.set("/work/a.js", "ALPHA\n");
		host.files.set("/work/b.js", "BETA\n");
		await host.emitExec(exec, { ok: true });

		const listed = await host.call("list", { sessionId: "s1" });
		assert.equal(listed.value.totals.edits, 2);
		assert.equal(listed.value.totals.files, 2);
		const fresh = await host.call("detail", { sessionId: "s1", callId: "m1" });
		assert.deepEqual(
			fresh.value.records.map((record) => record.path).sort(),
			["/work/a.js", "/work/b.js"]
		);
	});
});

test("a created file is recorded as an addition without a before side", async () => {
	await withHome(async () => {
		const host = makeHost();
		await apply(host.ctx);

		const exec = {
			name: "create_file",
			callId: "c9",
			agent: { id: "s1" },
			arguments: { filePath: "/work/new.js", content: "first\nsecond\n" }
		};
		await host.preExec(exec);
		host.files.set("/work/new.js", "first\nsecond\n");
		await host.emitExec(exec, { ok: true });

		const fresh = await host.call("detail", { sessionId: "s1", callId: "c9" });
		const [record] = fresh.value.records;
		assert.equal(record.before, null);
		assert.equal(record.after, "first\nsecond\n");
		assert.equal(record.created, true);
		assert.equal(record.added, 2);
	});
});
