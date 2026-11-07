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
 * Depth-first search for a component element by function name.
 * @param node - rendered tree.
 * @param name - component function name.
 * @returns the element, or undefined.
 */
function findComponent(node, name) {
	if (node === null || node === undefined || typeof node !== "object") return undefined;
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findComponent(child, name);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (typeof node.type === "function" && node.type.name === name) return node;
	return findComponent(node.props?.children, name);
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
	let mountedId = options.mountedId ?? "s1";
 const mountedListeners = new Set();
 const mounted = {getSnapshot:()=>mountedId,subscribe:fn=>{mountedListeners.add(fn);return ()=>mountedListeners.delete(fn);}};
 const mount = id => {mountedId=id;for(const fn of [...mountedListeners])fn();};
 const totals = options.totals ?? { edits: 0 };
	const ctx = {
		get: (name) => {
			if (name === "connection") return { rpc: { call: options.rpc ?? (async () => ({ ok: true, value: { totals, records: [] } })) } };
			if (name === "sidebarRight") return { mounted, openTab: (kind, opts) => void openedTabs.push({ kind, opts, sessionId:mountedId }) };
			if (name === "uiWorkspace") return options.noNavigation ? undefined : {openSession: options.openSession ?? mount};
			if (name === "sidebarRightTabs") return { register: (spec) => void tabTypes.push(spec) };
			if (name === "sessions") return options.sessions;
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
	return { ctx, registrations, dictionaries, styles, tabTypes, openedTabs, mount };
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
		"str_replace_editor",
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

test("a click on a host file row's numbers opens that change in the review panel", async () => {
	const definition = loadBundle();
	const exported = definition.factory(() => react);
	const { ctx, openedTabs } = makeClientCtx({ mountedId: "s9" });
	const listeners = [];
	globalThis.document = {
		head: { appendChild: (tag) => void tag },
		querySelector: () => null,
		createElement: () => ({ dataset: {}, textContent: "" }),
		addEventListener: (type, fn, capture) => void listeners.push({ type, fn, capture })
	};
	await exported.apply(ctx);
	delete globalThis.document;

	assert.equal(listeners.length, 1, "one delegated click listener");
	assert.equal(listeners[0].type, "click");
	assert.equal(listeners[0].capture, true, "capture phase, so the row's own link never fires");

	const row = { getAttribute: (name) => (name === "data-chat-call-id" ? "call-7" : null) };
	const stats = { closest: (selector) => (selector === "[data-chat-call-id]" ? row : null) };
	const numbers = { closest: (selector) => (selector.includes("diffStat") ? stats : null) };
	const event = {
		target: numbers,
		prevented: 0,
		stopped: 0,
		preventDefault() {
			this.prevented += 1;
		},
		stopPropagation() {
			this.stopped += 1;
		}
	};
	listeners[0].fn(event);
	assert.deepEqual(openedTabs, [{ kind: "copilot-diff", opts: { revealIfOpened: true }, sessionId: "s9" }]);
	assert.equal(event.prevented, 1);
	assert.equal(event.stopped, 1);

	const elsewhere = {
		target: { closest: () => null },
		preventDefault() {
			throw new Error("a row without totals must keep its own click");
		},
		stopPropagation() {
			throw new Error("a row without totals must keep its own click");
		}
	};
	listeners[0].fn(elsewhere);
	assert.equal(openedTabs.length, 1, "nothing else opens the panel");
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

	// The totals sit before the chevron, and the chevron is the row's last control.
	const head = collectNodes(view, "ld-processhead")[0];
	const order = (head.props.children ?? []).flatMap((child) => String(child?.props?.className ?? "").split(/\s+/));
	assert.ok(order.indexOf("ld-processbadge") < order.indexOf("ld-processchev"), "the totals come before the chevron");
	assert.equal(order[order.length - 1], "ld-processchev", "the chevron is the row's last control");
	const chevron = findButton(view, "ld-processchev");
	assert.ok(chevron !== undefined, "a foldable turn still offers the chevron");
	chevron.props.onClick({ stopPropagation() {} });
	assert.deepEqual(opened, [true], "the chevron folds like the label");

	queue = [{ key: "s1", value: { records: [inside] } }];
	const stepped = Node({
		...props,
		node: { location: { kind: "turn", turn: { ...turn, steps: [{ step: 0 }, { step: 1 }, { step: 2 }] } } }
	});
	assert.match(textOf(stepped), /Completed 3 steps in 1m 5s/, "the finished line counts the turn's steps");

	queue = [{ key: "s1", value: { records: [inside] } }];
	const oneStep = Node({ ...props, node: { location: { kind: "turn", turn: { ...turn, steps: [{ step: 0 }] } } } });
	assert.match(textOf(oneStep), /Completed 1 step in 1m 5s/, "one step is not plural");

	opened.length = 0;
	findButton(view, "ld-processlabel").props.onClick({ stopPropagation() {} });
	assert.deepEqual(opened, [true], "the row still collapses and expands the process");

	queue = [{ key: "s1", value: { records: [{ ...inside, time: 90_000 }] } }];
	const empty = Node({ ...props, node: { location: { kind: "turn", turn: { ...turn, start: { time: 200_000 }, end: { time: 210_000, data: { reason: { kind: "completed" } } } } } } });
	assert.doesNotMatch(textOf(empty), /\+\d/, "a turn that changed nothing shows no totals");
});

test("the expanded turn leaves the real steps in place and the footer lists the files", async () => {
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
	// The host renders reasoning and tool calls itself, in their original order.
	// The turn header must not grow a second, aggregated list of edits.
	assert.equal(collectNodes(view, "ld-trow").length, 0, "no aggregated edit list inside the turn header");
	assert.equal(findComponent(view, "TurnEditRow"), undefined);
	assert.equal(collectNodes(view, "ld-process").length, 1, "the completed line is still ours");
	assert.match(textOf(view), /\+4/);

	const Footer = registrations.find(
		(entry) => entry.slot === "conversation.chat.turnTail"
	).component;
	queue = [0, { key: "s1", value: payload }, false, null];
	const footer = Footer({ turn, sessionId: "s1", t });
	const items = collectNodes(footer, "ld-turnrow");
	assert.equal(items.length, 1, "the footer lists the changed files");
	assert.match(textOf(items[0]), /a\.js/);
	assert.match(textOf(footer), /\+4/, "the row carries the line stats");
	assert.match(textOf(footer), /Edited 1 file/, "the header counts the files");
	assert.equal(collectNodes(footer, "ld-fchip").length, 0, "each file is one row, not a compact chip");
});

test("the whole-file diff folds untouched context and reveals it on demand", async () => {
	const before = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
	const after = before.replace("line 10", "line ten");
	const full = {
		...record,
		before,
		after,
		hunks: [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, rows: [{ t: "-", s: "line 10", old: 10 }, { t: "+", s: "line ten", new: 10 }] }]
	};
	const ui = await setupHooks(async () => ({ ok: true, value: { root: "/work", records: [full] } }));
	ui.render(ui.pane, { sessionId: "s1" }); await settle();
	const view = ui.render(ui.pane, { sessionId: "s1" });
	const element = findComponent(view, "DiffBody");
	assert.ok(element, "the pane renders the whole file through a diff body");
	const run = hookRunner();
	Object.assign(ui.hooks, run.hooks);
	let diff = run.render(element.type, element.props);
	assert.match(textOf(diff), /line ten/, "the changed line is visible");
	assert.doesNotMatch(textOf(diff), /line 1\b/, "the untouched head starts folded");
	assert.ok(collectNodes(diff, "ld-gap").length >= 2, "both sides of the hunk fold");
	collectNodes(diff, "ld-gap")[0].props.onClick();
	diff = run.render(element.type, element.props);
	assert.match(textOf(diff), /line 1\b/, "opening a gap reveals the hidden context");
	run.dispose(); ui.dispose();
});

test("a created or deleted file renders its whole body without a hunk bar", async () => {
	const created = {
		...record,
		path: "/work/src/new.ts",
		created: true,
		before: "",
		after: "one\ntwo\n",
		hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, rows: [{ t: "+", s: "one", old: null, new: 1 }, { t: "+", s: "two", old: null, new: 2 }] }]
	};
	const deleted = {
		...record,
		id: "e2",
		path: "/work/src/old.ts",
		deleted: true,
		before: "gone\nalso gone\n",
		after: "",
		hunks: [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, rows: [{ t: "-", s: "gone", old: 1, new: null }, { t: "-", s: "also gone", old: 2, new: null }] }]
	};
	const ui = await setupHooks(async () => ({ ok: true, value: { root: "/work", records: [created, deleted] } }));
	ui.render(ui.pane, { sessionId: "s1" }); await settle();
	let view = ui.render(ui.pane, { sessionId: "s1" });
	assert.match(textOf(view), /one/, "a created file renders its body");
	assert.doesNotMatch(textOf(view), /@@/, "whole-file views have no hunk bars");
	assert.equal(collectNodes(view, "ld-flatfile").length, 2, "both files are flattened into one column");
	assert.match(textOf(view), /gone/, "the deleted file body is rendered from full text");
	assert.doesNotMatch(textOf(view), /@@/);
	// Folding one section hides that file's body and leaves the other one alone.
	findButton(view, "ld-flatfold").props.onClick();
	view = ui.render(ui.pane, { sessionId: "s1" });
	assert.doesNotMatch(textOf(view), /two/, "the folded section drops its body");
	assert.match(textOf(view), /gone/, "the other section still renders");
	ui.dispose();
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
	assert.match(text, /Edited 1 file/, "the card counts distinct files");
	assert.match(text, /\+1/);
	assert.match(text, /−1/);
	assert.doesNotMatch(text, /Completed/, "the completed line lives on the turn header, not here");
	assert.ok(findButton(footer, "ld-turnhead"), "the card header is present");
	assert.ok(findButton(footer, "ld-turnbtn"), "Keep and Undo are buttons");
	assert.ok(findButton(footer, "ld-turnbtn-strong"), "Review sits in the header too");

	queue = [0, { key: "s1", value: { records: [] } }, false, null];
	const other = Footer({ turn: { status: "closed", start: { time: 90_000 }, end: { time: 95_000 }, steps: [] }, sessionId: "s1", t });
	assert.equal(findButton(other, "ld-turnhead"), undefined, "a turn that changed nothing renders no card");
	assert.ok(findComponent(other, "ForkControl"), "the boundary row still closes the turn");
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
async function setupHooks(rpc, options = {}) {
	const runner = hookRunner();
	const exported = loadBundle().factory(() => runner.hooks);
	const services = makeClientCtx({ rpc, ...options });
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
	assert.equal(collectNodes(foot, "ld-turnrow").length, 2, "numeric turn wins over timestamps");
	findButton(foot, "ld-turnrow").props.onClick();
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
	pane = paneRun.render(ui.pane, { sessionId: "s1" });
	assert.equal(collectNodes(pane, "ld-flatfile").length, 2, "both files are flattened into the pane");
	assert.match(textOf(pane), /b\.js/, "the second file is visible without selecting it");
	collectNodes(pane, "ld-segbtn").find((b) => textOf(b) === "Side by side").props.onClick();
	pane = paneRun.render(ui.pane, { sessionId: "s1" });
	assert.match(textOf(pane), /was here/);
	assert.match(textOf(pane), /now here/);
	paneRun.dispose(); ui.dispose();
});

test("the footer card folds past six files behind one row", async () => {
	const records = Array.from({ length: 9 }, (_, index) => ({ ...record, id: `e${index}`, callId: `c${index}`, path: `/work/f${index}.js`, turn: 7 }));
	const payload = { root: "/work", records, checkpoints: [], totals: { edits: 9 } };
	const ui = await setupHooks(async () => ({ ok: true, value: payload }));
	const turn = { turn: 7, start: { time: 1000, data: { turn: 7 } }, end: { time: 2000 } };
	ui.render(ui.footer, { turn, sessionId: "s1" }); await settle();
	const folded = ui.render(ui.footer, { turn, sessionId: "s1" });
	assert.equal(collectNodes(folded, "ld-turnrow").length, 6, "six rows before the fold");
	const more = findButton(folded, "ld-turnmore");
	assert.match(textOf(more), /3 more files/);
	more.props.onClick();
	const opened = ui.render(ui.footer, { turn, sessionId: "s1" });
	assert.equal(collectNodes(opened, "ld-turnrow").length, 9, "the fold reveals the rest");
	assert.equal(findButton(opened, "ld-turnmore"), undefined, "the fold button disappears once open");
	ui.dispose();
});

test("all changes hydrate summary bodies and stale replies cannot leak across sessions", async () => {
	let resolveOld;
	const requests = [];
	const ui = await setupHooks(async (_channel, endpoint, payload) => {
		requests.push(endpoint);
		if (payload.sessionId === "old") return new Promise((resolve) => { resolveOld = resolve; });
		if (endpoint === "detail") return { ok: true, value: { records: [{ ...record, hunks: record.hunks.map(({ rows, ...h }) => ({ ...h, lines: [...rows.map((row) => row.t + row.s), "\\ No newline at end of file"] })) }] } };
		return { ok: true, value: { records: [{ ...record, hunks: undefined }] } };
	});
	ui.render(ui.pane, { sessionId: "old" });
	let view = ui.render(ui.pane, { sessionId: "new" });
	assert.doesNotMatch(textOf(view), /was here/);
	await settle();
	view = ui.render(ui.pane, { sessionId: "new" });
	assert.match(textOf(view), /was here/);
	assert.ok(requests.includes("detail"));
	assert.doesNotMatch(textOf(view), /No newline|undefined|NaN/);
	collectNodes(view, "ld-segbtn").find((button) => textOf(button) === "Side by side").props.onClick();
	view = ui.render(ui.pane, { sessionId: "new" });
	assert.match(textOf(view), /was here/);
	assert.match(textOf(view), /now here/);
	assert.doesNotMatch(textOf(view), /No newline|undefined|NaN/);
	resolveOld({ ok: true, value: { records: [{ ...record, path: "OLD-SESSION" }] } }); await settle();
	assert.doesNotMatch(textOf(ui.render(ui.pane, { sessionId: "new" })), /OLD-SESSION/);
	ui.dispose();
});

test("checkpoint prefix is unavailable historically and requires explicit files-only confirmation", async () => {
	const requests = [];
	const ui = await setupHooks(async (_channel, endpoint, payload) => { requests.push({ endpoint, payload }); return { ok: true, value: { records: [{ ...record, turn: 3, time: 5 }] } }; });
	const turn = { turn: 3, status: "closed", start: { data: { turn: 3 }, time: 1 }, end: { time: 2 } };
	ui.render(ui.footer, { sessionId: "s1", turn, seq: 9 }); await settle();
	const view = ui.render(ui.footer, { sessionId: "s1", turn, seq: 9 });
	assert.equal(collectNodes(view, "ld-turnfoot").length, 1, "the boundary row closes the turn");
	const checkpointElement = findComponent(view, "CheckpointControl");
	assert.ok(checkpointElement, "the checkpoint control sits on the boundary row, not the turn header");
	assert.ok(findComponent(view, "ForkControl"), "the same row offers a fork");
	const run = hookRunner(); Object.assign(ui.hooks, run.hooks);
	let checkpoint = run.render(checkpointElement.type, { ...checkpointElement.props, payload: { checkpoints: [{ turn: 3, status: "unavailable", limitations: [] }] } });
	assert.equal(findButton(checkpoint, "ld-cplink").props.disabled, true, "historical turns do not offer a restore");
	const props = { ...checkpointElement.props, payload: { checkpoints: [{ turn: 3, status: "ready", limitations: [] }] } };
	checkpoint = run.render(checkpointElement.type, props);
	findButton(checkpoint, "ld-cplink").props.onClick();
	assert.equal(requests.filter((r) => r.endpoint === "restore-checkpoint").length, 0, "the first press only asks for confirmation");
	checkpoint = run.render(checkpointElement.type, props);
	assert.match(textOf(checkpoint), /before turn 3.*subsequent captured changes.*Only files/);
	await collectNodes(checkpoint, "ld-btn").find((button) => textOf(button) === "Restore").props.onClick();
	assert.deepEqual(requests.find((r) => r.endpoint === "restore-checkpoint").payload, { sessionId: "s1", turn: 3 });
	run.dispose(); ui.dispose();
});

test("the boundary row forks the conversation from the turn's last step", async () => {
	const forks = [];
	const opened = [];
	const ui = await setupHooks(async () => ({ ok: true, value: { records: [{ ...record, turn: 3, time: 5 }] } }), {
		sessions: { fork: async (input) => { forks.push(input); return "child-1"; } },
		openSession: (id) => opened.push(id)
	});
	const turn = { turn: 3, status: "closed", start: { data: { turn: 3 }, time: 1 }, end: { time: 2 } };
	ui.render(ui.footer, { sessionId: "s1", turn, seq: 9 }); await settle();
	const footer = ui.render(ui.footer, { sessionId: "s1", turn, seq: 9 });
	const element = findComponent(footer, "ForkControl");
	assert.ok(element, "the boundary row carries the fork control");
	const run = hookRunner();
	Object.assign(ui.hooks, run.hooks);
	const control = run.render(element.type, element.props);
	const button = findButton(control, "ld-cplink");
	assert.match(textOf(button), /Fork/);
	assert.equal(button.props.disabled, false, "the host can fork here");
	await button.props.onClick();
	await settle();
	assert.deepEqual(forks, [{ sessionId: "s1", atSeq: 9, increaseTitle: true }], "the fork branches at the turn end");
	assert.deepEqual(opened, ["child-1"], "the forked session opens");
	run.dispose();
	ui.dispose();
});

test("an inline file body folds its unchanged runs behind a bar that opens on demand", async () => {
	const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
	const before = lines.join("\n");
	const after = [...lines.slice(0, 4), "line 5 changed", ...lines.slice(5)].join("\n");
	const rich = {
		...record,
		before,
		after,
		hunks: [{ oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, rows: [
			{ t: "-", s: "line 5", old: 5, new: null },
			{ t: "+", s: "line 5 changed", old: null, new: 5 }
		] }]
	};
	const ui = await setupHooks(async () => ({ ok: true, value: { root: "/work", records: [rich] } }));
	ui.render(ui.pane, { sessionId: "s1" }); await settle();
	const view = ui.render(ui.pane, { sessionId: "s1" });
	const body = findComponent(view, "DiffBody");
	assert.ok(body, "the flat section renders the file body inline");
	const run = hookRunner();
	Object.assign(ui.hooks, run.hooks);
	let file = run.render(body.type, body.props);
	const bars = collectNodes(file, "ld-gap");
	assert.equal(bars.length, 2, "unchanged runs before and after the change are folded");
	assert.match(textOf(bars[0]), /4 unchanged lines/);
	assert.doesNotMatch(textOf(file), /line 1/, "folded lines are not rendered");
	bars[0].props.onClick();
	file = run.render(body.type, body.props);
	assert.match(textOf(file), /line 1/, "the bar opens those lines");
	run.dispose();
	ui.dispose();
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


test("polling cannot cancel reverse-order call undo or hide its deferred failures", async () => {
	let poll, resolveFirst;
	const mutations = [];
	const records = [record, { ...record, id: "e2" }];
	const ui = await setupHooks(async (_channel, endpoint, payload) => {
		if (endpoint === "revert") {
			mutations.push(payload.id);
			if (mutations.length === 1) return new Promise((resolve) => { resolveFirst = resolve; });
			return { ok: true, value: { failures: [{ path: record.path, message: "external conflict" }] } };
		}
		return { ok: true, value: { records: [...records] } };
	});
	const Row = ui.registrations.find((entry) => entry.spec.key === "edit").component;
	const rowRun = hookRunner(); Object.assign(ui.hooks, rowRun.hooks);
	rowRun.render(Row, { phase: "result", block: { callId: "c1" }, liveDiffSessionId: "s1" }); await settle();
	const row = rowRun.render(Row, { phase: "result", block: { callId: "c1" }, liveDiffSessionId: "s1" });
	findButton(row, "ld-badge").props.onClick();
	const run = hookRunner(); Object.assign(ui.hooks, run.hooks);
	const originalInterval = globalThis.setInterval;
	globalThis.setInterval = (fn) => { poll = fn; return { unref() {} }; };
	try { run.render(ui.pane, { sessionId: "s1" }); } finally { globalThis.setInterval = originalInterval; }
	await settle();
	let pane = run.render(ui.pane, { sessionId: "s1" });
	const pending = collectNodes(pane, "ld-btn").find((button) => button.props["aria-label"] === "Undo Selected call").props.onClick();
	assert.deepEqual(mutations, ["e2"]);
	poll(); await settle();
	pane = run.render(ui.pane, { sessionId: "s1" }); await settle();
	pane = run.render(ui.pane, { sessionId: "s1" });
	assert.equal(collectNodes(pane, "ld-btn").find((button) => button.props["aria-label"] === "Undo Selected call").props.disabled, true, "poll preserves busy state");
	resolveFirst({ ok: true, value: { failures: [] } }); await pending;
	assert.deepEqual(mutations, ["e2", "e1"], "poll does not abort the remaining undo target");
	pane = run.render(ui.pane, { sessionId: "s1" });
	assert.match(textOf(pane), /external conflict/);
	run.dispose(); rowRun.dispose(); ui.dispose();
});


test("mixed call hydration renders only exact visible list identities while inline detail stays full", async()=>{
 const covered={...record,id:"hidden-original",path:"/work/a"};
 const secret={...record,id:"secret",path:"/work/.env"};
 const net={...record,id:"checkpoint:1:a",callId:"checkpoint:1",path:"a",turn:1};
 const ui=await setupHooks(async(_c,endpoint,payload)=>({ok:true,value:{records:endpoint==="detail" ? payload.callId==="c1"?[covered,secret]:[net] : [{...secret,hunks:undefined},{...net,hunks:undefined}]}}));
 ui.render(ui.pane,{sessionId:"s1"});await settle();const view=ui.render(ui.pane,{sessionId:"s1"});
 assert.equal(collectNodes(view,"ld-flatfile").length,2,"every visible file gets its own section");
 assert.doesNotMatch(textOf(view),/hidden-original/);assert.doesNotMatch(textOf(view),/secret/);
 assert.equal(collectNodes(view,"ld-frow").length,0,"the old file index is gone");
 ui.dispose();
});
test("numeric historical footer carries the same bounded window into review and Keep",async()=>{
 const requests=[];const old={...record,time:150};
 const ui=await setupHooks(async(_c,endpoint,payload)=>{requests.push({endpoint,payload});return {ok:true,value:{records:[old]}};});
 const props={sessionId:"s1",turn:{turn:1,start:{time:100,data:{turn:1}},end:{time:200}}};
 ui.render(ui.footer,props);await settle();const footer=ui.render(ui.footer,props);
 findButton(footer,"ld-turnrow").props.onClick();
 const run=hookRunner();Object.assign(ui.hooks,run.hooks);run.render(ui.pane,{sessionId:"s1"});await settle();
 const pane=run.render(ui.pane,{sessionId:"s1"});assert.match(textOf(pane),/was here/);
 const request=requests.find(r=>r.endpoint==="review-turn");assert.deepEqual(request.payload,{sessionId:"s1",turn:1,from:100,to:200,callId:undefined});
 await collectNodes(pane,"ld-btn").find(b=>b.props["aria-label"]==="Keep Turn 1").props.onClick();
 assert.deepEqual(requests.find(r=>r.endpoint==="keep-turn").payload,{sessionId:"s1",turn:1,from:100,to:200});
 run.dispose();ui.dispose();
});
test("badge waits for asynchronously mounted target session and normal switches clear stale focus",async()=>{
 for(const initial of ["A",undefined]){
  const navigations=[],requests=[];
  const ui=await setupHooks(async(_c,endpoint,payload)=>{requests.push({endpoint,payload});if(endpoint==="summaries")return {ok:true,value:{sums:{B:{files:1,edits:1,added:1,removed:1}}}};return {ok:true,value:{records:[{...record,path:payload.sessionId+"-file"}],totals:{files:1,edits:1,added:1,removed:1}}};},{mountedId:initial===undefined?null:initial,openSession:id=>navigations.push(id)});
  if(initial===undefined)ui.mount(undefined);
  const Badge=ui.registrations.find(e=>e.slot==="sidebar.workspaces.session.row.action").component;
  queue=[{files:1,edits:1,added:1,removed:1}];
  // Seed the real totals hook via its async batch, while the pane uses an independent runner.
  ui.render(Badge,{sessionId:"B"});await settle();
  const badge=ui.render(Badge,{sessionId:"B"});assert.ok(badge);
  badge.props.onClick({stopPropagation(){}});assert.deepEqual(navigations,["B"]);assert.equal(ui.openedTabs.length,0);
  ui.mount("B");assert.equal(ui.openedTabs[0].sessionId,"B");
  const run=hookRunner();Object.assign(ui.hooks,run.hooks);run.render(ui.pane,{sessionId:"B"});await settle();
  let pane=run.render(ui.pane,{sessionId:"B"});assert.match(textOf(pane),/B-file/);assert.doesNotMatch(textOf(pane),/A-file/);
  await collectNodes(pane,"ld-btn").find(b=>b.props["aria-label"]==="Keep All changes").props.onClick();
  assert.equal(requests.find(r=>r.endpoint==="keep-all").payload.sessionId,"B");
  ui.mount("A");run.render(ui.pane,{sessionId:"A"});await settle();pane=run.render(ui.pane,{sessionId:"A"});assert.match(textOf(pane),/A-file/);assert.doesNotMatch(textOf(pane),/B-file/);
  run.dispose();ui.dispose();queue=[];
 }
});
test("badge without navigation support safely declines cross-session open",async()=>{
 const exported=loadBundle().factory(()=>react);const ui=makeClientCtx({noNavigation:true,mountedId:"A"});await exported.apply(ui.ctx);
 const Badge=ui.registrations.find(e=>e.slot==="sidebar.workspaces.session.row.action").component;
 queue=[{files:1,edits:1,added:1,removed:1}];const badge=Badge({sessionId:"B"});badge.props.onClick({stopPropagation(){}});assert.equal(ui.openedTabs.length,0);queue=[];
});
