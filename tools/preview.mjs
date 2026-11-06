/**
 * Render the plugin's own components outside DSH, so the README can show what
 * the UI looks like without shipping a screenshot of somebody's real session.
 *
 * The generated page loads `lib/client.js` exactly as the host module loader
 * does, runs `apply` against a fake service container to collect the registered
 * components, and mounts them with a small hook-capable renderer instead of
 * React. Every record below is synthetic: paths, project names and counts are
 * invented for the picture.
 *
 * Usage: node tools/preview.mjs > /tmp/preview.html
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundleSource = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

const harness = String.raw`
//#region fake records
var ENTRIES = [
	{
		id: "e1", callId: "c1", tool: "edit",
		path: "/work/product/src/rotator/slot_rotator.h",
		added: 54, removed: 55, created: false, deleted: false, state: "open", time: 1762459000000,
		hunks: [{
			oldStart: 41, oldLines: 6, newStart: 41, newLines: 6,
			rows: [
				{ t: " ", s: "void SlotRotator::rotate(const Spin& spin) {", old: 41, new: 41 },
				{ t: "-", s: "    if (spin.value > 0) {", old: 42, new: null },
				{ t: "+", s: "    if (spin.value >= kStopThreshold) {", old: null, new: 42 },
				{ t: "-", s: "        advanceBy(spin.value);", old: 43, new: null },
				{ t: "+", s: "        advanceBy(remap(spin.value));", old: null, new: 43 },
				{ t: " ", s: "    }", old: 44, new: 44 }
			]
		}]
	},
	{
		id: "e2", callId: "c2", tool: "write",
		path: "/work/product/src/pipeline/interval_checker.py",
		added: 104, removed: 0, created: true, deleted: false, state: "open", time: 1762459060000,
		hunks: [{
			oldStart: 0, oldLines: 0, newStart: 1, newLines: 104,
			rows: [
				{ t: "+", s: '"""Check that interval boundaries line up with the session clock."""', old: null, new: 1 },
				{ t: "+", s: "", old: null, new: 2 },
				{ t: "+", s: "from dataclasses import dataclass", old: null, new: 3 },
				{ t: "+", s: "", old: null, new: 4 },
				{ t: "+", s: "@dataclass(frozen=True)", old: null, new: 5 },
				{ t: "+", s: "class Interval:", old: null, new: 6 },
				{ t: "+", s: "    start: int", old: null, new: 7 },
				{ t: "+", s: "    end: int", old: null, new: 8 }
			]
		}]
	},
	{
		id: "e3", callId: "c3", tool: "apply_patch",
		path: "/work/product/config/feeds.toml",
		added: 7, removed: 4, created: false, deleted: false, state: "open", time: 1762459120000,
		hunks: [{
			oldStart: 12, oldLines: 4, newStart: 12, newLines: 7,
			rows: [
				{ t: " ", s: "[feeds.primary]", old: 12, new: 12 },
				{ t: "-", s: 'path = "/mnt/data/feeds"', old: 13, new: null },
				{ t: "+", s: 'path = "\${FEED_ROOT}/primary"', old: null, new: 13 },
				{ t: " ", s: "retry = 3", old: 14, new: 14 }
			]
		}]
	},
	{
		id: "e4", callId: "c3", tool: "apply_patch",
		path: "/work/product/src/updater.cpp",
		added: 163, removed: 3, created: false, deleted: false, state: "open", time: 1762459130000,
		hunks: [{
			oldStart: 88, oldLines: 3, newStart: 88, newLines: 5,
			rows: [
				{ t: "-", s: "    stream.open(channel);", old: 88, new: null },
				{ t: "+", s: "    stream.open(channel, std::ios::binary);", old: null, new: 88 },
				{ t: "+", s: "    if (!stream) throw std::runtime_error(\"channel closed\");", old: null, new: 89 },
				{ t: " ", s: "    pump(stream);", old: 89, new: 90 }
			]
		}]
	}
];

var SESSIONS = [
	{ id: "s1", title: "优化 interval checker 运行效率", totals: { edits: 4, files: 4, open: 4, openFiles: 4, added: 328, removed: 62 }, rel: "刚刚" },
	{ id: "s2", title: "增加 Level 2 行情支持", totals: { edits: 9, files: 6, open: 0, openFiles: 0, added: 1644, removed: 544 }, rel: "2 小时前" },
	{ id: "s3", title: "修改配置读取 fc 路径", totals: { edits: 2, files: 2, open: 2, openFiles: 2, added: 7, removed: 4 }, rel: "昨天" },
	{ id: "s4", title: "更新 updater.cpp 逻辑", totals: { edits: 1, files: 1, open: 1, openFiles: 1, added: 163, removed: 3 }, rel: "3 天前" }
];
var TOTALS = { edits: 4, files: 4, open: 4, openFiles: 4, added: 328, removed: 62 };
//#endregion

//#region mini renderer
var instances = new Map();
var rerenderScheduled = false;
var rootMount = null;
var pendingEffects = [];
var current = null;
var hookIndex = 0;

function createElement(type, props) {
	var merged = Object.assign({}, props || {});
	var children = Array.prototype.slice.call(arguments, 2);
	if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
	return { type: type, props: merged };
}

function schedule() {
	if (rerenderScheduled) return;
	rerenderScheduled = true;
	setTimeout(function () {
		rerenderScheduled = false;
		pass();
	}, 0);
}

function sameDeps(a, b) {
	if (a === undefined || b === undefined) return a === b;
	if (a.length !== b.length) return false;
	return a.every(function (value, index) { return Object.is(value, b[index]); });
}

var react = {
	createElement: createElement,
	useState: function (initial) {
		var instance = current;
		var index = hookIndex++;
		if (instance.hooks[index] === undefined) instance.hooks[index] = { value: initial };
		var slot = instance.hooks[index];
		function set(next) {
			var value = typeof next === "function" ? next(slot.value) : next;
			if (Object.is(value, slot.value)) return;
			slot.value = value;
			schedule();
		}
		return [slot.value, set];
	},
	useRef: function (initial) {
		var instance = current;
		var index = hookIndex++;
		if (instance.hooks[index] === undefined) instance.hooks[index] = { ref: { current: initial } };
		return instance.hooks[index].ref;
	},
	useCallback: function (fn, deps) {
		var instance = current;
		var index = hookIndex++;
		var slot = instance.hooks[index];
		if (slot === undefined || !sameDeps(slot.deps, deps)) instance.hooks[index] = { fn: fn, deps: deps };
		return instance.hooks[index].fn;
	},
	useEffect: function (fn, deps) {
		var instance = current;
		var index = hookIndex++;
		var slot = instance.hooks[index];
		if (slot === undefined || deps === undefined || !sameDeps(slot.deps, deps)) {
			instance.hooks[index] = { deps: deps };
			pendingEffects.push({ instance: instance, index: index, fn: fn });
		}
	}
};

function renderNode(node, parent, path) {
	if (node === null || node === undefined || node === false || node === true) return;
	if (typeof node === "string" || typeof node === "number") {
		parent.appendChild(document.createTextNode(String(node)));
		return;
	}
	if (Array.isArray(node)) {
		node.forEach(function (child, index) { renderNode(child, parent, path + "." + index); });
		return;
	}
	if (typeof node.type === "function") {
		var name = node.type.name || "component";
		var key = path + ">" + name + ":" + (node.props && node.props.key ? node.props.key : "");
		if (!instances.has(key)) instances.set(key, { hooks: [] });
		var instance = instances.get(key);
		var savedCurrent = current;
		var savedIndex = hookIndex;
		current = instance;
		hookIndex = 0;
		var output;
		try {
			output = node.type(node.props || {});
		} finally {
			current = savedCurrent;
			hookIndex = savedIndex;
		}
		renderNode(output, parent, key);
		return;
	}
	var element = node.type === "svg" || node.type === "path"
		? document.createElementNS("http://www.w3.org/2000/svg", node.type)
		: document.createElement(node.type);
	var props = node.props || {};
	Object.keys(props).forEach(function (prop) {
		var value = props[prop];
		if (prop === "children" || prop === "key") return;
		if (prop === "className") element.setAttribute("class", value);
		else if (prop === "viewBox" || prop === "ariaHidden" || /^(stroke|fill)/.test(prop)) {
			// SVG keeps viewBox camelCased; only stroke*/fill* props are dashed.
			var name = prop === "viewBox" ? "viewBox" : prop.replace(/[A-Z]/g, function (letter) { return "-" + letter.toLowerCase(); });
			if (value !== false && value !== null && value !== undefined) element.setAttribute(name, String(value));
		}
		else if (prop === "onClick") {
			element.addEventListener("click", function (event) { value(event); });
		} else if (prop === "disabled") {
			if (value) element.setAttribute("disabled", "");
		} else if (value === undefined || value === null || value === false) return;
		else element.setAttribute(prop, String(value));
	});
	parent.appendChild(element);
	renderNode(props.children, element, path);
}

function flushEffects() {
	var queued = pendingEffects;
	pendingEffects = [];
	queued.forEach(function (entry) {
		var slot = entry.instance.hooks[entry.index];
		if (slot && typeof slot.cleanup === "function") slot.cleanup();
		var cleanup = entry.fn();
		if (slot) slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
	});
}

function pass() {
	if (rootMount === null) return;
	rootMount.replaceChildren();
	renderNode(rootMount.__tree, rootMount, "root");
	flushEffects();
}
//#endregion

//#region fake services
var registered = new Map();
var dictionaries = {};

var connection = {
	rpc: {
		call: function (channel, endpoint, payload) {
			if (channel !== "/live-diff") return Promise.resolve({ ok: false, error: { message: "wrong channel" } });
			if (endpoint === "detail") {
				var callId = arguments.length > 2 && payload ? payload.callId : undefined;
				return Promise.resolve({
					ok: true,
					value: { records: ENTRIES.filter(function (entry) { return entry.callId === callId; }) }
				});
			}
			if (endpoint === "list") return Promise.resolve({ ok: true, value: { sessionId: "s1", totals: TOTALS, records: ENTRIES } });
			if (endpoint === "summaries") {
				var sums = {};
				SESSIONS.forEach(function (session) { sums[session.id] = session.totals; });
				return Promise.resolve({ ok: true, value: { sums: sums } });
			}
			if (endpoint === "keep" || endpoint === "revert" || endpoint === "keep-all" || endpoint === "revert-all") {
				return Promise.resolve({ ok: true, value: { sessionId: "s1", totals: TOTALS, records: ENTRIES } });
			}
			return Promise.resolve({ ok: false, error: { message: "unknown endpoint " + endpoint } });
		}
	}
};

function translate(namespace, key, vars) {
	var dicts = dictionaries[namespace];
	var template = (dicts && dicts.zh && dicts.zh[key]) || key;
	if (vars === undefined) return template;
	return template.replace(/\{(\w+)\}/g, function (match, name) {
		return name in vars ? String(vars[name]) : match;
	});
}

function makeContext() {
	return {
		get: function (name) {
			if (name === "connection") return connection;
			if (name === "sidebarRight") return { openTab: function () {} };
			if (name === "sidebarRightTabs") return { register: function () { return function () {}; } };
			return undefined;
		},
		effect: function (fn) { return fn(); },
		locale: {
			register: function (namespace, dicts) { dictionaries[namespace] = dicts; },
			bind: function (namespace) { return function (key, vars) { return translate(namespace, key, vars); }; }
		},
		slots: {
			register: function (spec, component) {
				registered.set(spec.name + "/" + (spec.key || spec.id || ""), component);
				return function () {};
			},
			inject: function (slot, factory) { return factory(); }
		}
	};
}
//#endregion

//#region page
function findBySlot(name) {
	var found;
	registered.forEach(function (component, key) {
		if (found === undefined && (key === name || key.indexOf(name + "/") === 0)) found = component;
	});
	return found;
}

function buildPage(bundleCss) {
	function t(key, vars) { return translate("live-diff", key, vars); }
	var Row = findBySlot("tool.call.toolview/edit");
	var Pane = findBySlot("sidebar.right.pane.tab");
	var Badge = findBySlot("sidebar.workspaces.session.row.action");
	var common = { cwd: "/work/product", home: "/home/dev", openFile: function () {}, t: t };

	var sessions = SESSIONS.map(function (session) {
		return createElement("div", { className: "pv-session" },
			createElement("div", { className: "pv-title" }, session.title),
			createElement("div", { className: "pv-meta" },
				Badge === undefined ? null : createElement(Badge, { sessionId: session.id, t: t }),
				createElement("span", { className: "pv-ago" }, session.rel)
			)
		);
	});

	var rows = [
		createElement(Row, { phase: "result", block: { callId: "c1" }, callId: "c1", liveDiffSessionId: "s1", cwd: common.cwd, home: common.home, openFile: common.openFile, t: t }),
		createElement(Row, { phase: "result", block: { callId: "c2" }, callId: "c2", liveDiffSessionId: "s1", cwd: common.cwd, home: common.home, openFile: common.openFile, t: t }),
		createElement(Row, { phase: "result", block: { callId: "c3", args: { path: "/work/product/config/feeds.toml" } }, callId: "c3", liveDiffSessionId: "s1", cwd: common.cwd, home: common.home, openFile: common.openFile, t: t }),
		// No server record for this one: the row builds its diff from the arguments,
		// which is what an imported transcript or a bypassing tool looks like.
		createElement(Row, {
			phase: "result",
			toolName: "replace_string_in_file",
			block: {
				callId: "c4",
				args: {
					filePath: "/work/product/src/rotator.h",
					oldString: "  int slots = 4;\n  bool rotate = false;\n  double epsilon = 1e-6;\n",
					newString: "  int slots = 8;\n  bool rotate = true;\n  double epsilon = 1e-9;\n"
				}
			},
			callId: "c4",
			liveDiffSessionId: "s1",
			cwd: common.cwd,
			home: common.home,
			openFile: common.openFile,
			t: t
		})
	];

	var tree = createElement("div", { className: "pv-app" },
		createElement("aside", { className: "pv-side" },
			createElement("div", { className: "pv-sidehead" }, "会话"),
			createElement("div", { className: "pv-sessions" }, sessions)
		),
		createElement("main", { className: "pv-chat" },
			createElement("div", { className: "pv-msg" }, "把 interval checker 的重算逻辑改成按区间批处理，配置路径改成从环境变量读。"),
			createElement("div", { className: "pv-rows" }, rows)
		),
		createElement("section", { className: "pv-pane" },
			createElement("div", { className: "pv-panehead" }, "变更"),
			createElement("div", { className: "pv-panebody" }, Pane === undefined ? null : createElement(Pane, { sessionId: "s1", cwd: common.cwd, home: common.home, openFile: common.openFile, t: t }))
		)
	);

	rootMount = document.getElementById("root");
	rootMount.__tree = tree;
	document.getElementById("plugin-css").textContent = bundleCss;
	pass();
}

function boot() {
	var found = [];
	var fakeWindow = { __ModuleLoader__: { load: function (definition) { found.push(definition); } } };
	new Function("window", __BUNDLE_SOURCE__)(fakeWindow);
	var definition = found[0];
	var exported = definition.factory(function (id) {
		if (id === "react") return react;
		if (id === "react/jsx-runtime") return { jsx: createElement, jsxs: createElement };
		throw new Error("unexpected require " + id);
	});
	var css = "";
	var realCreate = document.createElement.bind(document);
	document.createElement = function (tag) {
		var element = realCreate(tag);
		if (tag === "style") {
			Object.defineProperty(element, "textContent", {
				set: function (value) { css = value; },
				get: function () { return css; }
			});
		}
		return element;
	};
	exported.apply(makeContext());
	document.createElement = realCreate;
	buildPage(css);
	if (location.search.indexOf("expand") >= 0) {
		setTimeout(function () {
			var match = /expand=(\d+)/.exec(location.search);
			var index = match === null ? 0 : Number(match[1]) - 1;
			var toggles = document.querySelectorAll(".ld-toggle");
			if (toggles[index]) toggles[index].click();
		}, 400);
	}
}

window.addEventListener("DOMContentLoaded", boot);
//#endregion
`;

const theme = `
:root {
	--dsw-alias-label-primary: #e9e9ea;
	--dsw-alias-label-secondary: #b4b4b8;
	--dsw-alias-label-tertiary: #8b8b90;
	--dsw-alias-bg-base: #17181a;
	--dsw-alias-bg-module-platform: #232427;
	--dsw-alias-border-l1: rgba(255,255,255,.10);
	--dsw-alias-border-l2: rgba(255,255,255,.20);
	--dsw-alias-border-l3: rgba(255,255,255,.28);
	--dsw-alias-interactive-bg-hover: rgba(255,255,255,.08);
	--dsw-alias-state-business-primary: #5b9dff;
	--dsw-alias-state-success-primary: #4ade80;
	--dsw-alias-state-error-primary: #f87171;
	--dsh-diff-add-color: #4ade80;
	--dsh-diff-del-color: #f87171;
	--dsw-radius-sm: 6px;
	--dsw-radius-md: 9px;
	--dsw-radius-lg: 14px;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: #101113; color: var(--dsw-alias-label-primary);
	font: 13px/1.55 "Inter", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; }
.pv-app { display: grid; grid-template-columns: 236px minmax(0, 1fr) 384px; gap: 10px; height: 100vh; padding: 10px; }
.pv-side, .pv-chat, .pv-pane { background: var(--dsw-alias-bg-base); border: 1px solid var(--dsw-alias-border-l1);
	border-radius: var(--dsw-radius-lg); overflow: hidden; display: flex; flex-direction: column; }
.pv-sidehead, .pv-panehead { padding: 10px 14px; font-size: 12px; letter-spacing: .04em;
	color: var(--dsw-alias-label-tertiary); border-bottom: 1px solid var(--dsw-alias-border-l1); }
.pv-sessions { padding: 6px; display: flex; flex-direction: column; gap: 2px; }
.pv-session { padding: 8px 10px; border-radius: var(--dsw-radius-md); }
.pv-session:hover { background: var(--dsw-alias-interactive-bg-hover); }
.pv-title { font-size: 12.5px; color: var(--dsw-alias-label-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pv-meta { display: flex; align-items: center; gap: 8px; margin-top: 2px; font-size: 11.5px; color: var(--dsw-alias-label-tertiary); }
.pv-ago { margin-left: auto; }
.pv-chat { padding: 16px 18px 18px; gap: 12px; align-content: start; }
.pv-chat > * { flex: none; }
.pv-msg { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-module-platform);
	border: 1px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md); padding: 10px 12px; max-width: 560px; }
.pv-rows { display: flex; flex-direction: column; gap: 6px; }
.pv-panebody { overflow: auto; flex: 1; }
`;

const page = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-live-diff preview</title>
<style>${theme}</style>
<style id="plugin-css"></style>
</head>
<body>
<div id="root"></div>
<script>
${harness.replace("__BUNDLE_SOURCE__", JSON.stringify(bundleSource))}
</script>
</body>
</html>
`;

process.stdout.write(page);
