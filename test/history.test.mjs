/**
 * History recovery: turning a session log back into edit records.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { entriesOfCall, recordsFromEvents } from "../lib/history.js";

/** A tool call event as the session log stores it. */
function call(callId, name, args, time = 1_700_000_000_000) {
	return { type: "tool/call", time, data: { callId, name, arguments: JSON.stringify(args) } };
}

/** A tool result event, optionally carrying file-review metadata. */
function result(callId, meta, time = 1_700_000_001_000) {
	const content = meta === undefined ? [{ type: "text", text: "ok" }] : [{ type: "text", text: "" }, { dshFileReview: meta }];
	return { type: "tool/result", time, data: { message: { toolCallId: callId, content } } };
}

test("a result carrying file-review metadata wins over the arguments", () => {
	const events = [
		call("c1", "edit", { file_path: "/w/a.js", old_string: "x", new_string: "y" }),
		result("c1", { files: [{ path: "/w/a.js", diffs: [{ path: "/w/a.js", oldText: "one\ntwo\n", newText: "one\nTWO\n" }] }] })
	];
	const { records, added } = recordsFromEvents(events, []);
	assert.equal(added, 1);
	assert.equal(records[0].path, "/w/a.js");
	assert.equal(records[0].added, 1);
	assert.equal(records[0].removed, 1);
	assert.equal(records[0].tool, "edit");
	assert.equal(records[0].state, "kept");
});

test("a replace pair without metadata still becomes a hunk", () => {
	const events = [
		call("c2", "replace_string_in_file", { filePath: "/w/b.js", oldString: "a\nb\n", newString: "a\nB\n" }),
		result("c2")
	];
	const { records } = recordsFromEvents(events, []);
	assert.equal(records.length, 1);
	assert.equal(records[0].before, "a\nb\n");
	assert.equal(records[0].after, "a\nB\n");
	assert.equal(records[0].added, 1);
});

test("every replacement in a multi-file call gets its own record", () => {
	const events = [
		call("c3", "multi_replace_string_in_file", {
			replacements: [
				{ filePath: "/w/a.js", oldString: "1", newString: "2" },
				{ filePath: "/w/b.js", oldString: "3", newString: "4\n5" }
			]
		}),
		result("c3")
	];
	const { records } = recordsFromEvents(events, []);
	assert.deepEqual(
		records.map((record) => record.path),
		["/w/a.js", "/w/b.js"]
	);
	assert.deepEqual(
		records.map((record) => record.added),
		[1, 2]
	);
});

test("a created file has no before side and is marked created", () => {
	const events = [call("c4", "create_file", { filePath: "/w/new.js", content: "a\nb\nc\n" }), result("c4")];
	const { records } = recordsFromEvents(events, []);
	assert.equal(records[0].created, true);
	assert.equal(records[0].before, null);
	assert.equal(records[0].added, 3);
});

test("records already stored are never duplicated", () => {
	const events = [
		call("c5", "replace_string_in_file", { filePath: "/w/a.js", oldString: "a", newString: "b" }),
		result("c5")
	];
	const first = recordsFromEvents(events, []);
	assert.equal(first.added, 1);
	const second = recordsFromEvents(events, first.records);
	assert.equal(second.added, 0);
	assert.equal(second.records.length, 1);
});

test("records come out in log order", () => {
	const events = [
		call("c6", "replace_string_in_file", { filePath: "/w/b.js", oldString: "a", newString: "b" }, 300),
		result("c6", undefined, 301),
		call("c7", "replace_string_in_file", { filePath: "/w/a.js", oldString: "c", newString: "d" }, 100),
		result("c7", undefined, 101)
	];
	const { records } = recordsFromEvents(events, []);
	assert.deepEqual(
		records.map((record) => record.path),
		["/w/a.js", "/w/b.js"]
	);
});

test("a call whose text is unchanged records nothing", () => {
	const events = [call("c8", "replace_string_in_file", { filePath: "/w/a.js", oldString: "a", newString: "a" }), result("c8")];
	assert.equal(recordsFromEvents(events, []).added, 0);
});

test("snake_case arguments are understood too", () => {
	const entries = entriesOfCall("edit", { file_path: "/w/a.js", old_string: "one", new_string: "two" }, undefined);
	assert.deepEqual(entries, [{ path: "/w/a.js", before: "one", after: "two" }]);
});
