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

/**
 * Depth-first search for the first element whose class list contains `name`.
 * @param node - rendered tree.
 * @param name - class name.
 * @returns the element, or undefined.
 */
function findButton(node, name) {
	if (node === null || node === undefined || typeof node !== "object") return undefined;
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findButton(child, name);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	const classes = String(node.props?.className ?? "").split(/\s+/);
	if (classes.includes(name)) return node;
	return findButton(node.props?.children, name);
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

/**
 * A fake service container that answers per service name, so a bundle asking
 * for sidebarRight / sidebarRightTabs gets something that looks like them.
 * @param options - `{ totals }` returned by the review channel.
 * @returns `{ ctx, registrations, dictionaries, styles, tabTypes, openedTabs }`.
 */
function makeClientCtx(options = {}) {
	const registrations = [];
	const dictionaries = {};
	const styles = [];
	const tabTypes = [];
	const openedTabs = [];
	const totals = options.totals ?? { edits: 0 };
	const ctx = {
		get: (name) => {
			if (name === "connection") return { rpc: { call: async () => ({ ok: true, value: { totals, records: [] } }) } };
			if (name === "sidebarRight") return { openTab: (kind, opts) => void openedTabs.push({ kind, opts }) };
			if (name === "sidebarRightTabs") return { register: (spec) => void tabTypes.push(spec) };
			return undefined;
		},
		effect: (fn) => fn(),
		locale: { register: (namespace, dicts) => void (dictionaries[namespace] = dicts), bind: () => (key) => key },
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
	return { ctx, registrations, dictionaries, styles, tabTypes, openedTabs };
}

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

test("apply wires rows, the turn bar, the review panel, session badges and styles", async () => {
	const definition = loadBundle();
	const exported = definition.factory(() => react);

	const { ctx, registrations, dictionaries, tabTypes } = makeClientCtx();
	globalThis.document = {
		head: { appendChild: (tag) => void tag },
		querySelector: () => null,
		createElement: () => ({ dataset: {}, textContent: "" })
	};
	await exported.apply(ctx);
	delete globalThis.document;

	const rows = registrations.filter((entry) => entry.slot === "tool.call.toolview");
	assert.deepEqual(rows.map((entry) => entry.spec.key), [
		"edit",
		"write",
		"apply_patch",
		"replace_string_in_file",
		"multi_replace_string_in_file",
		"create_file",
		"write_to_file",
		"edit_file",
		"multi_edit"
	]);
	for (const entry of rows) {
		assert.equal(entry.spec.name, "tool.call.toolview");
		assert.equal(typeof entry.spec.inject, "function");
		assert.equal(entry.spec.inject("s-1").liveDiffSessionId, "s-1");
	}

	const bar = registrations.filter((entry) => entry.slot === "conversation.chat.turnTail");
	assert.equal(bar.length, 1);
	assert.equal(bar[0].spec.id, "dsh-live-diff");

	assert.equal(tabTypes.length, 1);
	assert.equal(tabTypes[0].kind, "live-diff");
	assert.equal(tabTypes[0].id, "dsh-live-diff");

	const pane = registrations.filter((entry) => entry.slot === "sidebar.right.pane.tab");
	assert.equal(pane.length, 1);
	assert.equal(pane[0].spec.key, "dsh-live-diff");
	const paneTitle = registrations.filter((entry) => entry.slot === "sidebar.right.pane.tab.title");
	assert.equal(paneTitle.length, 1);

	const badge = registrations.filter((entry) => entry.slot === "sidebar.workspaces.session.row.action");
	assert.equal(badge.length, 1);
	assert.equal(badge[0].spec.id, "dsh-live-diff");
	const hover = registrations.filter((entry) => entry.slot === "sidebar.session.row.hover");
	assert.equal(hover.length, 1);

	assert.ok(dictionaries["live-diff"]?.zh?.["bar.files"], "zh dictionary registered");
	assert.ok(dictionaries["live-diff"]?.en?.["panel.title"], "en dictionary registered");
	assert.ok(exported.inject.includes("sidebarRightTabs"));
});

/**
 * The component apply registered for one tool key, after a fresh apply.
 * @param exported - the bundle's exports.
 * @param key - tool name, as used in the toolview slot.
 * @returns the component.
 */
function registrationsForKey(exported, key) {
	const { ctx, registrations } = makeClientCtx();
	globalThis.document = {
		head: { appendChild: () => {} },
		querySelector: () => null,
		createElement: () => ({ dataset: {}, textContent: "" })
	};
	exported.apply(ctx);
	delete globalThis.document;
	return registrations.find((entry) => entry.spec.key === key).component;
}

test("the edit row is collapsed until asked, and its badge opens the review panel", async () => {
	const definition = loadBundle();
	const exported = definition.factory(() => react);
	const { ctx, registrations, openedTabs } = makeClientCtx();
	globalThis.document = {
		head: { appendChild: () => {} },
		querySelector: () => null,
		createElement: () => ({ dataset: {}, textContent: "" })
	};
	await exported.apply(ctx);
	delete globalThis.document;

	const Row = registrations.find((entry) => entry.spec.key === "edit").component;
	const t = (key, fallback) => fallback ?? key;

	queue = [0, { loaded: true, records: [record], error: null }, null, false, false];
	const collapsed = Row({ phase: "result", block: { callId: "c1" }, callId: "c1", liveDiffSessionId: "s1", cwd: "/work", home: "/home/u", openFile: () => {}, t });
	const collapsedText = textOf(collapsed);
	assert.doesNotMatch(collapsedText, /was here/, "a collapsed row hides its diff");
	assert.doesNotMatch(collapsedText, /now here/, "a collapsed row hides its diff");
	assert.match(collapsedText, /\+1/, "the collapsed row still shows the stats");
	assert.match(collapsedText, /−1/);
	assert.match(collapsedText, /Edited/);
	assert.match(collapsedText, /Undo/);
	assert.ok(findButton(collapsed, "ld-toggle"), "a chevron toggles the diff");

	queue = [0, { loaded: true, records: [record], error: null }, null, false, true];
	const expanded = Row({ phase: "result", block: { callId: "c1" }, callId: "c1", liveDiffSessionId: "s1", cwd: "/work", home: "/home/u", openFile: () => {}, t });
	const expandedText = textOf(expanded);
	assert.match(expandedText, /was here/, "an expanded row shows the removed line");
	assert.match(expandedText, /now here/, "an expanded row shows the added line");

	const badge = findButton(collapsed, "ld-badge");
	badge.props.onClick();
	assert.equal(openedTabs.length, 1, "the stats button opens the review panel");
	assert.equal(openedTabs[0].kind, "live-diff");

	queue = [0, { revision: 3, totals: { edits: 2, files: 1, open: 2, openFiles: 1, added: 5, removed: 2 }, records: [record] }, false, false, null];
test("an editor replace renders a diff from its arguments when the host recorded nothing", async () => {
	const definition = loadBundle();
	const exported = definition.factory(() => react);
	const { ctx } = makeClientCtx();
	globalThis.document = {
		head: { appendChild: () => {} },
		querySelector: () => null,
		createElement: () => ({ dataset: {}, textContent: "" })
	};
	await exported.apply(ctx);
	delete globalThis.document;

	const Row = registrationsForKey(exported, "replace_string_in_file");
	const t = (key, fallback) => fallback ?? key;
	const args = {
		filePath: "/work/a.js",
		oldString: "one\ntwo\n",
		newString: "one\nTWO\n"
	};
	const props = {
		phase: "result",
		toolName: "replace_string_in_file",
		block: { callId: "import-1", args },
		callId: "import-1",
		liveDiffSessionId: "s1",
		cwd: "/work",
		home: "/home/u",
		openFile: () => {},
		t
	};

	queue = [0, { loaded: true, records: [], error: null }, null, false, false];
	const collapsed = Row(props);
	const collapsedText = textOf(collapsed);
	assert.match(collapsedText, /Replaced/);
	assert.match(collapsedText, /\+2/);
	assert.match(collapsedText, /−2/);
	assert.doesNotMatch(collapsedText, /TWO/, "the fragment stays folded until asked");
	assert.ok(findButton(collapsed, "ld-toggle"), "the argument-only row keeps its chevron");

	queue = [0, { loaded: true, records: [], error: null }, null, false, true];
	const opened = Row(props);
	const openedText = textOf(opened);
	assert.match(openedText, /TWO/, "expanding shows the added fragment");
	assert.match(openedText, /two/, "expanding shows the removed fragment");
});

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
		get: (name) => (name === "connection" ? { rpc: { call: async () => ({ ok: true, value: {} }) } } : undefined),
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
	queue = [0, { loaded: false, records: [], error: null }, null, false, false];
	const row = Row({ phase: "start", block: { args: { path: "/work/src/b.js" } }, liveDiffSessionId: "s1", cwd: "/work", openFile: () => {}, t });
	assert.match(textOf(row), /Editing/);
	assert.match(textOf(row), /b\.js/);
});
