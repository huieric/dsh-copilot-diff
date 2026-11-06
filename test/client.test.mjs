import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

/** Hook values handed out in call order by the fake React below. */
let queue = [];

/**
 * Minimal React stand-in: enough to run the bundle's `apply` and to render the
 * component functions once, so a typo in the render path fails the test.
 */
const react = {
	createElement(type, props, ...children) {
		const merged = { ...(props ?? {}) };
		if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
		return { type, props: merged };
	},
	useState(initial) {
		const next = queue.length > 0 ? queue.shift() : undefined;
		return [next === undefined ? (typeof initial === "function" ? initial() : initial) : next, () => {}];
	},
	useEffect() {},
	useCallback(fn) {
		return fn;
	},
	useRef(value) {
		return { current: value };
	}
};

/** Load the bundle the way the host's module loader would. */
function loadBundle() {
	const definitions = [];
	const fakeWindow = { __ModuleLoader__: { load: (definition) => definitions.push(definition) } };
	new Function("window", source)(fakeWindow);
	assert.equal(definitions.length, 1, "the bundle must register exactly one module");
	return definitions[0];
}

/** Collect every rendered text node. */
function textOf(node) {
	if (node === null || node === undefined || node === false) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join(" ");
	if (typeof node.type === "function") return textOf(node.type(node.props ?? {}));
	return textOf(node.props?.children);
}

/** One stored record shaped like the server's. */
const record = {
	id: "e1",
	callId: "c1",
	tool: "edit",
	path: "/work/src/a.js",
	added: 1,
	removed: 1,
	created: false,
	deleted: false,
	state: "open",
	time: 1,
	hunks: [
		{
			oldStart: 1,
			oldLines: 2,
			newStart: 1,
			newLines: 2,
			rows: [
				{ t: " ", s: "keep me", old: 1, new: 1 },
				{ t: "-", s: "was here", old: 2, new: null },
				{ t: "+", s: "now here", old: null, new: 2 }
			]
		}
	]
};

test("the bundle registers one module and exports apply + inject", () => {
	const definition = loadBundle();
	assert.equal(definition.id, "dsh-live-diff");
	const exported = definition.factory((id) => {
		if (id === "react") return react;
		throw new Error(`unexpected require(${JSON.stringify(id)})`);
	});
	assert.equal(typeof exported.apply, "function");
	assert.ok(Array.isArray(exported.inject));
});

test("apply wires three tool rows, the turn bar, dictionaries and styles", async () => {
	const definition = loadBundle();
	const exported = definition.factory(() => react);

	const registrations = [];
	const dictionaries = {};
	const styles = [];
	const host = {
		document: undefined
	};
	globalThis.document = {
		head: { appendChild: (tag) => styles.push(tag) },
		querySelector: () => null,
		createElement: () => ({ dataset: {}, textContent: "" })
	};
	const ctx = {
		get: () => ({ rpc: { call: async () => ({ ok: true, value: { totals: { edits: 0 } } }) } }),
		effect: (fn) => fn(),
		locale: { register: (namespace, dicts) => void (dictionaries[namespace] = dicts) },
		slots: {
			register: (spec, component) => {
				registrations.push({ spec, component });
				return () => {};
			},
			inject: (slot, factory) => {
				const before = registrations.length;
				const disposer = factory();
				for (const entry of registrations.slice(before)) entry.slot = slot;
				return disposer;
			}
		}
	};

	await exported.apply(ctx);
	delete globalThis.document;
	void host;

	const rows = registrations.filter((entry) => entry.slot === "tool.call.toolview");
	assert.deepEqual(
		rows.map((entry) => entry.spec.key),
		["edit", "write", "apply_patch"]
	);
	for (const entry of rows) assert.equal(entry.spec.name, "tool.call.toolview");

	const bar = registrations.filter((entry) => entry.slot === "conversation.chat.turnTail");
	assert.equal(bar.length, 1);
	assert.equal(bar[0].spec.id, "dsh-live-diff");

	assert.ok(dictionaries["live-diff"]?.zh?.["bar.files"], "zh dictionary registered");
	assert.ok(dictionaries["live-diff"]?.en?.["bar.files"], "en dictionary registered");
	assert.equal(styles.length, 1, "stylesheet injected once");
	assert.ok(styles[0].textContent.includes(".ld-diff"), "stylesheet carries the diff rules");
});

test("the edit row and the turn bar render without throwing", async () => {
	const definition = loadBundle();
	const exported = definition.factory(() => react);
	const registrations = [];
	globalThis.document = {
		head: { appendChild: () => {} },
		querySelector: () => null,
		createElement: () => ({ dataset: {}, textContent: "" })
	};
	const ctx = {
		get: () => ({ rpc: { call: async () => ({ ok: true, value: {} }) } }),
		effect: (fn) => fn(),
		locale: { register: () => {} },
		slots: {
			register: (spec, component) => {
				registrations.push({ spec, component });
				return () => {};
			},
			inject: (slot, factory) => factory()
		}
	};
	await exported.apply(ctx);
	delete globalThis.document;

	const Row = registrations.find((entry) => entry.spec.key === "edit").component;
	const t = (key, fallback) => fallback ?? key;

	queue = [0, { loaded: true, records: [record], error: null }, null, false];
	const row = Row({ phase: "result", block: { callId: "c1" }, callId: "c1", liveDiffSessionId: "s1", cwd: "/work", home: "/home/u", openFile: () => {}, t });
	const rowText = textOf(row);
	assert.match(rowText, /was here/, "removed line rendered");
	assert.match(rowText, /now here/, "added line rendered");
	assert.match(rowText, /\+1/);
	assert.match(rowText, /−1/);
	assert.match(rowText, /Edited/);
	assert.match(rowText, /Undo/);

	queue = [0, { revision: 3, totals: { edits: 2, files: 1, open: 2, openFiles: 1, added: 5, removed: 2 }, records: [record] }, false, false, null];
	const Bar = registrations.find((entry) => entry.spec.name === "conversation.chat.turnTail").component;
	const bar = Bar({ sessionId: "s1", cwd: "/work", home: "/home/u", openFile: () => {}, t });
	const barText = textOf(bar);
	assert.match(barText, /1 files changed/);
	assert.match(barText, /\+5/);
	assert.match(barText, /−2/);
	assert.match(barText, /Keep/);
	assert.match(barText, /Undo all/);
});

test("the pending phase renders a placeholder row", async () => {
	const definition = loadBundle();
	const exported = definition.factory(() => react);
	const registrations = [];
	globalThis.document = {
		head: { appendChild: () => {} },
		querySelector: () => null,
		createElement: () => ({ dataset: {}, textContent: "" })
	};
	const ctx = {
		get: () => ({ rpc: { call: async () => ({ ok: true, value: {} }) } }),
		effect: (fn) => fn(),
		locale: { register: () => {} },
		slots: {
			register: (spec, component) => {
				registrations.push({ spec, component });
				return () => {};
			},
			inject: (slot, factory) => factory()
		}
	};
	await exported.apply(ctx);
	delete globalThis.document;

	const Row = registrations.find((entry) => entry.spec.key === "write").component;
	const t = (key, fallback) => fallback ?? key;
	queue = [0, { loaded: false, records: [], error: null }, null, false];
	const row = Row({ phase: "start", block: { args: { path: "/work/src/b.js" } }, liveDiffSessionId: "s1", cwd: "/work", openFile: () => {}, t });
	assert.match(textOf(row), /Editing/);
	assert.match(textOf(row), /b\.js/);
});
