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

/**
 * Every element whose class list contains `name`.
 * @param node - rendered tree.
 * @param name - class name.
 * @returns matching elements in document order.
 */
function collectNodes(node, name) {
	const found = [];
	const walk = (current) => {
		if (current === null || current === undefined || typeof current !== "object") return;
		if (Array.isArray(current)) {
			for (const child of current) walk(child);
			return;
		}
		const classes = String(current.props?.className ?? "").split(/\s+/);
		if (classes.includes(name)) found.push(current);
		walk(current.props?.children);
	};
	walk(node);
	return found;
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
			if (name === "connection") return { rpc: { call: options.rpc ?? (async () => ({ ok: true, value: { totals, records: [] } })) } };
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
	assert.equal(definition.id, "dsh-copilot-diff");
	const exported = definition.factory((id) => {
		if (id === "react") return react;
		throw new Error(`unexpected require(${JSON.stringify(id)})`);
	});
	assert.equal(typeof exported.apply, "function");
	assert.ok(Array.isArray(exported.inject));
});

test("apply wires rows, the turn footer, the review panel, session badges and styles", async () => {
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

	const foot = registrations.filter((entry) => entry.slot === "conversation.chat.turnTail");
	assert.equal(foot.length, 1, "one Copilot-style footer per turn");
	assert.equal(foot[0].spec.id, "dsh-copilot-diff");
	assert.equal(foot[0].spec.order, -1);
	assert.equal(foot[0].spec.inject("s-1").sessionId, "s-1");

	const diffOn = registrations.filter((entry) => entry.slot === "sidebar.right.pane.tab");
	assert.equal(diffOn.length, 1);

	assert.equal(tabTypes.length, 1);
	assert.equal(tabTypes[0].kind, "copilot-diff");
	assert.equal(tabTypes[0].id, "dsh-copilot-diff");

	const pane = registrations.filter((entry) => entry.slot === "sidebar.right.pane.tab");
	assert.equal(pane.length, 1);
	assert.equal(pane[0].spec.key, "dsh-copilot-diff");
	const paneTitle = registrations.filter((entry) => entry.slot === "sidebar.right.pane.tab.title");
	assert.equal(paneTitle.length, 1);

	const badge = registrations.filter((entry) => entry.slot === "sidebar.workspaces.session.row.action");
	assert.equal(badge.length, 1);
	assert.equal(badge[0].spec.id, "dsh-copilot-diff");
	const hover = registrations.filter((entry) => entry.slot === "sidebar.session.row.hover");
	assert.equal(hover.length, 1);

	assert.ok(dictionaries["copilot-diff"]?.zh?.["bar.files"], "zh dictionary registered");
	assert.ok(dictionaries["copilot-diff"]?.en?.["panel.title"], "en dictionary registered");
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
	assert.equal(openedTabs[0].kind, "copilot-diff");

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

test("the turn header carries this turn's totals on the completed line", async () => {
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

	const Node = registrations.find(
		(entry) => entry.slot === "conversation.chat.node" && entry.spec.key === "turn-process"
	).component;
	const turn = {
		status: "closed",
		start: { time: 1000 },
		end: { time: 1000 + 65_000, data: { reason: { kind: "completed" } } }
	};
	const inside = { ...record, time: 30_000 };
	const t = (key, fallback) => (key === "chinese.marker" ? "en" : fallback ?? key);
	const opened = [];
	const props = {
		node: { location: { kind: "turn", turn } },
		turnProcess: { foldable: true, hasContent: true, open: false, setOpen: (next) => opened.push(next) },
		sessionId: "s1",
		t
	};

	// useSessionRecords: the payload, then its effect.
	queue = [{ key: "s1", value: { records: [inside] } }];
	const view = Node(props);
	const text = textOf(view);
	assert.match(text, /Completed in 1m 5s/, "the completed line carries the duration");
	assert.match(text, /\+1/);
	assert.match(text, /−1/);

	findButton(view, "ld-processbadge").props.onClick({ stopPropagation() {} });
	assert.equal(openedTabs[0]?.kind, "copilot-diff", "the totals open the review panel");

	findButton(view, "ld-processlabel").props.onClick({ stopPropagation() {} });
	assert.deepEqual(opened, [true], "the row still collapses and expands the process");

	queue = [{ key: "s1", value: { records: [{ ...inside, time: 90_000 }] } }];
	const empty = Node({ ...props, node: { location: { kind: "turn", turn: { ...turn, start: { time: 200_000 }, end: { time: 210_000, data: { reason: { kind: "completed" } } } } } } });
	assert.doesNotMatch(textOf(empty), /\+\d/, "a turn that changed nothing shows no totals");
});

test("the expanded turn lists its file rows and the footer lists the files", async () => {
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

	const Node = registrations.find(
		(entry) => entry.slot === "conversation.chat.node" && entry.spec.key === "turn-process"
	).component;
	const turn = {
		status: "closed",
		start: { time: 1000 },
		end: { time: 1000 + 65_000, data: { reason: { kind: "completed" } } }
	};
	const t = (key, fallback) => (key === "chinese.marker" ? "en" : fallback ?? key);
	const payload = { root: "/repo", records: [{ ...record, time: 30_000, added: 4, removed: 2 }] };
	const props = {
		node: { location: { kind: "turn", turn } },
		turnProcess: { foldable: false, hasContent: true, open: true, setOpen: () => {} },
		sessionId: "s1",
		t
	};
	queue = [{ key: "s1", value: payload }];
	const view = Node(props);
	const rows = collectNodes(view, "ld-trow");
	assert.equal(rows.length, 1, "one row per edit in the turn");
	assert.match(textOf(rows[0]), /Edited/, "the row carries the verb");
	assert.match(textOf(rows[0]), /\+4/);
	findButton(view, "ld-trow").props.onClick({ stopPropagation() {} });
	assert.equal(openedTabs[0]?.kind, "copilot-diff", "a row opens the same panel as its totals");

	const Footer = registrations.find(
		(entry) => entry.slot === "conversation.chat.turnTail"
	).component;
	queue = [0, { key: "s1", value: payload }, false, null];
	const footer = Footer({ turn, sessionId: "s1", t });
	const items = collectNodes(footer, "ld-fileitem");
	assert.equal(items.length, 1, "the footer lists the changed files");
	assert.match(textOf(items[0]), /\+4/);
});

test("the turn header speaks Chinese when the dictionary is bound", async () => {
	const definition = loadBundle();
	const exported = definition.factory(() => react);
	const { ctx, registrations } = makeClientCtx();
	globalThis.document = {
		head: { appendChild: () => {} },
		querySelector: () => null,
		createElement: () => ({ dataset: {}, textContent: "" })
	};
	await exported.apply(ctx);
	delete globalThis.document;

	const Node = registrations.find(
		(entry) => entry.slot === "conversation.chat.node" && entry.spec.key === "turn-process"
	).component;
	const turn = {
		status: "closed",
		start: { time: 1000 },
		end: { time: 1000 + 65_000, data: { reason: { kind: "completed" } } }
	};
	const zh = { "chinese.marker": "中文", "node.took": "已完成，用时 {duration}" };
	const t = (key, fallback) => zh[key] ?? fallback ?? key;
	queue = [{ key: "s1", value: { records: [{ ...record, time: 30_000 }] } }];
	const view = Node({
		node: { location: { kind: "turn", turn } },
		turnProcess: { foldable: false, hasContent: true, open: true, setOpen: () => {} },
		sessionId: "s1",
		t
	});
	assert.match(textOf(view), /已完成，用时 1分5秒/);
});

test("the turn footer keeps the change count and both actions", async () => {
	const definition = loadBundle();
	const exported = definition.factory(() => react);
	const { ctx, registrations } = makeClientCtx();
	globalThis.document = {
		head: { appendChild: () => {} },
		querySelector: () => null,
		createElement: () => ({ dataset: {}, textContent: "" })
	};
	await exported.apply(ctx);
	delete globalThis.document;

	const Footer = registrations.find((entry) => entry.slot === "conversation.chat.turnTail").component;
	const turn = { start: { time: 1000 }, end: { time: 1000 + 65_000 }, steps: [{}, {}, {}] };
	const insideTurn = { ...record, time: 30_000 };
	const t = (key, fallback) => fallback ?? key;

	// useRevision, data, busy, notice
	queue = [0, { key: "s1", value: { records: [insideTurn] } }, false, null];
	const footer = Footer({ turn, sessionId: "s1", t });
	const text = textOf(footer);
	assert.match(text, /1 files changed/, "the bar counts distinct files");
	assert.match(text, /\+1/);
	assert.match(text, /−1/);
	assert.doesNotMatch(text, /Completed/, "the completed line lives on the turn header, not here");
	assert.ok(findButton(footer, "ld-turnbar"), "the keep/undo bar is present");
	assert.ok(findButton(footer, "ld-btn"), "Keep and Undo are buttons");

	queue = [0, { key: "s1", value: { records: [] } }, false, null];
	const other = Footer({ turn: { start: { time: 90_000 }, end: { time: 95_000 }, steps: [] }, sessionId: "s1", t });
	assert.equal(other, null, "a turn that changed nothing renders no footer");
});

/** A small hook runner executes effects and re-renders the actual registered component. */
function hookRunner() {
	let slots = [], cursor = 0, effects = [], cleanups = [];
	const depsEqual = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
	const hooks = {
		...react,
		useState(initial) {
			const i = cursor++;
			if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
			return [slots[i], (value) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }];
		},
		useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
		useCallback(fn) { cursor++; return fn; },
		useEffect(fn, deps) {
			const i = cursor++;
			if (!depsEqual(slots[i], deps)) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); }
		}
	};
	return { hooks, render(Component, props) { cursor = 0; const result = Component(props); for (const effect of effects.splice(0)) effect(); return result; }, dispose() { cleanups.forEach((fn) => fn?.()); } };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
async function setupHooks(rpc) {
	const runner = hookRunner();
	const exported = loadBundle().factory(() => runner.hooks);
	const services = makeClientCtx({ rpc });
	await exported.apply(services.ctx);
	return { ...runner, ...services, pane: services.registrations.find((entry) => entry.slot === "sidebar.right.pane.tab").component, footer: services.registrations.find((entry) => entry.slot === "conversation.chat.turnTail").component };
}

test("footer file opens numeric turn scope, loads full hunks, navigates and scopes actions", async () => {
	const requests = [];
	const records = [{ ...record, turn: 7, time: 999999 }, { ...record, id: "e2", path: "/work/b.js", turn: 7 }];
	const payload = { root: "/work", records, checkpoints: [], totals: { edits: 2 } };
	const ui = await setupHooks(async (_channel, endpoint, payloadArg) => {
		requests.push({ endpoint, payload: payloadArg });
		return { ok: true, value: payload };
	});
	const turn = { turn: 7, start: { time: 1000, data: { turn: 7 } }, end: { time: 2000 } };
	ui.render(ui.footer, { turn, sessionId: "s1" }); await settle();
	const foot = ui.render(ui.footer, { turn, sessionId: "s1" });
	assert.equal(collectNodes(foot, "ld-fileitem").length, 2, "numeric turn wins over timestamps");
	findButton(foot, "ld-fileitem").props.onClick();
	assert.equal(ui.openedTabs.length, 1);
	// Mount pane in another runner to give it independent hooks.
	const paneRun = hookRunner();
	Object.assign(ui.hooks, paneRun.hooks);
	paneRun.render(ui.pane, { sessionId: "s1" }); await settle();
	let pane = paneRun.render(ui.pane, { sessionId: "s1" });
	assert.ok(requests.some((r) => r.endpoint === "review-turn" && r.payload.turn === 7));
	assert.match(textOf(pane), /was here/);
	const buttons = collectNodes(pane, "ld-btn");
	await buttons.find((b) => b.props["aria-label"] === "Keep Turn 7").props.onClick();
	assert.ok(requests.some((r) => r.endpoint === "keep-turn" && r.payload.turn === 7));
	paneRun.render(ui.pane, { sessionId: "s1" }); await settle();
	buttons.find((b) => b.props["aria-label"] === "Next file").props.onClick();
	pane = paneRun.render(ui.pane, { sessionId: "s1" });
	assert.equal(findButton(pane, "ld-select").props.value, "/work/b.js");
	collectNodes(pane, "ld-btn").find((b) => textOf(b) === "Side by side").props.onClick();
	pane = paneRun.render(ui.pane, { sessionId: "s1" });
	assert.match(textOf(pane), /now here/);
	assert.equal(collectNodes(pane, "ld-btn").find((b) => b.props["aria-label"] === "Next file").props.disabled, true);
	paneRun.dispose(); ui.dispose();
});

test("all changes hydrate summary bodies and stale replies cannot leak across sessions", async () => {
	let resolveOld;
	const requests = [];
	const ui = await setupHooks(async (_channel, endpoint, payload) => {
		requests.push(endpoint);
		if (payload.sessionId === "old") return new Promise((resolve) => { resolveOld = resolve; });
		if (endpoint === "detail") return { ok: true, value: { records: [{ ...record, hunks: record.hunks.map(({ rows, ...h }) => ({ ...h, lines: rows })) }] } };
		return { ok: true, value: { records: [{ ...record, hunks: undefined }] } };
	});
	ui.render(ui.pane, { sessionId: "old" });
	let view = ui.render(ui.pane, { sessionId: "new" });
	assert.doesNotMatch(textOf(view), /was here/);
	await settle();
	view = ui.render(ui.pane, { sessionId: "new" });
	assert.match(textOf(view), /was here/);
	assert.ok(requests.includes("detail"));
	resolveOld({ ok: true, value: { records: [{ ...record, path: "OLD-SESSION" }] } }); await settle();
	assert.doesNotMatch(textOf(ui.render(ui.pane, { sessionId: "new" })), /OLD-SESSION/);
	ui.dispose();
});

test("checkpoint prefix is unavailable historically and requires explicit files-only confirmation", async () => {
	const requests = [];
	const ui = await setupHooks(async (_channel, endpoint, payload) => { requests.push({ endpoint, payload }); return { ok: true, value: { records: [] } }; });
	const Process = ui.registrations.find((entry) => entry.spec.key === "turn-process").component;
	const turn = { turn: 3, status: "closed", start: { data: { turn: 3 }, time: 1 }, end: { time: 2 } };
	let view = ui.render(Process, { sessionId: "s1", node: { location: { kind: "turn", turn }, data: { turn: 3, messageCount: 2 } }, turnProcess: { foldable: true, hasContent: true, open: false } });
	const checkpointElement = view.props.children[0];
	const run = hookRunner(); Object.assign(ui.hooks, run.hooks);
	let checkpoint = run.render(checkpointElement.type, checkpointElement.props);
	assert.equal(findButton(checkpoint, "ld-btn").props.disabled, true);
	const props = { ...checkpointElement.props, payload: { checkpoints: [{ turn: 3, status: "ready", limitations: [] }] } };
	checkpoint = run.render(checkpointElement.type, props);
	findButton(checkpoint, "ld-btn").props.onClick();
	assert.equal(requests.filter((r) => r.endpoint === "restore-checkpoint").length, 0);
	checkpoint = run.render(checkpointElement.type, props);
	assert.match(textOf(checkpoint), /before turn 3.*subsequent captured changes.*Only files/);
	await collectNodes(checkpoint, "ld-btn").find((button) => textOf(button) === "Restore").props.onClick();
	assert.deepEqual(requests.find((r) => r.endpoint === "restore-checkpoint").payload, { sessionId: "s1", turn: 3 });
	run.dispose(); ui.dispose();
});


test("ok:true partial mutation failures remain visible in the pane", async () => {
	const ui = await setupHooks(async (_channel, endpoint) => {
		if (endpoint === "revert-all") return { ok: true, value: { failures: [{ path: "/work/src/a.js", message: "changed externally" }] } };
		return { ok: true, value: { records: [record] } };
	});
	ui.render(ui.pane, { sessionId: "s1" }); await settle();
	let view = ui.render(ui.pane, { sessionId: "s1" });
	await collectNodes(view, "ld-btn").find((button) => button.props["aria-label"] === "Undo All changes").props.onClick();
	view = ui.render(ui.pane, { sessionId: "s1" }); await settle();
	view = ui.render(ui.pane, { sessionId: "s1" });
	assert.match(textOf(view), /a.js: changed externally/);
	ui.dispose();
});
