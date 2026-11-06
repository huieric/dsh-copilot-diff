import assert from "node:assert/strict";
import test from "node:test";

import { buildDiff, splitLines } from "../lib/index.js";

/** Text made of `count` numbered lines. */
function lines(count, prefix = "line") {
	return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n");
}

test("splitLines drops the empty tail a trailing newline produces", () => {
	assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
	assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
	assert.deepEqual(splitLines(""), []);
	assert.deepEqual(splitLines(null), []);
	assert.deepEqual(splitLines("a\n\nb"), ["a", "", "b"]);
});

test("identical text produces no hunks and no counts", () => {
	const { hunks, added, removed } = buildDiff("a\nb\nc\n", "a\nb\nc\n");
	assert.equal(hunks.length, 0);
	assert.equal(added, 0);
	assert.equal(removed, 0);
});

test("one changed line keeps three lines of context on each side", () => {
	const before = lines(20);
	const after = before.replace("line 10", "line ten");
	const { hunks, added, removed } = buildDiff(before, after);
	assert.equal(added, 1);
	assert.equal(removed, 1);
	assert.equal(hunks.length, 1);
	// three lines of context on each side, plus the removed and the added line
	assert.equal(hunks[0].rows.length, 8);
	assert.equal(hunks[0].oldStart, 7);
	assert.equal(hunks[0].newStart, 7);
	assert.deepEqual(
		hunks[0].rows.filter((row) => row.t !== " ").map((row) => [row.t, row.s]),
		[
			["-", "line 10"],
			["+", "line ten"]
		]
	);
});

test("distant changes stay in separate hunks", () => {
	const before = lines(40);
	const after = before.replace("line 5", "line five").replace("line 35", "line thirty-five");
	const { hunks, added, removed } = buildDiff(before, after);
	assert.equal(hunks.length, 2);
	assert.equal(added, 2);
	assert.equal(removed, 2);
});

test("a creation is all additions and a deletion all removals", () => {
	const created = buildDiff(null, "a\nb\n");
	assert.equal(created.added, 2);
	assert.equal(created.removed, 0);
	assert.equal(created.hunks.length, 1);
	assert.equal(created.hunks[0].oldStart, 0);

	const deleted = buildDiff("a\nb\n", null);
	assert.equal(deleted.added, 0);
	assert.equal(deleted.removed, 2);
	assert.equal(deleted.hunks[0].newStart, 0);
});

test("line numbers advance on both sides", () => {
	const { hunks } = buildDiff("a\nb\nc", "a\nB\nc");
	const rows = hunks[0].rows;
	const removedRow = rows.find((row) => row.t === "-");
	const addedRow = rows.find((row) => row.t === "+");
	assert.equal(removedRow.old, 2);
	assert.equal(removedRow.new, null);
	assert.equal(addedRow.new, 2);
	assert.equal(addedRow.old, null);
});

test("large regions fall back instead of exploding", () => {
	const before = Array.from({ length: 2000 }, (_, index) => `old ${index}`).join("\n");
	const after = Array.from({ length: 2000 }, (_, index) => `new ${index}`).join("\n");
	const started = Date.now();
	const { added, removed } = buildDiff(before, after);
	assert.equal(added, 2000);
	assert.equal(removed, 2000);
	assert.ok(Date.now() - started < 2000, "diff of 2000 replaced lines should be fast");
});

test("hunks carry a valid unified header", () => {
	const { hunks } = buildDiff("a\nb\nc\nd\ne", "a\nb\nX\nd\ne");
	const hunk = hunks[0];
	assert.equal(hunk.oldLines, hunk.rows.filter((row) => row.t !== "+").length);
	assert.equal(hunk.newLines, hunk.rows.filter((row) => row.t !== "-").length);
	assert.equal(hunk.oldStart, 1);
	assert.equal(hunk.oldLines, 5);
});
