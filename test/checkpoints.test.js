import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { Checkpoints, captureWorkspace } from "../lib/checkpoints.js";

export function realFs(writes = []) {
	return {
		resolve: async path => ({ targetKey: path }),
		readText: async target => readFileSync(target.targetKey, "utf8"),
		writeText: async (target, text) => { writes.push(target.targetKey); mkdirSync(join(target.targetKey, ".."), { recursive: true }); writeFileSync(target.targetKey, text); },
		deleteFile: async target => { writes.push(target.targetKey); rmSync(target.targetKey); }
	};
}
function fixture(fn, limits) {
	const dir = mkdtempSync(join(tmpdir(), "copilot-checkpoints-"));
	const root = join(dir, "work"), storage = join(dir, "state"), writes = [];
	mkdirSync(root);
	const options = { root: () => root, storage, fs: realFs(writes), limits };
	return Promise.resolve().then(() => fn({ root, options, writes, cp: new Checkpoints("s", options) })).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("real sed and Python capture dirty/untracked creation, deletion, empty and exact CRLF text", async () => {
	await fixture(async ({ root, cp, writes }) => {
		execFileSync("git", ["init", "-q", root]);
		writeFileSync(join(root, "dirty"), "dirty\n");
		writeFileSync(join(root, "untracked"), "remove me\n");
		writeFileSync(join(root, "crlf"), "one\r\ntwo\r\n");
		await cp.start(1);
		execFileSync("sed", ["-i", "s/dirty/changed/", join(root, "dirty")]);
		execFileSync("python3", ["-c", "from pathlib import Path; Path('untracked').unlink(); Path('new').write_text(''); Path('crlf').write_bytes(b'ONE\\r\\ntwo\\r\\n')"], { cwd: root });
		await cp.end(1);
		const records = cp.records(1);
		assert.equal(records.length, 4);
		assert.equal(records.find(r => r.path === "new").before, null);
		assert.equal(records.find(r => r.path === "new").after, "");
		assert.equal(records.find(r => r.path === "untracked").after, null);
		assert.equal(records.find(r => r.path === "crlf").before, "one\r\ntwo\r\n");
		assert.equal(records.find(r => r.path === "dirty").hunks.length, 1);
		const result = await cp.restore(1);
		assert.equal(result.restored, 4);
		assert.equal(writes.length, 4);
		assert.equal(readFileSync(join(root, "dirty"), "utf8"), "dirty\n");
		assert.equal(existsSync(join(root, "new")), false);
		assert.equal(readFileSync(join(root, "crlf"), "utf8"), "one\r\ntwo\r\n");
	});
});

test("multiple turns, Keep and restart retain exact originals and reverse all later changes", async () => {
	await fixture(async ({ root, cp, options }) => {
		writeFileSync(join(root, "a"), "original");
		await cp.start(4); writeFileSync(join(root, "a"), "second"); await cp.end(4);
		cp.records().forEach(r => { r.state = "kept"; }); cp.persist();
		await cp.start(5); writeFileSync(join(root, "a"), "third"); writeFileSync(join(root, "b"), "later"); await cp.end(5);
		const reloaded = new Checkpoints("s", options);
		assert.equal(reloaded.records(4)[0].before, "original");
		assert.equal(reloaded.records(4)[0].state, "kept");
		const restored = await reloaded.restore(4);
		assert.deepEqual(restored, { restored: 2, failures: [] });
		assert.equal(readFileSync(join(root, "a"), "utf8"), "original");
		assert.equal(existsSync(join(root, "b")), false);
		assert.ok(reloaded.records().every(r => r.state === "reverted"));
		assert.ok(reloaded.summaries().every(c => c.status === "restored"));
	});
});

test("preflight conflict prevents every write, including deletions and unreadable replacements", async () => {
	await fixture(async ({ root, cp, writes }) => {
		writeFileSync(join(root, "a"), "a"); writeFileSync(join(root, "b"), "b");
		await cp.start(1); writeFileSync(join(root, "a"), "A"); writeFileSync(join(root, "b"), "B"); await cp.end(1);
		writeFileSync(join(root, "b"), "external");
		assert.ok((await cp.restore(1)).conflict);
		assert.deepEqual(writes, []);
		assert.equal(readFileSync(join(root, "a"), "utf8"), "A");
		rmSync(join(root, "b")); mkdirSync(join(root, "b"));
		assert.ok((await cp.restore(1)).conflict);
		assert.deepEqual(writes, []);
	});
});

test("symlinks, excluded stores, nested repositories and oversized/binary files have truthful coverage", async () => {
	await fixture(async ({ root, cp, writes }) => {
		mkdirSync(join(root, ".git")); writeFileSync(join(root, ".git", "config"), "private");
		mkdirSync(join(root, "node_modules")); writeFileSync(join(root, "node_modules", "pkg"), "dependency");
		mkdirSync(join(root, "nested", ".git"), { recursive: true }); writeFileSync(join(root, "nested", "src"), "source");
		writeFileSync(join(root, ".env"), "secret"); writeFileSync(join(root, "binary"), Buffer.from([0, 1, 2]));
		writeFileSync(join(root, "large"), "x".repeat(100));
		symlinkSync(join(root, "nested"), join(root, "link"));
		const snap = captureWorkspace(root, { fileBytes: 32 });
		assert.equal(snap.files["nested/src"], "source");
		assert.equal(snap.files[".git/config"], undefined);
		assert.equal(snap.files["node_modules/pkg"], undefined);
		assert.equal(snap.files[".env"], undefined);
		assert.match(snap.files.large.error, /Oversized/);
		assert.match(snap.files.binary.error, /Binary/);
		assert.match(snap.files.link.error, /Symlink/);
		writeFileSync(join(root, "a"), "one"); await cp.start(1); writeFileSync(join(root, "a"), "two"); await cp.end(1);
		rmSync(join(root, "a")); symlinkSync(join(root, "nested", "src"), join(root, "a"));
		assert.ok((await cp.restore(1)).conflict); assert.deepEqual(writes, []);
	});
});

test("running turns reject restore and interrupted restart cannot invent complete after state", async () => {
	await fixture(async ({ root, cp, options }) => {
		writeFileSync(join(root, "a"), "a"); await cp.start(1); writeFileSync(join(root, "a"), "b"); await cp.capture();
		assert.match((await cp.restore(1)).conflict, /running/);
		const next = new Checkpoints("s", options);
		assert.equal(next.summaries()[0].status, "interrupted");
		assert.match((await next.restore(1)).conflict, /unavailable/);
	});
});

test("bounded enumeration never interprets uncaptured paths as absent", async () => {
	await fixture(async ({ root, cp }) => {
		writeFileSync(join(root, "a"), "one"); writeFileSync(join(root, "b"), "two");
		await cp.start(1); rmSync(join(root, "a")); writeFileSync(join(root, "b"), "THREE"); await cp.end(1);
		assert.equal(cp.summaries()[0].status, "limited");
		assert.ok(cp.summaries()[0].limitations.some(s => /limit/.test(s)));
		assert.equal(cp.records().some(r => r.path === "b"), false, "unknown before is never fabricated into creation");
		assert.equal(cp.records()[0].after, null, "fully enumerated after state can prove a known deletion");
	}, { files: 1 });
});

test("a captured directory replaced by a symlink is not interpreted as file deletion", async () => {
	await fixture(async ({ root, cp }) => {
		mkdirSync(join(root, "nested")); writeFileSync(join(root, "nested", "a"), "one");
		await cp.start(1);
		rmSync(join(root, "nested"), { recursive: true }); symlinkSync(tmpdir(), join(root, "nested"));
		await cp.end(1);
		assert.equal(cp.records().length, 0);
		assert.ok(cp.summaries()[0].limitations.some(s => /Symlink/.test(s)));
	});
});


test("external edits between turns cannot be erased by an older checkpoint", async () => {
	await fixture(async ({ root, cp, writes }) => {
		writeFileSync(join(root, "a"), "original");
		await cp.start(1); writeFileSync(join(root, "a"), "turn one"); await cp.end(1);
		writeFileSync(join(root, "a"), "external");
		await cp.start(2); writeFileSync(join(root, "a"), "turn two"); await cp.end(2);
		assert.match((await cp.restore(1)).conflict, /Unrecorded/);
		assert.equal(writes.length, 0);
	});
});

test("restore newer then older checkpoint follows the restored baseline", async () => {
	await fixture(async ({ root, cp }) => {
		writeFileSync(join(root, "a"), "original");
		await cp.start(1); writeFileSync(join(root, "a"), "turn one"); await cp.end(1);
		await cp.start(2); writeFileSync(join(root, "a"), "turn two"); await cp.end(2);
		assert.equal((await cp.restore(2)).restored, 1);
		assert.equal((await cp.restore(1)).restored, 1);
		assert.equal(readFileSync(join(root, "a"), "utf8"), "original");
	});
});

test("restore carries session policy to host filesystem and refuses read-only before writes", async () => {
	await fixture(async ({ root, cp, writes }) => {
		writeFileSync(join(root, "a"), "original"); await cp.start(1); writeFileSync(join(root, "a"), "changed"); await cp.end(1);
		cp.policy = () => ({ mode: "read-only", workspaceRoot: root });
		assert.match((await cp.restore(1)).conflict, /read-only/); assert.deepEqual(writes, []);
		const policy = { mode: "workspace-write", workspaceRoot: root };
		cp.policy = () => policy;
		const original = cp.fs.writeText;
		cp.fs.writeText = async (target, text, intent, signal, received) => {
			assert.equal(received, policy); await original(target, text);
		};
		assert.equal((await cp.restore(1)).restored, 1);
	});
});


test("scoped Undo affects one file or one turn and conflicts with newer overlapping changes", async () => {
	await fixture(async ({ root, cp }) => {
		writeFileSync(join(root, "a"), "a"); writeFileSync(join(root, "b"), "b");
		await cp.start(1); writeFileSync(join(root, "a"), "A"); writeFileSync(join(root, "b"), "B"); await cp.end(1);
		await cp.start(2); writeFileSync(join(root, "a"), "AA"); await cp.end(2);
		assert.ok((await cp.restore(1, r => r.turn === 1)).conflict);
		const b = cp.records(1).find(r => r.path === "b");
		assert.equal((await cp.restore(1, r => r.id === b.id)).restored, 1);
		assert.equal(readFileSync(join(root, "a"), "utf8"), "AA");
		assert.equal(readFileSync(join(root, "b"), "utf8"), "b");
		assert.equal((await cp.restore(2, r => r.turn === 2)).restored, 1);
		assert.equal((await cp.restore(1)).restored, 1);
		assert.equal(readFileSync(join(root, "a"), "utf8"), "a");
	});
});

test("host write versions and create guards are supplied after conflict preflight", async () => {
	await fixture(async ({ root, cp }) => {
		writeFileSync(join(root, "a"), "a"); writeFileSync(join(root, "deleted"), "deleted");
		await cp.start(1); writeFileSync(join(root, "a"), "A"); rmSync(join(root, "deleted")); await cp.end(1);
		cp.fs.stat = async target => target.targetKey.endsWith("deleted") ? undefined : { version: "v1" };
		const original = cp.fs.writeText, guards = [];
		cp.fs.writeText = async (target, text, guard) => { guards.push(guard); await original(target, text); };
		assert.equal((await cp.restore(1)).restored, 2);
		assert.deepEqual(guards, [{ kind: "replaceIfVersion", version: "v1" }, { kind: "createIfAbsent" }]);
	});
});

test("oversized early files do not exhaust budget before later source files", async () => {
	await fixture(async ({ root }) => {
		writeFileSync(join(root, "a-huge"), "x".repeat(100)); writeFileSync(join(root, "z-source"), "source");
		const captured = captureWorkspace(root, { fileBytes: 20, bytes: 30 });
		assert.equal(captured.files["z-source"], "source");
		assert.match(captured.files["a-huge"].error, /Oversized/);
	});
});
