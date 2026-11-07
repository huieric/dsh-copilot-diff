/**
 * dsh-copilot-diff — client half, loaded as a hand-written bundle through
 * `window.__ModuleLoader__.load` (no build step, like the other DSH web plugins).
 *
 * Three seats, all reading the same per-session log:
 * - `tool.call.toolview`: one folded row per mutation, `+A −R` and a hidden diff.
 * - `sidebar.right.pane.tab`: the review panel, chronological, every file with
 *   its diff open, Keep / Undo all at the top.
 * - `sidebar.workspaces.session.row.action` + `sidebar.session.row.hover`: the
 *   session's running totals in the sidebar.
 */
window.__ModuleLoader__.load({
	id: "dsh-copilot-diff",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;

		/** Connection channel served by lib/index.js. */
		const CHANNEL = "/copilot-diff";
		/** Locale namespace for this plugin's strings. */
		const NS = "copilot-diff";
		/** Rows shown per file before the "show more" affordance. */
		const PREVIEW_ROWS = 12;
		/** Tab kind and registration id of the docked review panel. */
		const PANEL_KIND = "copilot-diff";
		const PANEL_ID = "dsh-copilot-diff";

		/** Connection bridge, filled in by `apply`. */
		let bridge = null;
		/** Right-sidebar services, looked up once in `apply`; absent on hosts without one. */
		let sidebarRight = null;
		let sidebarRightTabs = null;
		let uiWorkspace = null;
		let cancelNavigation = () => {};

		//#region panel focus
		/**
		 * Which call the review panel should scroll to and expand. The panel is a
		 * sidebar tab, so it cannot receive an argument from the row that opened it;
		 * the ask travels through this module-level store instead.
		 */
		let focusState = { callId: undefined, sessionId: undefined, revision: 0 };
		/** Listeners woken when the focus changes. */
		const focusListeners = new Set();

		/** Re-render whenever the focus changes. */
		function useFocus() {
			const [snapshot, setSnapshot] = react.useState(focusState);
			react.useEffect(() => {
				const listener = (next) => setSnapshot(next);
				focusListeners.add(listener);
				return () => {
					focusListeners.delete(listener);
				};
			}, []);
			return snapshot;
		}

		/**
		 * Open the review panel on one call.
		 * @param callId - the tool call whose diff the reader asked for.
		 * @param sessionId - the session that call belongs to.
		 * @returns false when this host has no right sidebar.
		 */
		function openPanel(callId, sessionId, scope = {}) {
			cancelNavigation();
			const mounted = sidebarRight?.mounted;
			const publish = () => {
				focusState = { callId, sessionId, ...scope, revision: focusState.revision + 1 };
				for (const listener of Array.from(focusListeners)) listener(focusState);
				sidebarRight.openTab(PANEL_KIND, { revealIfOpened: true });
			};
			try {
				if (typeof sidebarRight?.openTab !== "function") return false;
				if (mounted?.getSnapshot?.() === sessionId) { publish(); return true; }
				if (!mounted?.subscribe || !uiWorkspace?.openSession || typeof sessionId !== "string") return false;
				let stopped = false, unsubscribe = () => {}, timer;
				const stop = () => { stopped = true; unsubscribe(); clearTimeout(timer); };
				cancelNavigation = stop;
				const observe = () => {
					if (stopped || mounted.getSnapshot() !== sessionId) return;
					stop();
					try { publish(); } catch { /* Navigation was superseded; never open another session. */ }
				};
				unsubscribe = mounted.subscribe(observe);
				timer = setTimeout(stop, 10000);
				uiWorkspace.openSession(sessionId);
				observe();
				return true;
			} catch { cancelNavigation(); return false; }
		}
		//#endregion

		//#region host file rows
		/** Session whose conversation is on screen, learned from the turn views. */
		let lastSessionId = null;

		/**
		 * The session the review panel should open for. The right sidebar knows the
		 * mounted session; a host without one falls back to the last turn view.
		 * @returns the session id, or null.
		 */
		function currentSessionId() {
			let id = null;
			try {
				const mounted = sidebarRight?.mounted;
				id = typeof mounted?.getSnapshot === "function" ? mounted.getSnapshot() : null;
			} catch {
				id = null;
			}
			if (typeof id !== "string") id = lastSessionId;
			return typeof id === "string" ? id : null;
		}

		/**
		 * The tool call behind a click on a host file row's `+A −R` numbers.
		 *
		 * The host paints those numbers itself and gives them no action. Its class
		 * names are hashed per build, so the numbers are found by the stable half
		 * (`diffStat`) and the row by the `data-chat-call-id` it carries.
		 * @param node - the click target.
		 * @returns the call id, or null when the click is not on those numbers.
		 */
		function hostStatCallId(node) {
			if (node === null || node === void 0 || typeof node.closest !== "function") return null;
			const stats = node.closest('[class*="diffStat"]');
			if (stats === null) return null;
			const row = stats.closest("[data-chat-call-id]");
			const callId = row === null ? null : row.getAttribute("data-chat-call-id");
			return typeof callId === "string" && callId !== "" ? callId : null;
		}

		/** Whether the document listener below is already attached. */
		let hostRowClicks = false;

		/**
		 * Route a click on a host file row's numbers to the review panel: the same
		 * panel our own row opens from its badge, so a finished turn's numbers and
		 * the panel agree on what "this change" means. Taken in the capture phase so
		 * the click never reaches the row's own link.
		 */
		function installHostRowClicks() {
			if (hostRowClicks || typeof document === "undefined" || typeof document.addEventListener !== "function") return;
			hostRowClicks = true;
			document.addEventListener(
				"click",
				(event) => {
					const callId = hostStatCallId(event.target);
					if (callId === null) return;
					const sessionId = currentSessionId();
					if (sessionId === null) return;
					if (!openPanel(callId, sessionId)) return;
					event.preventDefault();
					event.stopPropagation();
				},
				true
			);
		}
		//#endregion

		//#region session totals cache
		/**
		 * Retained session totals, keyed by session id. The sidebar renders one row
		 * per session and a row must not poll on its own, so every mounted row joins
		 * one batch: a single `summaries` call covers the whole list.
		 */
		const sumCache = new Map();
		/** Sessions with a live row on screen. */
		const sumInterested = new Set();
		/** Row listeners, by session id. */
		const sumListeners = new Map();
		/** Pending batch timer. */
		let sumTimer = null;

		/**
		 * Read every visible row's totals in one call, then schedule the next sweep.
		 * @returns nothing.
		 */
		async function pumpTotals() {
			const ids = Array.from(sumInterested);
			if (ids.length > 0) {
				try {
					const reply = await call("summaries", { sessionIds: ids });
					if (reply?.ok === true) {
						for (const id of ids) {
							const totals = reply.value.sums[id];
							sumCache.set(id, totals ?? null);
							for (const listener of sumListeners.get(id) ?? []) listener(totals ?? null);
						}
					}
				} catch {
					// A missing channel simply means no badges for now.
				}
			}
			if (sumTimer === null && sumInterested.size > 0) {
				sumTimer = setTimeout(() => {
					sumTimer = null;
					void pumpTotals();
				}, 5000);
			}
		}

		/**
		 * Session totals for one row, kept fresh while the row is mounted.
		 * @param sessionId - the row's session.
		 * @returns totals, or null when the session has no edits yet.
		 */
		function useSessionTotals(sessionId) {
			const [totals, setTotals] = react.useState(
				typeof sessionId === "string" ? sumCache.get(sessionId) ?? null : null
			);
			react.useEffect(() => {
				if (typeof sessionId !== "string") return undefined;
				const listener = (next) => setTotals(next);
				const bucket = sumListeners.get(sessionId);
				if (bucket === undefined) sumListeners.set(sessionId, new Set([listener]));
				else bucket.add(listener);
				sumInterested.add(sessionId);
				void pumpTotals();
				return () => {
					const current = sumListeners.get(sessionId);
					if (current !== undefined) {
						current.delete(listener);
						if (current.size === 0) sumListeners.delete(sessionId);
					}
					sumInterested.delete(sessionId);
				};
			}, [sessionId]);
			return totals;
		}
		//#endregion

		//#region transport + store
		/**
		 * Call the server half and return its raw `{ ok, value?, error? }` reply.
		 * @param endpoint - channel endpoint name.
		 * @param payload - `{ sessionId, ... }`.
		 * @returns the reply.
		 */
		async function call(endpoint, payload) {
			if (bridge === null) throw new Error("copilot-diff is not connected");
			return await bridge.rpc.call(CHANNEL, endpoint, payload);
		}

		/** Listeners woken when any view changed the log. */
		const listeners = new Set();
		/** Monotonic counter bumped on every local change. */
		const state = { revision: 0 };

		/** Tell every mounted view that the log moved. */
		function notify() {
			for (const key of recordCache.keys()) void refreshRecords(key);
			state.revision += 1;
			for (const listener of Array.from(listeners)) listener(state.revision);
		}

		/**
		 * Subscribe to change notifications.
		 * @param listener - callback.
		 * @returns the unsubscribe function.
		 */
		function subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}

		/** Re-render whenever the shared revision changes. */
		function useRevision() {
			const [revision, setRevision] = react.useState(state.revision);
			react.useEffect(() => subscribe((next) => setRevision(next)), []);
			return revision;
		}
		//#endregion

		//#region per-session record cache
		/**
		 * Whole `list` payload per session, shared by every turn header on screen.
		 * A session with forty turns must not issue forty requests, so one poll
		 * feeds all of them and each header filters its own turn window locally.
		 */
		const recordCache = new Map();
		/** Poll cadence for a mounted turn header. */
		const RECORD_POLL_MS = 4000;

		/**
		 * Re-read one session's records and wake its listeners.
		 * @param sessionId - the session to read.
		 * @returns nothing.
		 */
		async function refreshRecords(sessionId) {
			const entry = recordCache.get(sessionId);
			if (entry === undefined || entry.loading) return;
			entry.loading = true;
			try {
				const reply = await call("list", { sessionId });
				if (reply?.ok === true) {
					entry.value = reply.value;
					for (const listener of Array.from(entry.listeners)) listener(entry.value);
				}
			} catch {
				// No channel yet: the header simply shows no numbers.
			} finally {
				entry.loading = false;
			}
		}

		/**
		 * Records of one session, polled while at least one header is mounted.
		 * @param sessionId - the session to follow.
		 * @returns the latest `list` payload, or null.
		 */
		function useSessionRecords(sessionId) {
			const key = typeof sessionId === "string" ? sessionId : null;
			const [snapshot, setValue] = react.useState({ key, value: key === null ? null : recordCache.get(key)?.value ?? null });
			react.useEffect(() => {
				if (key === null) return undefined;
				let entry = recordCache.get(key);
				if (entry === undefined) {
					entry = { value: null, loading: false, listeners: new Set(), timer: null };
					recordCache.set(key, entry);
				}
				setValue({ key, value: entry.value });
				const listener = (next) => setValue({ key, value: next });
				entry.listeners.add(listener);
				void refreshRecords(key);
				if (entry.timer === null && typeof setInterval === "function") {
					entry.timer = setInterval(() => {
						void refreshRecords(key);
					}, RECORD_POLL_MS);
					entry.timer?.unref?.();
				}
				return () => {
					entry.listeners.delete(listener);
					if (entry.listeners.size === 0 && entry.timer !== null) {
						clearInterval(entry.timer);
						entry.timer = null;
					}
				};
			}, [key]);
			return snapshot?.key === key ? snapshot.value : null;
		}

		/**
		 * Sum one turn's records: files touched, added and removed lines, and the
		 * first record (used as the panel anchor when the header is clicked).
		 * @param payload - `list` payload.
		 * @param turn - the turn whose window to sum.
		 * @returns `{ files, added, removed, first }`.
		 */
		function turnSums(payload, turn) {
			const { from, to } = turnWindow(turn);
			const paths = new Set();
			let added = 0;
			let removed = 0;
			let first;
			for (const record of payload?.records ?? []) {
				if (!inTurn(record, turn)) continue;
				if (first === undefined) first = record;
				paths.add(record.path);
				added += record.added ?? 0;
				removed += record.removed ?? 0;
			}
			return { files: paths.size, added, removed, first, from, to };
		}
		//#endregion

		//#region formatting helpers
		/**
		 * Path as the reviewer should read it: workspace-relative when possible.
		 * @param path - absolute path.
		 * @param cwd - workspace root.
		 * @param home - home directory.
		 * @returns the display path.
		 */
		function displayPath(path, cwd, home) {
			if (typeof path !== "string") return "";
			if (typeof cwd === "string" && cwd.length > 1 && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
			if (typeof home === "string" && home.length > 1 && path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`;
			// Neither the workspace root nor the home prefix matched (an imported or
			// recovered session has no workspace), so keep the tail that identifies
			// the file instead of a path that would be clipped in the row anyway.
			const segments = path.split("/").filter(Boolean);
			if (segments.length > 3) return `…/${segments.slice(-3).join("/")}`;
			return path;
		}

		/**
		 * Last segment of a path.
		 * @param path - display path.
		 * @returns the file name.
		 */
		function baseName(path) {
			const parts = String(path ?? "").split("/");
			return parts[parts.length - 1] ?? path;
		}

		/**
		 * Translate through the slot's `t`, falling back to the English string when
		 * the locale service did not hand one over (the row must never throw).
		 * @param t - translator from the slot, possibly absent.
		 * @returns a translator.
		 */
		function makeT(t) {
			return typeof t === "function" ? t : (key, fallback) => fallback ?? key;
		}

		/**
		 * Translate a template and fill its placeholders. Never hands the runtime
		 * translator a bare string as its parameters object, and tolerates a slot
		 * that supplies no translator at all.
		 * @param t - translator from the slot, possibly undefined.
		 * @param key - dictionary key.
		 * @param fallback - English text used when no dictionary is bound.
		 * @param vars - placeholder values.
		 * @returns the filled text.
		 */
		function fill(t, key, fallback, vars) {
			let value = fallback;
			if (typeof t === "function") {
				const found = t(key);
				if (typeof found === "string" && found !== key) value = found;
			}
			return value.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
		}

		/**
		 * Verb for one record, derived from what the edit did.
		 * @param record - stored edit entry.
		 * @param t - translator.
		 * @returns the verb.
		 */
		function verbOf(record, t) {
			if (record.deleted) return t("verb.deleted", "Deleted");
			if (record.created) return t("verb.created", "Created");
			if (record.tool === "git") return t("verb.changed", "Changed");
			if (record.tool === "workspace") return t("verb.changed", "Changed");
			if (record.tool === "write" || record.tool === "write_to_file") return t("verb.wrote", "Wrote");
			if (record.tool === "create_file") return t("verb.created", "Created");
			if (record.tool === "replace_string_in_file" || record.tool === "multi_replace_string_in_file") {
				return t("verb.replaced", "Replaced");
			}
			return t("verb.edited", "Edited");
		}

		/**
		 * Group records by path, keeping first-seen order.
		 * @param records - stored entries.
		 * @returns `[{ path, items }]`.
		 */
		function groupByPath(records) {
			const groups = [];
			for (const record of records) {
				const existing = groups.find((group) => group.path === record.path);
				if (existing === undefined) groups.push({ path: record.path, items: [record] });
				else existing.items.push(record);
			}
			return groups;
		}

		/**
		 * Flatten hunks into render rows, inserting a hunk header row.
		 * @param hunks - stored hunks.
		 * @returns rows of `{ kind: 'header'|'line', ... }`.
		 */
		function hunkRows(hunk) {
			let old = hunk.oldStart, next = hunk.newStart;
			return (hunk.rows ?? hunk.lines ?? []).flatMap((line) => {
				if (typeof line !== "string") return [line];
				const t = line[0];
				if (![" ", "+", "-"].includes(t)) return []; // Includes the no-newline metadata marker.
				return [{ t, s: line.slice(1), old: t === "+" ? null : old++, new: t === "-" ? null : next++ }];
			});
		}

		function flattenHunks(hunks) {
			const out = [];
			for (const [hunkIndex, hunk] of (Array.isArray(hunks) ? hunks : []).entries()) {
				out.push({
					kind: "header",
					hunk: hunkIndex,
					text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
				});
				for (const [rowIndex, row] of hunkRows(hunk).entries()) {
					out.push({ kind: "line", row, hunk: hunkIndex, first: rowIndex === 0 });
				}
			}
			return out;
		}

		/** Unchanged runs longer than this collapse behind a single bar. */
		const GAP_COLLAPSE_AT = 4;
		/** Refuse to build a full-file view above this many rows. */
		const MAX_FULL_ROWS = 12000;

		/**
		 * Split a display path into the muted directory and the file name, the way
		 * the Changes list shows `src/app` + `layout.tsx`.
		 * @param path - display path.
		 * @returns `{ dir, base }`.
		 */
		function pathParts(path) {
			const text = String(path ?? "");
			const cut = text.lastIndexOf("/");
			if (cut < 0) return { dir: "", base: text };
			return { dir: text.slice(0, cut), base: text.slice(cut + 1) };
		}

		/**
		 * The letter VS Code puts on a changed file: added, deleted or modified.
		 * @param record - stored edit entry.
		 * @returns `"A" | "D" | "M"`.
		 */
		function changeLetter(record) {
			if (record?.created) return "A";
			if (record?.deleted) return "D";
			return "M";
		}

		/**
		 * Expand a stored diff into every line of the file, not just the hunks.
		 * The unchanged stretches between hunks become `gap` rows so the reader can
		 * open the rest of the file in place (VS Code's "expand unchanged region").
		 *
		 * @param before - full text before the edit, when the record kept it.
		 * @param after - full text after the edit, when the record kept it.
		 * @param hunks - stored hunks with old/new line numbers.
		 * @returns rows, or null when the full text or numbering is unusable.
		 */
		function fullRows(before, after, hunks) {
			if (typeof before !== "string" || typeof after !== "string") return null;
			if (!Array.isArray(hunks) || hunks.length === 0) return null;
			const oldLines = linesOf(before);
			const newLines = linesOf(after);
			const rows = [];
			// A new or deleted file has no lines on one side; its hunk anchor is 0.
			let oldAt = oldLines.length === 0 ? 0 : 1;
			let newAt = newLines.length === 0 ? 0 : 1;
			const pushGap = (from, to) => {
				if (from < 1 || to < from) return true;
				const lines = [];
				for (let n = from; n <= to; n++) {
					const next = newAt + (n - from);
					if (n > oldLines.length || next > newLines.length) return false;
					lines.push({ old: n, new: next, s: oldLines[n - 1] ?? "" });
				}
				newAt += lines.length;
				rows.push({ kind: "gap", lines });
				return true;
			};
			for (const [hunkIndex, hunk] of hunks.entries()) {
				const oldStart = Number(hunk?.oldStart);
				const newStart = Number(hunk?.newStart);
				const oldCount = Number(hunk?.oldLines);
				const newCount = Number(hunk?.newLines);
				if (![oldStart, newStart, oldCount, newCount].every(Number.isSafeInteger)) return null;
				if (oldCount === 0 ? oldStart !== 0 : oldStart < 1) return null;
				if (newCount === 0 ? newStart !== 0 : newStart < 1) return null;
				if (oldStart < oldAt) return null;
				if (!pushGap(oldAt, oldStart - 1)) return null;
				const hunkLineRows = hunkRows(hunk);
				if (hunkLineRows.length === 0) return null;
				for (const [rowIndex, row] of hunkLineRows.entries()) {
					if (row.old !== null && (row.old < 1 || row.old > oldLines.length)) return null;
					if (row.new !== null && (row.new < 1 || row.new > newLines.length)) return null;
					rows.push({ kind: "line", row, hunk: hunkIndex, first: rowIndex === 0 });
				}
				oldAt = oldStart + oldCount;
				newAt = newStart + newCount;
			}
			if (!pushGap(oldAt, oldLines.length)) return null;
			if (rows.length > MAX_FULL_ROWS) return null;
			return rows;
		}

		/**
		 * Pair full-file rows into left/right cells for the side-by-side view.
		 * A collapsed unchanged run stays a single full-width gap row.
		 * @param rows - rows from `fullRows`.
		 * @returns pairs, each either `{ gap }` or `{ left, right }`.
		 */
		function fullSideRows(rows) {
			const pairs = [];
			for (let i = 0; i < rows.length; ) {
				const item = rows[i];
				if (item.kind === "gap") {
					pairs.push({ gap: item.lines });
					i += 1;
					continue;
				}
				const marked = item.first === true ? { hunk: item.hunk, first: true } : {};
				if (item.row.t === " ") {
					pairs.push({ left: item.row, right: item.row, ...marked });
					i += 1;
					continue;
				}
				const removals = [];
				const additions = [];
				while (i < rows.length && rows[i].kind === "line" && rows[i].row.t === "-") removals.push(rows[i++].row);
				while (i < rows.length && rows[i].kind === "line" && rows[i].row.t === "+") additions.push(rows[i++].row);
				for (let j = 0; j < Math.max(removals.length, additions.length); j++) {
					pairs.push({ left: removals[j], right: additions[j], ...(j === 0 ? marked : {}) });
				}
			}
			return pairs;
		}

		/**
		 * Sum added/removed over a set of records.
		 * @param records - stored entries.
		 * @returns the totals.
		 */
		function sumOf(records) {
			let added = 0;
			let removed = 0;
			for (const record of records) {
				added += record.added ?? 0;
				removed += record.removed ?? 0;
			}
			return { added, removed };
		}
		//#endregion

		//#region icons
		/**
		 * Inline SVG icon.
		 * @param props - `{ name, className }`.
		 * @returns the element.
		 */
		function Icon({ name }) {
			const paths = {
				file: "M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM13 2v7h7",
				chevron: "M9 6l6 6-6 6",
				undo: "M3 7v6h6M3 13a9 9 0 1 0 3-7",
				check: "M20 6L9 17l-5-5",
				x: "M18 6L6 18M6 6l12 12",
				diff: "M12 3v18M5 8h5M5 16h5M15 8h5M15 16h5",
				history: "M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 8v4l3 2",
				split: "M12 3v18M5 4h3v16H5zM16 4h3v16h-3z",
				copy: "M9 9h11v11H9zM5 15H4V4h11v1",
				up: "M6 14l6-6 6 6",
				down: "M6 10l6 6 6-6"
			};
			return h(
				"svg",
				{
					className: "ld-ico",
					viewBox: "0 0 24 24",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.8,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true"
				},
				h("path", { d: paths[name] ?? paths.file })
			);
		}
		//#endregion

		//#region diff rendering
		/**
		 * The diff body of one file: header plus hunks, with a preview cap.
		 * @param props - `{ label, hunks, added, removed, openPath }`.
		 * @returns the element.
		 */
		function DiffBody(props) {
			const { label, hunks, added, removed, path, openFile, before, after, mode, compact, showHeader, t } = props;
			// Scrolling a large file re-renders this body on every frame; rebuilding
			// the whole-file row list each time is pure waste, so keep the last one.
			const cache = react.useRef(null);
			let full;
			if (cache.current !== null && cache.current.before === before && cache.current.after === after && cache.current.hunks === hunks) {
				full = cache.current.full;
			} else {
				full = fullRows(before, after, hunks);
				cache.current = { before, after, hunks, full };
			}
			const [showAll, setShowAll] = react.useState(props.full === true || compact !== true);
			const [openGaps, setOpenGaps] = react.useState({});
			const [viewport, setViewport] = react.useState({ top: 0, height: 0 });
			const scroller = react.useRef(null);
			// The host translator takes (key, params); passing the English fallback as
			// params would throw, so `fill` asks for the key alone and fills itself.
			const translate = (key, fallback, vars) => fill(t, key, fallback, vars ?? {});
			const limit = props.full === true ? Infinity : compact ? 40 : PREVIEW_ROWS;
			const split = mode === "split";
			const pairs = split ? (full !== null ? fullSideRows(full) : sideRows(hunks)) : [];
			const source = full !== null ? full : flattenHunks(hunks);
			const total = split ? pairs.length : source.length;
			const shownCount = showAll ? total : Math.min(total, limit);
			const hidden = total - shownCount;
			const expandAll = props.expandAll === true;
			const gapOpen = (index) => expandAll || openGaps[index] === true;
			const toggleGap = (index) => setOpenGaps((value) => {
				const next = { ...value };
				if (next[index] === true) delete next[index];
				else next[index] = true;
				return next;
			});

			/** One unified diff line: both gutters, the sign, then the text. */
			const lineNode = (row, key, extra, hunk) =>
				h(
					"div",
					{ className: `ld-line ld-dline ${extra}`.trim(), key, "data-hunk": hunk },
					h("span", { className: "ld-ln", key: "o" }, row.old === null || row.old === undefined ? "" : String(row.old)),
					h("span", { className: "ld-ln", key: "n" }, row.new === null || row.new === undefined ? "" : String(row.new)),
					h("span", { className: "ld-sign", key: "s" }, row.t === " " ? "" : row.t),
					h("span", { className: "ld-text", key: "t" }, row.s)
				);

			/** One side of a side-by-side row, with its own line number. */
			const cellNode = (row, side, key) => {
				const kind = row === undefined ? "empty" : row.t === "+" ? "add" : row.t === "-" ? "del" : "ctx";
				return h(
					"div",
					{ className: `ld-scell ${side} ${kind}`, key },
					row === undefined
						? null
						: [
							h("span", { className: "ld-ln", key: "n" }, String(side === "left" ? row.old : row.new)),
							h("span", { className: "ld-text", key: "t" }, row.s)
						]
				);
			};

			// Build a flat, fixed-height row model first. Both views render every row
			// at 20px, so the pane can mount only the window that is on screen
			// instead of thousands of DOM nodes (the whole-file view used to crawl on
			// large edits). A smaller diff still renders in one pass.
			const model = [];
			const hunkAt = new Map();
			if (!split) {
				let lastHunk;
				for (const [index, item] of source.slice(0, shownCount).entries()) {
					if (item.kind === "header") {
						// A whole-file view reads like VS Code's diff editor: no @@ bars.
						if (full === null) {
							hunkAt.set(item.hunk, model.length);
							model.push({ k: "head", key: `h${index}`, text: item.text, hunk: item.hunk });
						}
						continue;
					}
					if (item.kind === "gap") {
						const open = gapOpen(index);
						model.push({ k: "gap", key: `g${index}`, index, count: item.lines.length, open });
						if (open) for (const line of item.lines) model.push({ k: "line", key: `g${index}-${line.old}`, row: line });
						continue;
					}
					const row = item.row;
					const target = item.first === true && item.hunk !== undefined && item.hunk !== lastHunk ? item.hunk : undefined;
					if (item.hunk !== undefined) lastHunk = item.hunk;
					if (target !== undefined && !hunkAt.has(target)) hunkAt.set(target, model.length);
					model.push({ k: "line", key: `r${index}`, row, target });
				}
			} else {
				let lastHunk;
				for (const [index, pair] of pairs.slice(0, shownCount).entries()) {
					if (pair.header !== undefined) {
						if (full === null) {
							hunkAt.set(pair.hunk, model.length);
							model.push({ k: "shead", key: `h${index}`, text: pair.header, hunk: pair.hunk });
						}
						continue;
					}
					if (pair.gap !== undefined) {
						const open = gapOpen(index);
						model.push({ k: "sgap", key: `g${index}`, index, count: pair.gap.length, open });
						if (open) {
							for (const line of pair.gap) {
								model.push({ k: "sline", key: `gl${index}-${line.old}`, left: line, right: line });
							}
						}
						continue;
					}
					const target = pair.first === true && pair.hunk !== undefined && pair.hunk !== lastHunk ? pair.hunk : undefined;
					if (pair.hunk !== undefined) lastHunk = pair.hunk;
					if (target !== undefined && !hunkAt.has(target)) hunkAt.set(target, model.length);
					model.push({ k: "sline", key: `p${index}`, left: pair.left, right: pair.right, target });
				}
			}

			// Only the docked pane (full) virtualizes; the chat peek is capped at 40
			// rows and must stay plain so its height collapses with the row.
			const virtual = props.full === true && model.length > 240;
			const rowHeight = 22;
			const height = virtual ? (viewport.height > 0 ? viewport.height : 560) : 0;
			const start = virtual ? Math.max(0, Math.floor(viewport.top / rowHeight) - 8) : 0;
			const end = virtual ? Math.min(model.length, start + Math.ceil(height / rowHeight) + 16) : model.length;
			const frame = react.useRef(0);
			const onScroll = (event) => {
				const el = event?.currentTarget;
				if (el === null || el === undefined) return;
				const top = el.scrollTop ?? 0;
				const next = el.clientHeight ?? 0;
				if (Math.abs(top - viewport.top) < rowHeight && next === viewport.height) return;
				// One state update per animation frame keeps a fast flick smooth.
				if (typeof requestAnimationFrame !== "function") {
					setViewport({ top, height: next });
					return;
				}
				if (frame.current !== 0) return;
				frame.current = requestAnimationFrame(() => {
					frame.current = 0;
					setViewport({ top: el.scrollTop ?? 0, height: el.clientHeight ?? 0 });
				});
			};

			react.useEffect(() => {
				const el = scroller.current;
				if (el === null || el === undefined || !virtual) return undefined;
				const next = el.clientHeight ?? 0;
				if (next > 0 && next !== viewport.height) setViewport({ top: el.scrollTop ?? 0, height: next });
				return undefined;
			});

			react.useEffect(() => {
				const nav = props.navRef;
				if (nav === null || nav === undefined) return undefined;
				nav.current = (hunk) => {
					const index = hunkAt.get(hunk);
					const el = scroller.current;
					if (index === undefined || el === null || el === undefined) return;
					if (virtual) {
						el.scrollTop = Math.max(0, index * rowHeight - Math.max(0, (el.clientHeight ?? 0) / 3));
						setViewport({ top: el.scrollTop, height: el.clientHeight ?? 0 });
					}
					const paint = () => {
						const line = el.querySelector(`[data-hunk="${hunk}"]`);
						if (line !== null && typeof line.scrollIntoView === "function") line.scrollIntoView({ block: "center" });
					};
					if (typeof requestAnimationFrame === "function") requestAnimationFrame(paint);
					else paint();
				};
				return () => { nav.current = null; };
			});

			const rows = [];
			for (const entry of model.slice(start, end)) {
				if (entry.k === "head") {
					rows.push(h("div", { className: "ld-line ld-hunk ld-hunkhead", key: entry.key, "data-hunk": entry.hunk }, h("span", { className: "ld-text" }, entry.text)));
				} else if (entry.k === "gap") {
					rows.push(
						h(
							"button",
							{
								className: entry.open ? "ld-gap open" : "ld-gap",
								type: "button",
								key: entry.key,
								title: translate("diff.gapTitle", "Show or hide these unchanged lines"),
								onClick: () => toggleGap(entry.index)
							},
							entry.open
								? translate("diff.collapseGap", "Collapse {count} unchanged lines", { count: entry.count })
								: `⋯ ${entry.count} ${translate("diff.unchanged", "unchanged lines")}`
						)
					);
				} else if (entry.k === "line") {
					const extra = entry.row.t === "+" ? "add" : entry.row.t === "-" ? "del" : "ctx";
					rows.push(lineNode(entry.row, entry.key, extra, entry.target));
				} else if (entry.k === "shead") {
					rows.push(h("div", { className: "ld-sheader ld-hunk", key: entry.key, "data-hunk": entry.hunk }, entry.text));
				} else if (entry.k === "sgap") {
					rows.push(
						h(
							"button",
							{
								className: entry.open ? "ld-gap ld-sgap open" : "ld-gap ld-sgap",
								type: "button",
								key: entry.key,
								onClick: () => toggleGap(entry.index)
							},
							entry.open
								? translate("diff.collapseGap", "Collapse {count} unchanged lines", { count: entry.count })
								: `⋯ ${entry.count} ${translate("diff.unchanged", "unchanged lines")}`
						)
					);
				} else {
					rows.push(h("div", { className: "ld-srow", key: entry.key, "data-hunk": entry.target }, [cellNode(entry.left, "left", "l"), cellNode(entry.right, "right", "r")]));
				}
			}

			const body = split
				? h(
						"div",
						{ className: virtual || props.full === true ? "ld-split ld-vscroll" : "ld-split", key: "lines", ref: scroller, onScroll },
						virtual && start > 0 ? h("div", { key: "top", className: "ld-vpad", style: { height: start * rowHeight } }) : null,
						rows,
						virtual && end < model.length ? h("div", { key: "bottom", className: "ld-vpad", style: { height: (model.length - end) * rowHeight } }) : null
					)
				: h(
						"div",
						{ className: virtual || props.full === true ? "ld-difflines ld-vscroll" : "ld-difflines", key: "lines", ref: scroller, onScroll },
						virtual && start > 0 ? h("div", { key: "top", className: "ld-vpad", style: { height: start * rowHeight } }) : null,
						rows,
						virtual && end < model.length ? h("div", { key: "bottom", className: "ld-vpad", style: { height: (model.length - end) * rowHeight } }) : null
					);

			return h("div", { className: compact ? "ld-file ld-file-compact" : props.full === true ? "ld-file ld-file-fill" : "ld-file" }, [
				showHeader === false
					? null
					: h(
							"div",
							{ className: "ld-filehead", key: "head" },
							h(Icon, { name: "file", key: "i" }),
							h(
								"button",
								{
									className: "ld-path",
									type: "button",
									title: path,
									disabled: typeof openFile !== "function",
									onClick: () => {
										if (typeof openFile === "function" && typeof path === "string") openFile(path);
									}
								},
								baseName(label)
							),
							h("span", { className: "ld-add", key: "a" }, `+${added}`),
							h("span", { className: "ld-del", key: "d" }, `−${removed}`),
							full === null
								? h("span", { className: "ld-filehint", key: "x", title: translate("diff.noFull", "Full file text is unavailable for this historical edit") }, translate("diff.hunksOnly", "hunks only"))
								: null
						),
				full === null && source.length === 0
					? h("div", { className: "ld-diffempty", key: "empty" }, translate("diff.empty", "No textual diff was recorded"))
					: body,
				hidden > 0
					? h("button", { className: "ld-more", type: "button", key: "more", onClick: () => setShowAll(true) }, `${translate("diff.showMore", "Show")} ${hidden} ${translate("diff.moreLines", "more lines")}`)
					: showAll && Number.isFinite(limit) && total > limit
						? h("button", { className: "ld-more", type: "button", key: "less", onClick: () => setShowAll(false) }, translate("diff.collapse", "Collapse"))
						: null
			]);
		}

		/**
		 * Diff box for a set of records (one call may touch several files).
		 * @param props - `{ records, cwd, home, openFile }`.
		 * @returns the element.
		 */
		function DiffBox(props) {
			const { records, cwd, home, openFile } = props;
			const groups = groupByPath(records);
			return h(
				"div",
				{ className: "ld-diff" },
				groups.map((group) => {
					// The detail reply carries the whole before/after text; handing it
					// to the body lets the inline peek show the real file around the
					// edit instead of a bare hunk.
					const text = [...group.items].reverse().find((item) => typeof item.before === "string" && typeof item.after === "string");
					return h(DiffBody, {
						key: group.path,
						label: group.path,
						path: group.path,
						hunks: group.items.flatMap((item) => item.hunks ?? []),
						before: text?.before,
						after: text?.after,
						added: sumOf(group.items).added,
						removed: sumOf(group.items).removed,
						openFile,
						cwd,
						home,
						t: props.t
					});
				})
			);
		}
		//#endregion

		//#region per-call edit row
		/**
		 * One mutation row: verb, path, `+A −R`, inline diff, single-edit Undo.
		 * Replaces the built-in file row for `edit` / `write` / `apply_patch`.
		 * @param props - ToolCallViewProps.
		 * @returns the element.
		 */
		/**
		 * Split text into lines, dropping the empty tail a final newline leaves.
		 * @param text - file text.
		 * @returns the lines.
		 */
		function linesOf(text) {
			if (typeof text !== "string" || text.length === 0) return [];
			const parts = text.split("\n");
			if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
			return parts;
		}

		/**
		 * Entries derived from a call's arguments alone. Editor tools that swap
		 * text carry the change in their arguments, so a row can still show a
		 * diff when the host never reported a result for it — imported
		 * transcripts, plugins that bypass the tool pipeline, or a reload in the
		 * middle of a call.
		 * @param args - the call's parsed arguments.
		 * @returns `[{ path, before, after }]`.
		 */
		function argsEntries(args) {
			if (args === null || typeof args !== "object") return [];
			const list = Array.isArray(args.replacements) ? args.replacements : Array.isArray(args.edits) ? args.edits : undefined;
			const parts = list === undefined ? [args] : list;
			const entries = [];
			for (const item of parts) {
				if (item === null || typeof item !== "object") continue;
				const path = item.filePath ?? item.path ?? item.file;
				const oldString = item.oldString ?? item.oldText;
				const newString = item.newString ?? item.newText;
				const content = typeof item.content === "string" ? item.content : typeof item.fileContent === "string" ? item.fileContent : undefined;
				if (typeof path !== "string") continue;
				if (typeof newString === "string") {
					const before = typeof oldString === "string" ? oldString : "";
					if (before !== newString) entries.push({ path, before, after: newString });
					continue;
				}
				if (typeof content === "string" && content.length > 0) entries.push({ path, before: "", after: content });
			}
			return entries;
		}

		/**
		 * A record-shaped object for an argument-only change, so the existing
		 * diff renderer can draw it. There is no undo target: the host never
		 * reported this call.
		 * @param entry - `{ path, before, after }`.
		 * @returns `{ path, hunks, added, removed }`.
		 */
		function fragmentRecord(entry) {
			const removed = linesOf(entry.before);
			const added = linesOf(entry.after);
			const rows = [];
			removed.forEach((text, index) => rows.push({ t: "-", old: index + 1, new: null, s: text }));
			added.forEach((text, index) => rows.push({ t: "+", old: null, new: index + 1, s: text }));
			return {
				path: entry.path,
				hunks: [
					{
						oldStart: 1,
						oldLines: removed.length,
						newStart: 1,
						newLines: added.length,
						rows
					}
				],
				added: added.length,
				removed: removed.length
			};
		}

		function LiveDiffRow(props) {
			const { phase, openFile, cwd, home, block, liveDiffSessionId } = props;
			const t = makeT(props.t);
			const revision = useRevision();
			const [detail, setDetail] = react.useState({ loaded: false, records: [], error: null });
			const [notice, setNotice] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [open, setOpen] = react.useState(false);
			const focus = useFocus();
			const resultCallId = block?.callId ?? props.callId;
			const focusedHere = focus.callId !== undefined && focus.callId === resultCallId;
			const pendingPath = block?.args?.path ?? block?.args?.file_path ?? null;

			react.useEffect(() => {
				if (phase !== "result" || typeof resultCallId !== "string") return undefined;
				let cancelled = false;
				call("detail", { sessionId: liveDiffSessionId, callId: resultCallId })
					.then((reply) => {
						if (cancelled) return;
						if (reply?.ok === true) setDetail({ loaded: true, records: reply.value.records ?? [], error: null });
						else setDetail({ loaded: true, records: [], error: reply?.error?.message ?? "unavailable" });
					})
					.catch((error) => {
						if (!cancelled) setDetail({ loaded: true, records: [], error: String(error?.message ?? error) });
					});
				return () => {
					cancelled = true;
				};
			}, [phase, resultCallId, liveDiffSessionId, revision]);

			const onUndo = react.useCallback(
				async (id) => {
					setBusy(true);
					setNotice(null);
					try {
						const reply = await call("revert", { sessionId: liveDiffSessionId, id });
						setNotice(actionError(reply));
						notify();
					} catch (error) {
						setNotice(String(error?.message ?? error));
					} finally {
						setBusy(false);
					}
				},
				[t, liveDiffSessionId]
			);

			if (phase !== "result") {
				return h(
					"div",
					{ className: "ld-row" },
					h(
						"div",
						{ className: "ld-head" },
						h(Icon, { name: "file" }),
						h("span", { className: "ld-verb" }, t("verb.editing", "Editing")),
						pendingPath === null
							? null
							: h("span", { className: "ld-pathstatic" }, baseName(displayPath(pendingPath, cwd, home))),
						h("span", { className: "ld-spacer" }),
						h("span", { className: "ld-pending" }, "…")
					)
				);
			}

			const records = detail.records;
			if (records.length === 0) {
				const derived = argsEntries(block?.args).map(fragmentRecord);
				if (derived.length > 0) {
					const derivedTotals = sumOf(derived);
					const derivedGroups = groupByPath(derived);
					const derivedVerb =
						derivedGroups.length > 1
							? fill(t, "verb.editedN", "Edited {count} files", { count: derivedGroups.length })
							: verbOf({ tool: props.toolName }, t);
					const derivedLabel =
						derivedGroups.length > 1 ? null : baseName(displayPath(derivedGroups[0].path, cwd, home));
					return h(
						"div",
						{ className: "ld-row" },
						h(
							"div",
							{ className: "ld-head" },
							h(
								"button",
								{
									className: open ? "ld-toggle open" : "ld-toggle",
									type: "button",
									title: open ? t("row.collapse", "Hide this diff") : t("row.expand", "Show this diff"),
									"aria-expanded": open,
									onClick: () => setOpen((value) => !value)
								},
								h(Icon, { name: "chevron" })
							),
							h(Icon, { name: "file" }),
							h("span", { className: "ld-verb" }, derivedVerb),
							derivedLabel === null
								? null
								: h(
										"button",
										{
											className: "ld-path",
											type: "button",
											title: derivedGroups[0].path,
											onClick: () => {
												if (typeof openFile === "function") openFile(derivedGroups[0].path);
											}
										},
										derivedLabel
									),
							h(
								"span",
								{ className: "ld-badge" },
								h("span", { className: "ld-add" }, `+${derivedTotals.added}`),
								h("span", { className: "ld-del" }, `−${derivedTotals.removed}`)
							),
							h("span", { className: "ld-spacer" })
						),
						open ? h(DiffBox, { records: derived, cwd, home, openFile }) : null
					);
				}
				const fallbackPath = pendingPath ?? t("row.file", "file");
				return h(
					"div",
					{ className: "ld-row" },
					h(
						"div",
						{ className: "ld-head" },
						h(Icon, { name: "file" }),
						h("span", { className: "ld-verb" }, t("verb.edited", "Edited")),
						h("span", { className: "ld-pathstatic" }, baseName(displayPath(fallbackPath, cwd, home))),
						h("span", { className: "ld-spacer" }),
						detail.loaded && detail.error !== null ? h("span", { className: "ld-warn" }, detail.error) : null
					)
				);
			}

			const totals = sumOf(records);
			const groups = groupByPath(records);
			const undoable = records.filter((record) => record.state === "open");
			const verb =
				groups.length > 1
					? fill(t, "verb.editedN", "Edited {count} files", { count: groups.length })
					: verbOf(records[0], t);
			const label = groups.length > 1 ? null : baseName(displayPath(groups[0].path, cwd, home));

			// The row stays folded: the conversation must not turn into a wall of
			// diffs. The count badge is what opens the full review, and the chevron is
			// the inline peek — both are one press away from the same numbers.
			return h(
				"div",
				{ className: focusedHere ? "ld-row focused" : "ld-row" },
				h(
					"div",
					{ className: "ld-head" },
					h(
						"button",
						{
							className: open ? "ld-toggle open" : "ld-toggle",
							type: "button",
							title: open ? t("row.collapse", "Hide this diff") : t("row.expand", "Show this diff"),
							"aria-expanded": open,
							onClick: () => setOpen((value) => !value)
						},
						h(Icon, { name: "chevron" })
					),
					h(Icon, { name: "file" }),
					h("span", { className: "ld-verb" }, verb),
					label === null
						? null
						: h(
								"button",
								{
									className: "ld-path",
									type: "button",
									title: groups[0].path,
									onClick: () => {
										if (typeof openFile === "function") openFile(groups[0].path);
									}
								},
								label
							),
					h(
						"button",
						{
							className: "ld-badge",
							type: "button",
							title: t("row.reviewTitle", "Open this change in the review panel"),
							onClick: () => {
								if (!openPanel(resultCallId, liveDiffSessionId)) setOpen(true);
							}
						},
						h("span", { className: "ld-add" }, `+${totals.added}`),
						h("span", { className: "ld-del" }, `−${totals.removed}`)
					),
					h("span", { className: "ld-spacer" }),
					undoable.length === 1
						? h(
								"button",
								{
									className: "ld-btn",
									type: "button",
									disabled: busy,
									title: t("row.undoTitle", "Restore the text this edit replaced"),
									onClick: () => onUndo(undoable[0].id)
								},
								h(Icon, { name: "undo" }),
								h("span", null, t("row.undo", "Undo"))
							)
						: null,
					records.every((record) => record.state === "reverted")
						? h("span", { className: "ld-muted" }, t("row.reverted", "Undone"))
						: records.every((record) => record.state === "kept")
							? h("span", { className: "ld-muted" }, t("row.kept", "Kept"))
							: null
				),
				notice === null ? null : h("div", { className: "ld-notice" }, notice),
				open ? h(DiffBox, { records, cwd, home, openFile }) : null
			);
		}
		//#endregion

		//#region turn summary bar
		/**
		 * One record inside the review panel.
		 * @param props - `{ record, cwd, home, openFile, onUndo, busy }`.
		 * @returns the element.
		 */
		function PanelRecord(props) {
			const { record, cwd, home, openFile, onUndo, busy } = props;
			const t = makeT(props.t);
			const [open, setOpen] = react.useState(props.defaultOpen === true);
			const totals = sumOf([record]);
			return h(
				"div",
				{ className: "ld-pitem" },
				h(
					"div",
					{
						className: open ? "ld-phead open" : "ld-phead",
						onClick: () => setOpen((value) => !value),
						title: open ? t("row.collapse", "Hide this diff") : t("row.expand", "Show this diff")
					},
					h(
						"button",
						{
							className: "ld-ptoggle",
							type: "button",
							onClick: (event) => {
								if (event !== undefined && typeof event.stopPropagation === "function") event.stopPropagation();
								setOpen((value) => !value);
							}
						},
						h("span", { className: open ? "ld-chev open" : "ld-chev" }, h(Icon, { name: "chevron" }))
					),
					h(
						"button",
						{
							className: "ld-path",
							type: "button",
							title: record.path,
							onClick: (event) => {
								if (event !== undefined && typeof event.stopPropagation === "function") event.stopPropagation();
								if (typeof openFile === "function") openFile(record.path);
							}
						},
						displayPath(record.path, cwd, home)
					),
					h("span", { className: "ld-add" }, `+${totals.added}`),
					h("span", { className: "ld-del" }, `−${totals.removed}`),
					h("span", { className: "ld-spacer" }),
					record.state === "open"
						? h(
								"button",
								{
									className: "ld-btn",
									type: "button",
									disabled: busy,
									onClick: (event) => {
										if (event !== undefined && typeof event.stopPropagation === "function") event.stopPropagation();
										onUndo(record.id);
									}
								},
								h(Icon, { name: "undo" }),
								h("span", null, t("row.undo", "Undo"))
							)
						: h("span", { className: "ld-muted" }, record.state === "kept" ? t("row.kept", "Kept") : t("row.reverted", "Undone"))
				),
				open ? h(DiffBox, { records: [record], cwd, home, openFile }) : null
			);
		}


		//#region review panel (right sidebar)
		/**
		 * Group records by the tool call that produced them, newest call first.
		 * @param records - summary records.
		 * @returns `[{ callId, items }]`.
		 */
		function groupByCall(records) {
			const groups = [];
			for (const record of records) {
				const existing = groups.find((group) => group.callId === record.callId);
				if (existing === undefined) groups.push({ callId: record.callId, items: [record] });
				else existing.items.push(record);
			}
			return groups;
		}

		/**
		 * The docked review panel: every change of this session, grouped by the call
		 * that made it, each file folded until the reader asks for its diff.
		 * @param props - `{ sessionId }` from the slot inject (falls back to the last
		 * opened call's session).
		 * @returns the element.
		 */
		function actionError(reply) {
			if (reply?.ok !== true) return reply?.error?.message ?? "That did not work";
			const value = reply.value ?? {};
			if (value.conflict) return typeof value.conflict === "string" ? value.conflict : "Restore conflict: files have subsequent unrelated edits.";
			const failures = value.failures ?? [];
			return failures.length ? failures.map((item) => typeof item === "string" ? item : `${item.path ?? item.id ?? "File"}: ${item.error?.message ?? item.message ?? item.reason ?? item.error ?? "failed"}`).join("; ") : null;
		}

		function turnNumber(turn) {
			const number = turn?.start?.data?.turn ?? turn?.turn;
			return typeof number === "number" && Number.isFinite(number) ? number : undefined;
		}

		function inTurn(record, turn) {
			if (typeof record.turn === "number") return record.turn === turnNumber(turn);
			const { from, to } = turnWindow(turn);
			return record.time >= from && record.time <= to;
		}

		function sideRows(hunks) {
			const result = [];
			for (const [hunkIndex, hunk] of (hunks ?? []).entries()) {
				result.push({ header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, hunk: hunkIndex });
				const rows = hunkRows(hunk);
				let first = true;
				for (let i = 0; i < rows.length;) {
					if (rows[i].t === " ") {
						result.push({ left: rows[i], right: rows[i], hunk: hunkIndex, first });
						first = false;
						i++;
						continue;
					}
					const left = [], right = [];
					while (i < rows.length && rows[i].t !== " ") {
						(rows[i].t === "-" ? left : right).push(rows[i++]);
					}
					for (let j = 0; j < Math.max(left.length, right.length); j++) {
						result.push({ left: left[j], right: right[j], hunk: hunkIndex, first });
						first = false;
					}
				}
			}
			return result;
		}

		function SideDiff({ hunks }) {
			const rows = sideRows(hunks);
			return h("div", { className: "ld-side-diff", "aria-label": "Side by side diff" }, ["left", "right"].map((side) =>
				h("div", { key: side, className: "ld-side-code ld-difflines", tabIndex: 0, "aria-label": side === "left" ? "Before" : "After" }, rows.map((pair, index) => {
					const row = pair[side];
					return h("div", { key: index, className: pair.header ? "ld-line ld-hunk" : `ld-line ${row?.t === "+" ? "add" : row?.t === "-" ? "del" : ""}` },
						h("span", { className: "ld-ln" }, row?.[side === "left" ? "old" : "new"] ?? ""),
						h("span", { className: "ld-text" }, pair.header ?? row?.s ?? " "));
				}))));
		}

		function ReviewPane(props) {
			const focus = useFocus();
			const zh = isChinese(props.t);
			const revision = useRevision();
			const sessionId = typeof props.sessionId === "string" ? props.sessionId : focus.sessionId;
			const shared = useSessionRecords(sessionId);
			const scoped = focus.sessionId === sessionId ? focus : {};
			const scopeKey = `${sessionId}:${scoped.turn ?? scoped.from ?? "all"}:${scoped.callId ?? ""}`;
			const key = `${scopeKey}:${focus.revision}`;
			const [snapshot, setSnapshot] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState(null);
			const [mode, setMode] = react.useState("unified");
			const [selection, setSelection] = react.useState(null);
			const [reviewed, setReviewed] = react.useState([]);
			const [hunkIndex, setHunkIndex] = react.useState(0);
			const [expandAll, setExpandAll] = react.useState(false);
			// Copilot keeps the file index folded until asked for it: the diff owns
			// the pane, and a chosen file folds the index away again.
			const [listOpen, setListOpen] = react.useState(false);
			const [copied, setCopied] = react.useState(null);
			const editor = react.useRef(null);
			const nav = react.useRef(null);
			const generation = react.useRef(0);
			const fetchGeneration = react.useRef(0);
			react.useEffect(() => {
				generation.current++;
				setBusy(false);
				setReviewed([]);
				setHunkIndex(0);
				setExpandAll(false);
				setListOpen(false);
				setMode("unified");
				return () => { generation.current++; };
			}, [scopeKey]);
			react.useEffect(() => {
				let alive = true;
				const ticket = ++fetchGeneration.current;
				setSnapshot((value) => value?.key === key ? value : null); setNotice((value) => value?.key === key ? value : null); setSelection((value) => value?.key === key ? value : null);
				async function load() {
					try {
						const endpoint = typeof scoped.turn === "number" ? "review-turn" : scoped.callId ? "detail" : "list";
						const reply = await call(endpoint, { sessionId, turn: scoped.turn, from: scoped.from, to: scoped.to, callId: scoped.callId });
						const error = actionError(reply);
						if (error) throw new Error(error);
						let data = reply.value;
						if (typeof scoped.turn !== "number" && typeof scoped.from === "number") data = { ...data, records: (data.records ?? []).filter((record) => record.time >= scoped.from && record.time <= scoped.to) };
						// list deliberately omits bodies. Hydrate each call before rendering a diff.
						if (endpoint === "list") {
							const calls = [...new Set((data.records ?? []).map((record) => record.callId))];
							const details = await Promise.all(calls.map(async (callId) => {
								const detail = await call("detail", { sessionId, callId });
								if (actionError(detail)) throw new Error(actionError(detail));
								return detail.value.records ?? [];
							}));
							const visibleIds = new Set((data.records ?? []).map(record => record.id));
							const hydrated = details.flat().filter(record => visibleIds.has(record.id));
							if (new Set(hydrated.map(record => record.id)).size !== visibleIds.size) throw new Error("Some change details are unavailable");
							data = { ...data, records: hydrated };
						}
						if (alive && ticket === fetchGeneration.current) setSnapshot({ key, data });
					} catch (error) { if (alive && ticket === fetchGeneration.current) setNotice({ key, text: String(error.message ?? error) }); }
				}
				if (typeof sessionId === "string") void load();
				return () => { alive = false; fetchGeneration.current++; };
			}, [key, revision, shared]);
			const data = snapshot?.key === key ? snapshot.data : null;
			const groups = groupByPath(data?.records ?? []);
			const selectedPath = selection?.key === key ? selection.path : scoped.path;
			let index = groups.findIndex((group) => group.path === selectedPath);
			if (index < 0) index = 0;
			const selected = groups[index];
			const totals = sumOf(data?.records ?? []);
			async function mutate(action, id) {
				const ticket = generation.current;
				setBusy(true); setNotice(null);
				try {
					const endpoint = id ? action : typeof scoped.turn === "number" || typeof scoped.from === "number" ? `${action}-turn` : scoped.callId ? action : `${action}-all`;
					const targets = id ? [id] : scoped.callId && typeof scoped.turn !== "number" ? (data?.records ?? []).filter((r) => r.state === "open").map((r) => r.id) : [undefined];
					const replies = [];
					for (const target of action === "revert" ? targets.slice().reverse() : targets) {
						if (ticket !== generation.current) return;
						replies.push(await call(endpoint, { sessionId, turn: scoped.turn, ...(typeof scoped.from === "number" ? { from: scoped.from, to: scoped.to } : {}), ...(target ? { id: target } : {}) }));
					}
					if (ticket !== generation.current) return;
					const errors = replies.map(actionError).filter(Boolean);
					setNotice(errors.length ? { key, text: errors.join("; ") } : null);
					notify();
				} catch (error) { if (ticket === generation.current) setNotice({ key, text: String(error.message ?? error) }); }
				finally { if (ticket === generation.current) setBusy(false); }
			}
			// Copilot folds the file index as soon as a file is chosen, so the diff
			// gets the whole pane instead of an index that always eats the top.
			const choose = (path) => { setSelection({ key, path }); setHunkIndex(0); setCopied(null); setListOpen(false); };
			const stepFile = (delta) => {
				if (groups.length === 0) return;
				const current = Math.max(0, groups.findIndex((group) => group.path === selected.path));
				const next = Math.max(0, Math.min(groups.length - 1, current + delta));
				choose(groups[next].path);
			};
			const label = typeof scoped.turn === "number" ? (zh ? `第 ${scoped.turn} 轮` : `Turn ${scoped.turn}`) : typeof scoped.from === "number" ? (zh ? "所选轮次" : "Selected turn") : scoped.callId ? (zh ? "所选调用" : "Selected call") : (zh ? "全部变更" : "All changes");
			const display = (path) => displayPath(path, data?.root ?? props.cwd, props.home);
			const selectedRecord = selected === undefined
				? undefined
				: [...selected.items].reverse().find((record) => typeof record.before === "string" && typeof record.after === "string") ?? selected.items[selected.items.length - 1];
			const selectedStats = selected === undefined ? { added: 0, removed: 0 } : sumOf(selected.items);
			const hunkCount = Math.max(0, selectedRecord?.hunks?.length ?? 0);
			const parts = selected === undefined ? { dir: "", base: "" } : pathParts(display(selected.path));
			const openRecords = (data?.records ?? []).filter((record) => record.state === "open");
			const fileOpen = (selected?.items ?? []).some((record) => record.state === "open");
			function gotoHunk(next) {
				if (hunkCount === 0) return;
				const target = Math.max(0, Math.min(hunkCount - 1, next));
				setHunkIndex(target);
				// The body owns its scroll window: when rows are virtualized the
				// target line may not be mounted yet, so it asks the body to scroll
				// first and only then looks for the row.
				if (nav.current !== null && typeof nav.current === "function") {
					nav.current(target);
					return;
				}
				const node = editor.current;
				if (node !== null && typeof node.querySelector === "function") {
					const line = node.querySelector(`[data-hunk="${target}"]`);
					if (line !== null && typeof line.scrollIntoView === "function") line.scrollIntoView({ block: "center" });
				}
			}
			function toggleReviewed(path) {
				const mark = !reviewed.includes(path);
				setReviewed((value) => (mark ? [...value, path] : value.filter((item) => item !== path)));
				if (!mark) return;
				// Copilot walks to the next file once the current one is reviewed,
				// so a review pass never needs a second click on the list.
				const paths = groups.map((group) => group.path);
				const start = paths.indexOf(path);
				const next = [...paths.slice(start + 1), ...paths.slice(0, start)].find((item) => item !== path && !reviewed.includes(item));
				if (next !== undefined) choose(next);
			}
			function copyPath() {
				if (selected === undefined) return;
				const text = selected.path;
				try {
					if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) void navigator.clipboard.writeText(text);
				} catch { /* clipboard is a convenience; never fail the pane for it */ }
				setCopied(text);
			}
			const fileAction = (action, record, path) => h("button", {
				key: action,
				type: "button",
				className: `ld-btn ${action === "keep" ? "ld-primary" : "ld-ghost"}`,
				disabled: busy || record.state !== "open",
				"aria-label": `${action === "keep" ? "Keep" : "Undo"} ${path}`,
				onClick: () => mutate(action, record.id)
			}, action === "keep" ? (zh ? "保留" : "Keep") : (zh ? "撤销" : "Undo"));
			return h("div", { className: "ld-pane ld-copilot" },
				h("div", { className: "ld-panehead" },
					h("div", { className: "ld-panetitle" }, h(Icon, { name: "diff" }), h("span", null, zh ? "变更" : "Changes"), data === null ? null : h("span", { className: "ld-count" }, String(groups.length))),
					h("span", { className: "ld-muted ld-scope" }, label),
					reviewed.length === 0 ? null : h("span", { className: "ld-reviewedcount", title: zh ? "已审阅文件" : "Reviewed files" }, `${reviewed.length}/${data === null ? 0 : groups.length}`),
					h("span", { className: "ld-spacer" }),
					scoped.turn !== undefined || scoped.from !== undefined || scoped.callId ? h("button", { className: "ld-btn ld-ghost", onClick: () => openPanel(undefined, sessionId), "aria-label": "Review all changes" }, zh ? "全部变更" : "All changes") : null,
					...(data === null ? [] : ["keep", "revert"].map((action) => h("button", { key: action, type: "button", className: `ld-btn ${action === "keep" ? "ld-primary" : "ld-ghost"}`, disabled: busy || openRecords.length === 0, "aria-label": `${action === "keep" ? "Keep" : "Undo"} ${label}`, onClick: () => mutate(action) }, action === "keep" ? (zh ? "保留" : "Keep") : (zh ? "撤销" : "Undo"))))
				),
				notice?.key === key ? h("div", { className: "ld-notice", role: "alert" }, notice.text) : null,
				data === null
					? h("div", { className: "ld-emptystate", role: "status" }, h("span", { className: "ld-spinner", "aria-hidden": "true" }), typeof sessionId === "string" ? (zh ? "正在载入变更…" : "Loading changes…") : (zh ? "未选择会话" : "No session is selected"))
					: groups.length === 0
						? h("div", { className: "ld-emptystate" },
							h(Icon, { name: "check" }),
							h("strong", null, zh ? "没有待审阅的改动" : "No changes to review"),
							h("span", { className: "ld-muted" }, zh ? "此范围内的文件改动已经保留或撤销。" : "Every change in this scope was kept or undone."))
						: h("div", { className: "ld-changes" },
							h("button", {
								type: "button",
								className: "ld-fileshead",
								"aria-expanded": listOpen,
								title: listOpen ? (zh ? "收起文件列表" : "Collapse the file list") : (zh ? "展开文件列表" : "Expand the file list"),
								onClick: () => setListOpen((value) => !value)
							},
								h("span", { className: "ld-fileschevron", "data-open": listOpen || undefined, "aria-hidden": "true" }, "›"),
								h("span", { className: "ld-fileslabel" }, zh ? "文件" : "Files"),
								h("span", { className: "ld-count" }, String(groups.length)),
								listOpen || selected === undefined ? null : h("span", { className: "ld-filescurrent", title: display(selected.path) }, pathParts(display(selected.path)).base),
								h("span", { className: "ld-spacer" }),
								h("span", { className: "ld-stats", title: zh ? "新增 / 删除行" : "Added / removed lines" }, h("span", { className: "ld-add" }, `+${totals.added}`), h("span", { className: "ld-del" }, `−${totals.removed}`))
							),
							listOpen ? h("div", { className: "ld-flist", role: "listbox", "aria-label": zh ? "已修改的文件" : "Changed files" },
								groups.map((group) => {
									const groupParts = pathParts(display(group.path));
									const groupStats = sumOf(group.items);
									const record = group.items[group.items.length - 1];
									const letter = changeLetter(record);
									const active = group.path === selected.path;
									const isReviewed = reviewed.includes(group.path);
									return h("button", {
										key: group.path,
										type: "button",
										role: "option",
										"aria-selected": active,
										className: `ld-frow${active ? " selected" : ""}${isReviewed ? " reviewed" : ""}`,
										title: group.path,
										onClick: () => choose(group.path),
										onKeyDown: (event) => {
											if (event.key === "ArrowDown") { event.preventDefault(); stepFile(1); }
											else if (event.key === "ArrowUp") { event.preventDefault(); stepFile(-1); }
										}
									},
										h("span", { className: "ld-fname" }, groupParts.base),
										groupParts.dir ? h("span", { className: "ld-fdir" }, groupParts.dir) : null,
										h("span", { className: "ld-spacer" }),
										h("span", { className: "ld-fstats" }, h("span", { className: "ld-add" }, `+${groupStats.added}`), h("span", { className: "ld-del" }, `−${groupStats.removed}`)),
										isReviewed
											? h("span", { className: "ld-fcheck", title: zh ? "已审阅" : "Reviewed" }, h(Icon, { name: "check" }))
											: h("span", { className: `ld-fstate ${letter}`, title: letter === "A" ? (zh ? "新增" : "Added") : letter === "D" ? (zh ? "删除" : "Deleted") : (zh ? "修改" : "Modified") }, letter)
									);
								})
							) : null,
							h("div", { className: "ld-editor" },
								h("div", { className: "ld-editorbar" },
									h("span", { className: "ld-editorpath", title: selected.path }, h("span", { className: "ld-editorfile" }, parts.base), parts.dir ? h("span", { className: "ld-editordir" }, parts.dir) : null),
									h("span", { className: "ld-stats" }, h("span", { className: "ld-add" }, `+${selectedStats.added}`), h("span", { className: "ld-del" }, `−${selectedStats.removed}`)),
									h("span", { className: "ld-spacer" }),
									h("div", { className: "ld-seg", role: "group", "aria-label": zh ? "差异视图" : "Diff view" },
										...["unified", "split"].map((value) => h("button", { key: value, type: "button", className: "ld-segbtn", "aria-pressed": mode === value, onClick: () => setMode(value) }, value === "unified" ? (zh ? "统一" : "Inline") : (zh ? "并排" : "Side by side")))
									),
									h("button", { type: "button", className: "ld-iconbtn", "aria-label": zh ? "在编辑器中打开" : "Open file in editor", title: zh ? "在编辑器中打开" : "Open file in editor", disabled: typeof props.openFile !== "function", onClick: () => { if (typeof props.openFile === "function" && selected !== undefined) props.openFile(selected.path); } }, h(Icon, { name: "file" })),
									h("button", { type: "button", className: "ld-iconbtn", "aria-label": zh ? "复制文件路径" : "Copy file path", title: copied === selected.path ? (zh ? "已复制" : "Copied") : (zh ? "复制文件路径" : "Copy file path"), onClick: copyPath }, copied === selected.path ? h("span", { className: "ld-copied" }, zh ? "已复制" : "Copied") : h(Icon, { name: "copy" }))
								),
								h("div", { key: selected.path, ref: editor, className: "ld-editorbody" },
									h(DiffBody, {
										path: selected.path,
										label: selected.path,
										hunks: selectedRecord?.hunks,
										before: selectedRecord?.before,
										after: selectedRecord?.after,
										added: selectedStats.added,
										removed: selectedStats.removed,
										mode,
										full: true,
										showHeader: false,
										expandAll,
										openFile: props.openFile,
										navRef: nav,
										t: props.t
									})
								),
								h("div", { className: "ld-editorfoot" },
									h("button", { type: "button", className: `ld-reviewed${reviewed.includes(selected.path) ? " on" : ""}`, "aria-pressed": reviewed.includes(selected.path), onClick: () => toggleReviewed(selected.path) }, h(Icon, { name: "check" }), zh ? "标记为已审阅" : "Mark as Reviewed"),
									h("span", { className: "ld-spacer" }),
									h("span", { className: "ld-hunknav", "aria-label": zh ? "差异块导航" : "Hunk navigation" },
										h("span", { className: "ld-hunkcount" }, `${hunkCount === 0 ? 0 : hunkIndex + 1} of ${hunkCount}`),
										h("button", { type: "button", className: "ld-iconbtn", "aria-label": zh ? "上一处改动" : "Previous change", disabled: hunkCount === 0, onClick: () => gotoHunk(hunkIndex - 1) }, h(Icon, { name: "up" })),
										h("button", { type: "button", className: "ld-iconbtn", "aria-label": zh ? "下一处改动" : "Next change", disabled: hunkCount === 0, onClick: () => gotoHunk(hunkIndex + 1) }, h(Icon, { name: "down" }))
								),
									h("button", { type: "button", className: "ld-linkbtn", onClick: () => setExpandAll((value) => !value), title: zh ? "展开或折叠所有未改动区域" : "Expand or collapse every unchanged region" }, expandAll ? (zh ? "折叠未改动" : "Collapse unchanged") : (zh ? "展开未改动" : "Expand unchanged")),
									selectedRecord ? fileAction("keep", (selected.items.find((record) => record.state === "open") ?? selectedRecord), selected.path) : null,
									selectedRecord ? fileAction("revert", (selected.items.find((record) => record.state === "open") ?? selectedRecord), selected.path) : null,
									fileOpen ? null : h("span", { className: "ld-muted" }, zh ? "已处理" : "done")
								)
							)
						)
			);
		}

		/** Scroll a focused group into view when the panel mounts. */
		function scrollIntoView(node) {
			if (node !== null && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
		}

		/**
		 * The docked tab's chip text.
		 * @param props - slot props.
		 * @returns the element.
		 */
		function ReviewPaneTitle(props) {
			const t = makeT(props.t);
			const focus = useFocus();
			return h("span", { className: "ld-panetitle" }, t("panel.title", "Changes"), focus.callId === undefined ? null : h(Icon, { name: "diff" }));
		}
		//#endregion

		//#region turn footer
		/**
		 * "29m 36s" for a turn that took a while, "8s" for a quick one.
		 * @param ms - elapsed milliseconds.
		 * @returns the humanized duration.
		 */
		function formatDuration(ms) {
			const seconds = Math.max(0, Math.round(ms / 1000));
			if (seconds < 60) return `${seconds}s`;
			const minutes = Math.floor(seconds / 60);
			const rest = seconds % 60;
			if (minutes < 60) return `${minutes}m ${rest}s`;
			const hours = Math.floor(minutes / 60);
			return `${hours}h ${minutes % 60}m`;
		}

		/**
		 * "11分59秒" / "11m 59s": how the host words a turn's run time.
		 * @param ms - elapsed milliseconds.
		 * @param zh - whether the UI reads Chinese.
		 * @returns the humanized run time.
		 */
		function formatRun(ms, zh) {
			const total = Math.max(1, Math.round(ms / 1000));
			const hours = Math.floor(total / 3600);
			const minutes = Math.floor((total % 3600) / 60);
			const seconds = total % 60;
			if (zh) {
				if (hours > 0) return `${hours}小时${minutes}分`;
				if (minutes > 0) return `${minutes}分${seconds}秒`;
				return `${seconds}秒`;
			}
			if (hours > 0) return `${hours}h ${minutes}m`;
			if (minutes > 0) return `${minutes}m ${seconds}s`;
			return `${seconds}s`;
		}

		/**
		 * Whether the bound translator speaks Chinese.
		 * @param t - translator.
		 * @returns true for the zh dictionary.
		 */
		function isChinese(t) {
			return typeof t === "function" && t("chinese.marker") === "中文";
		}

		/**
		 * Window this turn covers, in epoch milliseconds. A turn still streaming
		 * has no end event, so it stays open to the right.
		 * @param turn - the turn the slot handed over.
		 * @returns `{ from, to }`.
		 */
		function turnWindow(turn) {
			const from = typeof turn?.start?.time === "number" ? turn.start.time : 0;
			const to = typeof turn?.end?.time === "number" ? turn.end.time : Number.MAX_SAFE_INTEGER;
			return { from, to };
		}

		/**
		 * The turn's own "Completed in 11m 59s" header line, rebuilt so this
		 * turn's `+A −R` can sit on it and open the review panel, exactly like the
		 * Copilot action header. Replaces the host's turn-process node view, so it
		 * reproduces that row's collapse behaviour and accessibility status.
		 * @param props - `{ node, turnProcess, sessionId, t }`.
		 * @returns the element, or null.
		 */
		function CheckpointControl({ sessionId, turn, payload, t }) {
			const zh = isChinese(t);
			const number = turnNumber(turn);
			const key = `${sessionId}:${number}`;
			const [confirmation, setConfirmation] = react.useState(null);
			const [result, setResult] = react.useState(null);
			const [busyKey, setBusy] = react.useState(null);
			const active = react.useRef(key);
			active.current = key;
			const checkpoint = payload?.checkpoints?.find((item) => item.turn === number);
			if (checkpoint === undefined) return null;
			const available = ["available", "limited", "ready"].includes(checkpoint.status) && turn.status === "closed";
			const limitations = (checkpoint.limitations ?? []).map((item) => typeof item === "string" ? item : item.reason ?? JSON.stringify(item)).join("; ");
			async function restore() {
				setBusy(key); setResult(null);
				try {
					const reply = await call("restore-checkpoint", { sessionId, turn: number });
					if (active.current !== key) return;
					const error = actionError(reply);
					setResult({ key, text: error ?? (zh ? `文件已恢复至第 ${number} 轮开始前，对话记录已保留。` : `Files restored to before turn ${number}. Transcript preserved.`), error: !!error });
					if (!error) setConfirmation(null);
					notify();
				} catch (error) { if (active.current === key) setResult({ key, text: String(error.message ?? error), error: true }); }
				finally { if (active.current === key) setBusy(null); }
			}
			const reason = !available
				? zh
					? `不可用（${checkpoint.status}）：此轮没有可恢复的可靠快照`
					: `Unavailable (${checkpoint.status}) — no reliable snapshot for this turn`
				: limitations.length
					? `${zh ? "捕获范围" : "Capture coverage"}: ${limitations}`
					: zh ? `将文件恢复至第 ${number} 轮开始前` : `Restore files to before turn ${number}`;
			return h(
				"div",
				{ className: "ld-checkpoint" },
				h(
					"button",
					{
						type: "button",
						className: "ld-cplink",
						disabled: !available || busyKey === key,
						title: reason,
						"aria-label": `Restore checkpoint before turn ${number ?? "unknown"}`,
						onClick: () => setConfirmation(key)
					},
					h(Icon, { name: "history" }),
					available ? (zh ? "恢复检查点" : "Restore Checkpoint") : zh ? "恢复检查点不可用" : "Restore Checkpoint"
				),
				confirmation === key && available
					? h(
							"div",
							{ className: "ld-confirm" },
							h("p", null, zh ? `将捕获的文件恢复至第 ${number} 轮开始前？此操作也会撤销后续已捕获的文件改动。仅恢复文件，对话记录保持不变。` : `Restore captured files to before turn ${number}? This also reverses subsequent captured changes. Only files are restored; the conversation is preserved.`),
							h("button", { className: "ld-btn", disabled: busyKey === key, onClick: restore }, zh ? "恢复" : "Restore"),
							h("button", { className: "ld-btn", disabled: busyKey === key, onClick: () => setConfirmation(null) }, zh ? "取消" : "Cancel")
						)
					: null,
				result?.key === key ? h("div", { className: result.error ? "ld-notice" : "ld-muted", role: result.error ? "alert" : "status" }, result.text) : null
			);
		}

		function TurnProcessView(props) {
			const t = makeT(props.t);
			const sessionId = props.sessionId;
			if (typeof sessionId === "string") lastSessionId = sessionId;
			const records = useSessionRecords(sessionId);
			const node = props.node;
			const owner = props.turnProcess;
			if (owner === undefined || node === undefined) return null;
			const location = node.location;
			const turn = location?.kind === "turn" || location?.kind === "step" ? location.turn : undefined;
			if (turn === undefined || turn.status !== "closed") return null;

			const reason = turn.end?.data?.reason?.kind;
			const stopped = reason === "aborted" || reason === "interrupted";
			const failed = reason === "error";
			const elapsed =
				typeof turn.start?.time === "number" && typeof turn.end?.time === "number"
					? Math.max(1000, turn.end.time - turn.start.time)
					: undefined;
			const alwaysOpen = stopped || failed;
			const canCollapse = owner.foldable && owner.hasContent && !alwaysOpen;
			const open = !owner.foldable || owner.open;
			const zh = isChinese(t);
			const duration = elapsed === undefined || alwaysOpen ? "" : formatRun(elapsed, zh);
			// The host publishes counts for messages, calls and subagents but not the
			// number of steps the turn spent, so read it off the turn itself: the
			// finished line says how much work went into the answer, like the shipped
			// "Completed 16 steps in 19m 42s" row.
			const steps = Array.isArray(turn.steps) ? turn.steps.length : 0;
			const label = stopped
				? fill(t, "node.stopped", "Stopped", {})
				: failed
					? fill(t, "node.failed", "Failed", {})
					: duration.length === 0
						? fill(t, "node.worked", "Completed", {})
						: steps > 1
							? fill(t, "turn.completed", "Completed {steps} steps in {duration}", { steps, duration })
							: steps === 1
								? fill(t, "turn.completedOne", "Completed 1 step in {duration}", { duration })
								: fill(t, "node.took", "Completed in {duration}", { duration });
			const sums = turnSums(records, turn);
			const toggle = () => {
				if (canCollapse) owner.setOpen(!open);
			};
			const root = typeof records?.root === "string" ? records.root : undefined;

			const head = h(
				"button",
				{
					type: "button",
					className: "ld-processlabel",
					"data-open": open || undefined,
					"data-turn-process": node.data?.turn ?? turnNumber(turn),
					"data-turn-process-messages": node.data?.messageCount,
					"data-turn-process-tool-calls": node.data?.toolCallCount,
					"data-turn-process-subagents": node.data?.subagentCount,
					"aria-expanded": owner.hasContent ? open : undefined,
					disabled: !canCollapse,
					onClick: toggle
				},
				h("span", null, label)
			);

			const badge =
				sums.files === 0
					? null
					: h(
							"button",
							{
								type: "button",
								className: "ld-processbadge",
								title: fill(t, "node.openReview", "Review {files} changed files in the side panel", { files: sums.files }),
								onClick: (event) => {
									event.stopPropagation();
									openPanel(undefined, sessionId, { turn: turnNumber(turn), ...turnWindow(turn) });
								}
							},
							h("span", { className: "ld-add" }, `+${sums.added}`),
							h("span", { className: "ld-del" }, `−${sums.removed}`)
						);

			// The chevron sits after the totals and stays invisible until the line is
			// pointed at, so a finished turn reads as text instead of a control.
			const chevron = canCollapse
				? h(
						"button",
						{
							type: "button",
							className: "ld-processchev",
							tabIndex: -1,
							"aria-hidden": "true",
							onClick: (event) => {
								event.stopPropagation();
								toggle();
							}
						},
						h(
							"svg",
							{ className: "ld-chevron", viewBox: "0 0 16 16", width: 12, height: 12 },
							h("path", { d: "M4 6.5 8 10l4-3.5", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" })
						)
					)
				: null;

			return h(
				"div",
				{ className: "ld-process" },
				h(
					"div",
					{ className: "ld-processhead", "data-open": open || undefined },
					head,
					badge,
					chevron,
					h("span", { className: "ld-spacer" }),
					h(CheckpointControl, { sessionId, turn, payload: records, t })
				),
				h("span", { className: "ld-visuallyhidden", role: "status", "aria-live": "polite", "aria-atomic": "true" }, stopped
					? fill(t, "node.stopped", "Stopped", {})
					: failed
						? fill(t, "node.failed", "Failed", {})
						: fill(t, "node.worked", "Completed", {}))
			);
		}

		/** Files listed in the turn footer before the rest fold behind one button. */
		const TURN_CARD_ROWS = 6;

		/**
		 * The 18px document glyph in the footer card's leading tile.
		 * @returns the svg element.
		 */
		function CardFileGlyph() {
			return h(
				"svg",
				{
					className: "ld-turnglyph",
					viewBox: "0 0 20 20",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.4,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true"
				},
				h("path", { d: "M5.25 2.75h6l3.5 3.5v10a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1V3.75a1 1 0 0 1 1-1Z" }),
				h("path", { d: "M11.25 2.75v3.5h3.5M7 10h5M7 13h5" })
			);
		}

		/**
		 * The 16px sheet-and-check glyph on the footer card's Review button.
		 * @returns the svg element.
		 */
		function CardReviewGlyph() {
			return h(
				"svg",
				{
					className: "ld-turnglyph ld-turnglyph-sm",
					viewBox: "0 0 20 20",
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.4,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true"
				},
				h("path", { d: "M4.5 3.5h8a1 1 0 0 1 1 1v3M6.5 6.5h4M6.5 9.5h2.25" }),
				h("path", { d: "m10.5 13 1.5 1.5 3.5-4" })
			);
		}

		/**
		 * Completion card under a turn: a header with the edited-file count,
		 * totals, Keep/Undo/Review, then one divider-separated row per file.
		 * Renders nothing for a turn that changed no file.
		 * @param props - `{ turn, sessionId, t }`.
		 * @returns the element, or null.
		 */
		function TurnFooter(props) {
			const t = makeT(props.t);
			if (typeof props.sessionId === "string") lastSessionId = props.sessionId;
			const revision = useRevision();
			const data = useSessionRecords(props.sessionId);
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState(null);
			const [expanded, setExpanded] = react.useState(false);
			const sessionId = props.sessionId;
			const { from, to } = turnWindow(props.turn);
			const scopeKey = `${sessionId}:${turnNumber(props.turn) ?? from}`;
			const active = react.useRef(scopeKey);
			active.current = scopeKey;

			if (data === null) return null;
			const rows = (data.records ?? []).filter((record) => inTurn(record, props.turn));
			if (rows.length === 0) return null;

			let added = 0;
			let removed = 0;
			for (const record of rows) {
				added += record.added ?? 0;
				removed += record.removed ?? 0;
			}
			const openCount = rows.filter((record) => record.state === "open").length;

			/**
			 * Apply a turn-scoped action, then refresh from its reply.
			 * @param endpoint - `keep-turn` or `revert-turn`.
			 * @returns nothing.
			 */
			async function act(endpoint) {
				if (busy === scopeKey) return;
				setBusy(scopeKey);
				setNotice(null);
				try {
					const reply = await call(endpoint, { sessionId, from, to, turn: turnNumber(props.turn) });
					if (active.current !== scopeKey) return;
					setNotice({ key: scopeKey, text: actionError(reply) });
					notify();
				} catch (error) {
					if (active.current === scopeKey) setNotice({ key: scopeKey, text: error instanceof Error ? error.message : String(error) });
				} finally {
					if (active.current === scopeKey) setBusy(false);
				}
			}

			const byPath = [];
			for (const record of rows) {
				const found = byPath.find((item) => item.path === record.path);
				if (found === undefined) byPath.push({ path: record.path, added: record.added ?? 0, removed: record.removed ?? 0 });
				else {
					found.added += record.added ?? 0;
					found.removed += record.removed ?? 0;
				}
			}

			// The card lists the first six files and folds the rest behind one
			// button, so a turn that touched forty files still reads at a glance.
			const total = byPath.length;
			const shown = expanded ? byPath : byPath.slice(0, TURN_CARD_ROWS);
			const hidden = total - shown.length;
			const openAll = () => openPanel(undefined, sessionId, { turn: turnNumber(props.turn), from, to });
			const disabled = busy === scopeKey || openCount === 0;
			const reviewTitle = t("turn.reviewTitle", "Review every file this turn changed");
			const titleKey = total === 1 ? "turn.editedOne" : "turn.edited";
			const titleFallback = total === 1 ? "Edited 1 file" : "Edited {count} files";

			return h(
				"section",
				{ className: "ld-turn", "aria-label": reviewTitle },
				h(
					"div",
					{ className: "ld-turnhead" },
					h("span", { className: "ld-turnicon", "aria-hidden": "true" }, h(CardFileGlyph, {})),
					h(
						"div",
						{ className: "ld-turntitle" },
						h(
							"button",
							{
								type: "button",
								className: "ld-turntitlename",
								title: t("turn.filesTitle", "Open this turn's changes"),
								onClick: openAll
							},
							fill(t, titleKey, titleFallback, { count: total })
						),
						h(
							"span",
							{ className: "ld-turnstats", "aria-label": `${added} added, ${removed} removed` },
							h("span", { className: "ld-add" }, `+${added}`),
							h("span", { className: "ld-del" }, `−${removed}`)
						)
					),
					h(
						"div",
						{ className: "ld-turnactions" },
						h(
							"button",
							{
								type: "button",
								className: "ld-turnbtn",
								disabled,
								title: t("turn.keepTitle", "Dismiss these edits without touching the files"),
							onClick: () => void act("keep-turn")
						},
						t("bar.keep", "Keep")
					),
					h(
						"button",
						{
							type: "button",
							className: "ld-turnbtn",
							disabled,
							title: t("turn.undoTitle", "Write back the text every edit in this turn replaced"),
							onClick: () => void act("revert-turn")
						},
						t("bar.undo", "Undo")
					),
					h(
						"button",
						{
							type: "button",
							className: "ld-turnbtn ld-turnbtn-strong",
							title: reviewTitle,
							onClick: openAll
						},
						h(CardReviewGlyph, {}),
						t("turn.review", "Review")
						)
					)
				),
				total > 0
					? h(
							"div",
							{ className: "ld-turnlist" },
							shown.map((item) => {
								const parts = pathParts(displayPath(item.path, data?.root ?? props.cwd, props.home));
								const open = () => openPanel(undefined, sessionId, { turn: turnNumber(props.turn), path: item.path, from, to });
								return h(
									"button",
									{
										key: item.path,
										type: "button",
										className: "ld-turnrow",
										title: item.path,
										"aria-label": fill(t, "turn.rowLabel", "Review the change to {path}", { path: parts.base }),
										onClick: open
									},
									h("span", { className: "ld-turnrowname" }, parts.base),
									h(
										"span",
										{ className: "ld-turnstats" },
										h("span", { className: "ld-add" }, `+${item.added}`),
										h("span", { className: "ld-del" }, `−${item.removed}`)
									)
								);
							}),
							hidden > 0
								? h(
										"button",
										{
											type: "button",
											className: "ld-turnmore",
											onClick: () => setExpanded(true)
										},
										hidden === 1 ? fill(t, "turn.moreOne", "1 more file") : fill(t, "turn.more", "{count} more files", { count: hidden })
									)
								: null
						)
					: null,
				notice?.key === scopeKey && notice.text ? h("div", { className: "ld-notice", role: "alert" }, notice.text) : null
			);
		}
		//#endregion

		//#region session list
		/**
		 * `+A −R` beside a session row, so the list answers "how much did this
		 * session change" without opening it.
		 * @param props - `{ sessionId }` from the row.
		 * @returns the element, or null for a session with no edits.
		 */
		function SessionRowBadge(props) {
			const totals = useSessionTotals(props.sessionId);
			if (totals === null || totals === undefined) return null;
			return h(
				"button",
				{ type: "button", onClick: (event) => { event.stopPropagation(); openPanel(undefined, props.sessionId); }, "aria-label": "Review session changes", className: "ld-sidebadge", title: `${totals.files} files · ${totals.edits} edits` },
				h("span", { className: "ld-add" }, `+${totals.added}`),
				h("span", { className: "ld-del" }, `−${totals.removed}`)
			);
		}

		/**
		 * The row's hover card section: file and edit counts behind the badge.
		 * @param props - `{ sessionId }` from the row.
		 * @returns the element, or null for a session with no edits.
		 */
		function SessionRowHover(props) {
			const t = makeT(props.t);
			const totals = useSessionTotals(props.sessionId);
			if (totals === null || totals === undefined) return null;
			return h(
				"div",
				{ className: "ld-sidehover" },
				h(Icon, { name: "diff" }),
				h(
					"span",
					null,
					fill(t, "bar.files", "{files} files changed", { files: totals.files }),
					h("span", { className: "ld-muted" }, ` · ${totals.edits} ${t("bar.edits", "edits")} · `),
					h("span", { className: "ld-add" }, `+${totals.added}`),
					" ",
					h("span", { className: "ld-del" }, `−${totals.removed}`)
				)
			);
		}
		//#endregion

		//#region styles
		/** Inline stylesheet; injected once and scoped by the `ld-` prefix. */
		const CSS = `
.ld-pane, .ld-diff, .ld-turn, .ld-process, .ld-row {
	--ld-bg: var(--dsw-alias-bg-base, #1f1f1f);
	--ld-chrome: var(--dsw-alias-bg-module-platform, #252526);
	--ld-line: var(--dsw-alias-border-l1, #3c3c3c);
	--ld-line-strong: var(--dsw-alias-border-l2, #4f4f4f);
	--ld-card: var(--dsw-alias-bg-container, var(--ld-chrome));
	--ld-text: var(--dsw-alias-label-primary, #cccccc);
	--ld-muted: var(--dsw-alias-label-tertiary, #9d9d9d);
	--ld-hover: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, .06));
	--ld-accent: var(--dsw-alias-state-business-primary, #4daafc);
	--ld-add: var(--dsh-diff-add-color, #3fb950);
	--ld-del: var(--dsh-diff-del-color, #f85149);
	--ld-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}
.ld-pane button:focus-visible, .ld-pane [role="button"]:focus-visible, .ld-turn button:focus-visible, .ld-process button:focus-visible { outline: 1px solid var(--ld-accent); outline-offset: 1px; }
.ld-pane { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 16px; font-size: 12px; line-height: 1.5; color: var(--ld-text); }
.ld-pane.ld-copilot { height: 100%; min-height: 280px; padding: 0; gap: 0; overflow: hidden; background: var(--ld-bg); }
.ld-pane.empty { padding: 24px 16px; color: var(--ld-muted); }
.ld-panehead { display: flex; align-items: center; gap: 6px; flex: none; height: 34px; padding: 0 10px; border-bottom: 1px solid var(--ld-line); }
.ld-panetitle { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; min-width: 0; }
.ld-panetitle .ld-ico { width: 14px; height: 14px; color: var(--ld-muted); }
.ld-count { font-size: 10px; font-weight: 500; color: var(--ld-muted); background: rgba(128, 128, 128, .16); border-radius: 8px; padding: 0 5px; line-height: 14px; }
.ld-reviewedcount { color: var(--ld-muted); font: 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; }
.ld-scope { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45%; }
.ld-muted { color: var(--ld-muted); font-size: 11px; }
.ld-warn { color: var(--ld-del); font-size: 11px; }
.ld-spacer { flex: 1 1 auto; }
.ld-ico { width: 14px; height: 14px; flex: 0 0 auto; color: var(--ld-muted); }
.ld-add { color: var(--ld-add); font-size: 11px; font-variant-numeric: tabular-nums; }
.ld-del { color: var(--ld-del); font-size: 11px; font-variant-numeric: tabular-nums; }
/* The host tints a file row's totals only while that row is hovered or expanded,
   which leaves a finished turn's numbers grey. Show them all the time; the class
   halves of the hashed host names survive a host rebuild, the prefix does not. */
[class*="diffAdded"] { color: var(--dsw-alias-state-success-primary, #3fb950) !important; }
[class*="diffRemoved"] { color: var(--dsw-alias-state-error-primary, #f85149) !important; }
/* The click delegation opens that row's change in the review panel, so the
   numbers say so: a hand cursor and a hover plate, without moving the glyphs. */
[class*="diffStat"] { cursor: pointer; border-radius: 3px; padding: 1px 3px; margin-left: 7px; }
[class*="diffStat"]:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, .14)); }
.ld-btn { display: inline-flex; align-items: center; gap: 4px; height: 22px; padding: 0 8px; flex: none; white-space: nowrap; border: 1px solid transparent; border-radius: 3px; background: none; color: var(--ld-text); font: inherit; font-size: 11.5px; cursor: pointer; }
.ld-btn:hover:not(:disabled) { background: var(--ld-hover); }
.ld-btn:disabled { opacity: .45; cursor: default; }
.ld-btn.ld-ghost { color: var(--ld-muted); }
.ld-btn.ld-primary { background: rgba(77, 170, 252, .14); color: var(--ld-accent); }
.ld-btn.ld-primary:hover:not(:disabled) { background: rgba(77, 170, 252, .22); }
.ld-notice { margin: 6px 10px; padding: 5px 8px; border-radius: 3px; font-size: 11.5px; color: var(--ld-del); background: rgba(248, 81, 73, .1); }
.ld-emptystate { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: 28px 20px; text-align: center; color: var(--ld-muted); font-size: 11.5px; }
.ld-emptystate .ld-ico { width: 22px; height: 22px; opacity: .7; }
.ld-emptystate strong { font-size: 12px; color: var(--ld-text); font-weight: 600; }
.ld-spinner { width: 12px; height: 12px; border: 2px solid var(--ld-line); border-top-color: var(--ld-accent); border-radius: 50%; animation: ld-spin .8s linear infinite; }
@keyframes ld-spin { to { transform: rotate(360deg); } }
.ld-changes { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.ld-fileshead { display: flex; align-items: center; gap: 6px; flex: none; width: 100%; height: 28px; padding: 0 10px; border: 0; border-bottom: 1px solid var(--ld-line); background: var(--ld-chrome); font: inherit; font-size: 11px; font-weight: 600; letter-spacing: .02em; color: var(--ld-muted); cursor: pointer; text-align: left; }
.ld-fileshead:hover { background: var(--ld-hover); color: var(--ld-text); }
.ld-fileshead .ld-stats { display: inline-flex; gap: 6px; font-weight: 400; }
.ld-fileschevron { display: inline-block; width: 12px; font-size: 13px; line-height: 1; color: var(--ld-muted); transition: transform .12s ease; }
.ld-fileschevron[data-open] { transform: rotate(90deg); }
.ld-fileslabel { color: var(--ld-text); }
.ld-filescurrent { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ld-muted); font-weight: 400; font-family: var(--ld-mono); font-size: 10.5px; }
.ld-flist { flex: 0 1 auto; max-height: 38%; overflow: auto; border-bottom: 1px solid var(--ld-line); background: var(--ld-bg); }
.ld-frow { display: flex; align-items: center; gap: 6px; width: 100%; height: 26px; padding: 0 10px; border: 0; background: none; color: var(--ld-text); font: inherit; font-size: 12px; text-align: left; white-space: nowrap; cursor: pointer; }
.ld-frow:hover { background: var(--ld-hover); }
.ld-frow.selected { background: rgba(77, 170, 252, .12); box-shadow: inset 2px 0 0 var(--ld-accent); }
.ld-frow.reviewed .ld-fname { color: var(--ld-muted); }
.ld-fstate { flex: none; width: 12px; text-align: center; font-size: 10px; font-weight: 700; color: #e2c08d; }
.ld-fstate.A { color: #73c991; }
.ld-fstate.D { color: var(--ld-del); }
.ld-fname { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ld-fdir { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--ld-muted); font-size: 10.5px; }
.ld-fstats { flex: none; display: inline-flex; gap: 4px; }
.ld-fcheck { flex: none; display: inline-flex; color: var(--ld-add); }
.ld-fcheck .ld-ico { width: 12px; height: 12px; color: inherit; }
.ld-editor { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.ld-editorbar { display: flex; align-items: center; gap: 8px; flex: none; height: 32px; padding: 0 10px; border-bottom: 1px solid var(--ld-line); font-size: 12px; min-width: 0; }
.ld-editorpath { display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; font-family: var(--ld-mono); font-size: 11.5px; }
.ld-editorfile { flex: none; color: var(--ld-text); }
.ld-editordir { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ld-muted); font-size: 10.5px; }
.ld-stats { display: inline-flex; gap: 5px; flex: none; }
.ld-seg { display: inline-flex; flex: none; border: 1px solid var(--ld-line); border-radius: 3px; overflow: hidden; }
.ld-segbtn { height: 22px; padding: 0 9px; border: 0; background: none; color: var(--ld-muted); font: inherit; font-size: 11px; cursor: pointer; }
.ld-segbtn:hover { background: var(--ld-hover); color: var(--ld-text); }
.ld-segbtn[aria-pressed="true"] { background: rgba(128, 128, 128, .18); color: var(--ld-text); }
.ld-iconbtn { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 22px; height: 22px; padding: 0; border: 0; border-radius: 3px; background: none; color: var(--ld-muted); cursor: pointer; }
.ld-iconbtn:hover:not(:disabled) { background: var(--ld-hover); color: var(--ld-text); }
.ld-iconbtn:disabled { opacity: .4; cursor: default; }
.ld-copied { font-size: 10px; color: var(--ld-add); }
.ld-editorbody { flex: 1 1 auto; min-height: 0; overflow: hidden; display: flex; flex-direction: column; background: var(--ld-bg); }
.ld-file-fill { flex: 1 1 auto; min-height: 0; height: 100%; display: flex; flex-direction: column; }
.ld-vscroll { flex: 1 1 auto; min-height: 0; overflow: auto; }
.ld-split.ld-vscroll { display: grid; align-content: start; }
.ld-vpad { flex: none; width: 100%; }
.ld-split .ld-vpad { grid-column: 1 / -1; }
.ld-editorfoot { display: flex; align-items: center; gap: 6px; flex: none; height: 32px; padding: 0 8px; border-top: 1px solid var(--ld-line); background: var(--ld-chrome); }
.ld-reviewed { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 4px; border: 0; border-radius: 3px; background: none; color: var(--ld-muted); font: inherit; font-size: 11px; cursor: pointer; }
.ld-reviewed .ld-ico { width: 12px; height: 12px; color: var(--ld-muted); opacity: .45; }
.ld-reviewed:hover { background: var(--ld-hover); color: var(--ld-text); }
.ld-reviewed.on { color: var(--ld-text); }
.ld-reviewed.on .ld-ico { color: var(--ld-add); opacity: 1; }
.ld-hunknav { display: inline-flex; align-items: center; gap: 1px; font-size: 11px; color: var(--ld-muted); }
.ld-hunkcount { font-variant-numeric: tabular-nums; margin-right: 2px; white-space: nowrap; }
.ld-linkbtn { border: 0; background: none; color: var(--ld-accent); font: inherit; font-size: 11px; padding: 2px 4px; border-radius: 3px; cursor: pointer; white-space: nowrap; }
.ld-linkbtn:hover { background: var(--ld-hover); }
.ld-diff { margin: 4px 0 4px 22px; border: 1px solid var(--ld-line); border-radius: 4px; overflow: hidden; background: var(--ld-bg); }
.ld-file { min-width: 0; }
.ld-file + .ld-file { border-top: 1px solid var(--ld-line); }
.ld-filehead { display: flex; align-items: center; gap: 6px; padding: 3px 8px; background: var(--ld-chrome); border-bottom: 1px solid var(--ld-line); font-size: 11.5px; }
.ld-filehead .ld-path { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ld-filehint { margin-left: auto; font-size: 10px; color: var(--ld-muted); }
.ld-path { font-family: var(--ld-mono); font-size: 11.5px; color: var(--ld-text); background: none; border: 0; padding: 0; cursor: pointer; }
.ld-path:hover { text-decoration: underline; }
.ld-path:disabled { cursor: default; text-decoration: none; }
.ld-pathstatic { font-family: var(--ld-mono); font-size: 11.5px; color: var(--ld-text); }
.ld-difflines { overflow-x: auto; font-family: var(--ld-mono); font-size: 12px; line-height: 22px; }
.ld-line { display: flex; align-items: flex-start; width: max-content; min-width: 100%; height: 22px; line-height: 22px; }
.ld-ln { flex: 0 0 auto; width: 40px; padding-right: 6px; text-align: right; color: #6e7681; font-variant-numeric: tabular-nums; user-select: none; }
.ld-sign { flex: 0 0 auto; width: 16px; text-align: center; color: #8b949e; user-select: none; }
.ld-text { flex: 1 1 auto; white-space: pre; padding-right: 12px; padding-left: 8px; color: var(--ld-text); }
.ld-dline.add { background: rgba(46, 160, 67, .15); box-shadow: inset 3px 0 0 rgba(46, 160, 67, .85); }
.ld-dline.add .ld-sign { color: var(--ld-add); }
.ld-dline.del { background: rgba(248, 81, 73, .13); box-shadow: inset 3px 0 0 rgba(248, 81, 73, .85); }
.ld-dline.del .ld-sign { color: var(--ld-del); }
.ld-dline:hover { filter: brightness(1.12); }
.ld-hunk { height: 22px; line-height: 22px; background: rgba(110, 118, 129, .12); color: #8b949e; }
.ld-hunk .ld-text { padding-left: 10px; font-size: 11px; }
.ld-hunkhead { border-top: 1px solid rgba(110, 118, 129, .18); }
.ld-gap { display: block; width: 100%; height: 22px; line-height: 22px; padding: 0 10px; border: 0; border-top: 1px solid rgba(110, 118, 129, .16); border-bottom: 1px solid rgba(110, 118, 129, .16); background: rgba(110, 118, 129, .07); color: var(--ld-accent); font-family: var(--ld-mono); font-size: 10.5px; text-align: left; cursor: pointer; }
.ld-gap:hover { background: rgba(110, 118, 129, .16); }
.ld-gap.open { color: var(--ld-muted); }
.ld-more { display: block; width: 100%; height: 22px; padding: 0 10px; border: 0; border-top: 1px solid var(--ld-line); background: none; color: var(--ld-accent); font: inherit; font-size: 10.5px; text-align: left; cursor: pointer; }
.ld-more:hover { background: var(--ld-hover); }
.ld-diffempty { padding: 8px 10px; color: var(--ld-muted); font-size: 11px; }
.ld-split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); font-family: var(--ld-mono); font-size: 12px; line-height: 22px; }
.ld-srow { display: contents; }
.ld-scell { display: flex; min-width: 0; height: 22px; line-height: 22px; }
.ld-scell.right { border-left: 1px solid var(--ld-line); }
.ld-scell.empty { background: rgba(110, 118, 129, .05); }
.ld-scell .ld-text { white-space: pre; }
.ld-scell.add { background: rgba(46, 160, 67, .15); box-shadow: inset 3px 0 0 rgba(46, 160, 67, .85); }
.ld-scell.del { background: rgba(248, 81, 73, .13); box-shadow: inset 3px 0 0 rgba(248, 81, 73, .85); }
.ld-sheader { grid-column: 1 / -1; height: 22px; line-height: 22px; padding-left: 10px; background: rgba(110, 118, 129, .12); color: #8b949e; font-family: var(--ld-mono); font-size: 11px; }
.ld-sgap { grid-column: 1 / -1; }
.ld-checkpoint { display: inline-flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.ld-cplink { display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 5px; border: 0; border-radius: 3px; background: none; color: var(--ld-muted); font: inherit; font-size: 11px; cursor: pointer; }
.ld-cplink:hover:not(:disabled) { background: var(--ld-hover); color: var(--ld-text); }
.ld-cplink:disabled { opacity: .5; cursor: default; }
.ld-cplink .ld-ico { width: 12px; height: 12px; }
.ld-confirm { flex: 1 0 100%; width: 100%; margin: 2px 0; padding: 8px 10px; border: 1px solid var(--ld-line); border-radius: 4px; background: var(--ld-chrome); font-size: 11.5px; color: var(--ld-text); }
.ld-confirm p { margin: 0 0 8px; line-height: 1.5; }
.ld-confirm .ld-btn { border-color: var(--ld-line); }
.ld-primary { background: var(--ld-accent) !important; color: #fff !important; }
.ld-process { display: flex; flex-direction: column; gap: 0; }
.ld-processhead { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-height: 24px; }
.ld-processlabel { display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: 12px; color: var(--ld-muted); background: transparent; border: 0; padding: 0; cursor: pointer; }
.ld-processlabel:disabled { cursor: default; }
.ld-processlabel:hover:not(:disabled) { color: var(--ld-text); }
.ld-processchev { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 14px; height: 14px; padding: 0; border: 0; border-radius: 3px; background: transparent; color: var(--ld-muted); cursor: pointer; opacity: 0; transition: opacity .12s ease; }
.ld-processhead:hover .ld-processchev, .ld-processhead:focus-within .ld-processchev { opacity: 1; }
.ld-processchev:hover { color: var(--ld-text); }
.ld-processchev .ld-chevron { display: block; }
.ld-chevron { transition: transform .15s ease; transform: rotate(-90deg); flex: none; }
.ld-processhead[data-open="true"] .ld-chevron { transform: none; }
.ld-processbadge { display: inline-flex; align-items: center; gap: 5px; font: inherit; font-size: 11px; background: transparent; border: 0; border-radius: 3px; padding: 1px 4px; cursor: pointer; font-variant-numeric: tabular-nums; }
.ld-processbadge:hover { background: var(--ld-hover); }
.ld-turnrows { display: flex; flex-direction: column; gap: 0; padding: 2px 0 0 16px; }
.ld-tedit { min-width: 0; }
.ld-trow { display: flex; align-items: center; gap: 6px; min-height: 24px; padding: 1px 4px; border-radius: 3px; font-size: 12px; color: var(--ld-text); cursor: pointer; }
.ld-trow:hover { background: var(--ld-hover); }
.ld-trowchev { display: inline-flex; flex: none; color: var(--ld-muted); transform: rotate(0deg); transition: transform .12s ease; }
.ld-trowchev[data-open] { transform: rotate(90deg); }
.ld-trowverb { flex: none; color: var(--ld-muted); font-size: 11.5px; }
.ld-trowpath { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 0; background: none; padding: 0; color: var(--ld-text); font: inherit; font-family: var(--ld-mono); font-size: 11.5px; cursor: pointer; }
.ld-trowpath:hover { text-decoration: underline; }
.ld-trowstat { display: inline-flex; gap: 4px; flex: none; }
.ld-trowopen { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 3px; background: none; color: var(--ld-muted); cursor: pointer; opacity: 0; }
.ld-trow:hover .ld-trowopen, .ld-trowopen:focus-visible { opacity: 1; }
.ld-trowopen:hover { background: var(--ld-hover); color: var(--ld-text); }
.ld-trowopen .ld-ico { width: 13px; height: 13px; }
.ld-inline { margin: 2px 0 6px 20px; border: 1px solid var(--ld-line); border-radius: 4px; overflow: hidden; background: var(--ld-bg); }
.ld-inline .ld-diff { margin: 0; border: 0; border-radius: 0; }
.ld-inline-note { padding: 4px 8px; font-size: 10.5px; color: var(--ld-muted); background: var(--ld-chrome); border-bottom: 1px solid var(--ld-line); }
.ld-turn { display: flex; flex-direction: column; margin: 14px 0 2px; border: 1px solid var(--ld-line-strong); border-radius: 12px; background: var(--ld-card); color: var(--ld-text); font-size: 13px; overflow: hidden; }
.ld-turnhead { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; min-height: 56px; padding: 10px 12px; }
.ld-turnicon { display: grid; place-items: center; flex: none; width: 30px; height: 30px; border-radius: 8px; background: var(--ld-hover); color: var(--ld-muted); }
.ld-turnglyph { width: 18px; height: 18px; }
.ld-turnglyph-sm { width: 16px; height: 16px; }
.ld-turntitle { display: flex; flex: 1 1 auto; align-items: baseline; gap: 10px; min-width: 0; }
.ld-turntitlename { min-width: 0; max-width: 100%; padding: 0; border: 0; background: none; color: inherit; font: inherit; font-size: 13px; font-weight: 600; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.ld-turntitlename:hover { color: var(--ld-accent); }
.ld-turnstats { display: inline-flex; flex: none; gap: 5px; font-variant-numeric: tabular-nums; }
.ld-turnstats .ld-add, .ld-turnstats .ld-del { font-size: 12px; }
.ld-turnactions { display: flex; flex: none; align-items: center; gap: 4px; margin-left: auto; }
.ld-turnbtn { display: inline-flex; flex: none; align-items: center; gap: 5px; min-height: 30px; padding: 0 8px; border: 1px solid transparent; border-radius: 8px; background: none; color: var(--ld-text); font: inherit; font-size: 12.5px; white-space: nowrap; cursor: pointer; }
.ld-turnbtn:hover:not(:disabled) { background: var(--ld-hover); }
.ld-turnbtn:disabled { opacity: .45; cursor: default; }
.ld-turnbtn-strong { border-color: var(--ld-line-strong); background: var(--ld-card); }
.ld-turnlist { border-top: 1px solid var(--ld-line); }
.ld-turnrow { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 38px; margin: 0; padding: 0 12px; border: 0; border-bottom: 1px solid var(--ld-line); background: none; color: var(--ld-text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.ld-turnrow:hover { background: var(--ld-hover); }
.ld-turnrow:last-child { border-bottom: 0; }
.ld-turnrowname { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ld-turnmore { display: block; width: 100%; min-height: 34px; margin: 0; padding: 0 12px; border: 0; background: none; color: var(--ld-muted); font: inherit; font-size: 12px; line-height: 34px; text-align: left; cursor: pointer; }
.ld-turnmore:hover { background: var(--ld-hover); color: var(--ld-text); }
.ld-badge { display: inline-flex; align-items: center; gap: 5px; padding: 0 2px; border: 0; background: none; font-variant-numeric: tabular-nums; cursor: pointer; }
.ld-badge:hover .ld-add, .ld-badge:hover .ld-del { text-decoration: underline; }
.ld-row { display: flex; flex-direction: column; gap: 4px; padding: 2px 0; }
.ld-head { display: flex; align-items: center; gap: 6px; min-height: 22px; font-size: 12px; color: var(--ld-text); flex-wrap: wrap; }
.ld-verb { color: var(--ld-muted); }
.ld-pending { color: var(--ld-muted); }
.ld-sidebadge { border: 0; background: transparent; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; order: -1; opacity: .9; }
.ld-sidehover { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 12px; color: var(--ld-muted); }
.ld-sidehover .ld-ico { width: 13px; height: 13px; }
.ld-visuallyhidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;

		/** Inject the stylesheet unless an earlier mount already did. */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			const id = "dsh-copilot-diff/copilot-diff.css";
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-copilot-diff";
			tag.dataset.pluginCss = id;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region dictionaries
		const zh = {
			"verb.edited": "已编辑",
			"verb.wrote": "写入",
			"verb.created": "新建",
			"verb.deleted": "删除",
			"verb.replaced": "替换",
			"verb.changed": "修改",
			"verb.editing": "编辑中",
			"verb.editedN": "已编辑 {count} 个文件",
			"row.undo": "撤销",
			"row.undoTitle": "把这次编辑替换掉的文本写回",
			"row.reverted": "已撤销",
			"row.kept": "已保留",
			"row.file": "文件",
			"undo.failed": "撤销失败",
			"bar.files": "{files} 个文件已修改",
			"bar.edits": "次编辑",
			"bar.review": "查看",
			"bar.hide": "收起",
				"node.took": "已完成，用时 {duration}",
			"node.worked": "已完成",
			"node.stopped": "已停止",
			"node.failed": "处理失败",
			"node.openReview": "在侧边栏查看 {files} 个文件的改动",
			"node.openFile": "在侧边栏查看 {path} 的改动",
			"turn.filesTitle": "展开这一轮改过的文件",
			"turn.edited": "已编辑 {count} 个文件",
			"turn.editedOne": "已编辑 1 个文件",
			"turn.more": "另有 {count} 个文件",
			"turn.moreOne": "另有 1 个文件",
			"turn.review": "审查",
			"turn.reviewTitle": "审查这一轮改过的每一个文件",
			"turn.rowLabel": "在侧边栏查看 {path} 的改动",
			"chinese.marker": "中文",
			"bar.keep": "保留",
			"bar.kept": "已保留",
			"bar.undoAll": "全部撤销",
			"bar.undo": "撤销",
			"bar.failed": "操作未成功",
			"row.expand": "展开这次 diff",
			"row.collapse": "收起这次 diff",
			"row.reviewTitle": "在审阅面板中打开这次修改",
			"panel.title": "变更",
			"panel.empty": "这个会话还没有文件变更",
			"panel.loading": "正在载入变更…",
			"panel.noSession": "未选中会话",
			"turn.completed": "已完成 {steps} 步，用时 {duration}",
			"turn.completedOne": "已完成 1 步，用时 {duration}",
			"turn.completedNoSteps": "已完成 · 用时 {duration}",
			"turn.files": "{files} 个文件已修改",
			"turn.keepTitle": "保留这些改动，只是不再追踪",
			"turn.undoTitle": "把这一轮每一处改动都改回去",
			"turn.failed": "操作失败",
			"diff.unchanged": "行未改动",
			"diff.gapTitle": "展开或收起这些未改动行",
			"diff.collapseGap": "收起 {count} 行未改动",
			"diff.noFull": "这次历史编辑没有记录完整文件文本",
			"diff.hunksOnly": "仅差异块",
			"diff.empty": "没有记录文本差异",
			"diff.showMore": "显示",
			"diff.moreLines": "行",
			"diff.collapse": "收起"
		};
		const en = {
			"verb.edited": "Edited",
			"verb.wrote": "Wrote",
			"verb.created": "Created",
			"verb.deleted": "Deleted",
			"verb.replaced": "Replaced",
			"verb.changed": "Changed",
			"verb.editing": "Editing",
			"verb.editedN": "Edited {count} files",
			"row.undo": "Undo",
			"row.undoTitle": "Write back the text this edit replaced",
			"row.reverted": "Undone",
			"row.kept": "Kept",
			"row.file": "file",
			"undo.failed": "Undo failed",
			"bar.files": "{files} files changed",
			"bar.edits": "edits",
			"bar.review": "Review",
			"bar.hide": "Hide",
				"node.took": "Completed in {duration}",
			"node.worked": "Completed",
			"node.stopped": "Stopped",
			"node.failed": "Failed",
			"node.openReview": "Review {files} changed files in the side panel",
			"node.openFile": "Review the change to {path} in the side panel",
			"turn.filesTitle": "Show the files this turn changed",
			"turn.edited": "Edited {count} files",
			"turn.editedOne": "Edited 1 file",
			"turn.more": "{count} more files",
			"turn.moreOne": "1 more file",
			"turn.review": "Review",
			"turn.reviewTitle": "Review every file this turn changed",
			"turn.rowLabel": "Review the change to {path}",
			"chinese.marker": "en",
			"bar.keep": "Keep",
			"bar.kept": "Kept",
			"bar.undoAll": "Undo all",
			"bar.undo": "Undo",
			"bar.failed": "That did not work",
			"row.expand": "Show this diff",
			"row.collapse": "Hide this diff",
			"row.reviewTitle": "Open this change in the review panel",
			"panel.title": "Changes",
			"panel.empty": "No file changes in this session yet",
			"panel.loading": "Loading changes…",
			"panel.noSession": "No session is selected",
			"turn.completed": "Completed {steps} steps in {duration}",
			"turn.completedOne": "Completed 1 step in {duration}",
			"turn.completedNoSteps": "Completed in {duration}",
			"turn.files": "{files} files changed",
			"turn.keepTitle": "Keep these edits and stop tracking them",
			"turn.undoTitle": "Write back the text every edit in this turn replaced",
			"turn.failed": "That did not work",
			"diff.unchanged": "unchanged lines",
			"diff.gapTitle": "Show or hide these unchanged lines",
			"diff.collapseGap": "Collapse {count} unchanged lines",
			"diff.noFull": "Full file text is unavailable for this historical edit",
			"diff.hunksOnly": "hunks only",
			"diff.empty": "No textual diff was recorded",
			"diff.showMore": "Show",
			"diff.moreLines": "more lines",
			"diff.collapse": "Collapse"
		};
		//#endregion

		/** Client services this bundle needs. */
		exports.inject = ["slots", "locale", "connection", "sidebarRight", "sidebarRightTabs"];

		/**
		 * Register the row views, the turn-tail bar, the docked review panel, the
		 * session-list badges, dictionaries and styles.
		 * @param ctx - client plugin context.
		 */
		exports.apply = async function apply(ctx) {
			bridge = ctx.get("connection");
			try {
				sidebarRight = ctx.get("sidebarRight");
				sidebarRightTabs = ctx.get("sidebarRightTabs");
				try { uiWorkspace = ctx.get("uiWorkspace"); } catch {}
			} catch {
				// A host without a right sidebar keeps the inline row and the bar.
			}
			ctx.effect(() => {
				const mounted = sidebarRight?.mounted;
				if (!mounted?.subscribe) return;
				return mounted.subscribe(() => {
					const sessionId = mounted.getSnapshot();
					focusState = { sessionId, revision: focusState.revision + 1 };
					for (const listener of Array.from(focusListeners)) listener(focusState);
				});
			}, "copilot-diff: session scope");
			ensureStyles();
			installHostRowClicks();
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "copilot-diff: dictionaries");

			for (const key of [
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
			]) {
				ctx.slots.inject("tool.call.toolview", () =>
					ctx.slots.register(
						{
							name: "tool.call.toolview",
							key,
							locale: NS,
							inject: (sessionId) => ({ liveDiffSessionId: sessionId })
						},
						LiveDiffRow
					)
				);
			}

			if (typeof sidebarRightTabs?.register === "function") {
				ctx.effect(
					() =>
						sidebarRightTabs.register({
							id: PANEL_ID,
							kind: PANEL_KIND,
							title: () => ctx.locale.bind(NS)("panel.title")
						}),
					"copilot-diff: review tab type"
				);
				ctx.slots.inject("sidebar.right.pane.tab", () =>
					ctx.slots.register(
						{
							name: "sidebar.right.pane.tab",
							key: PANEL_ID,
							locale: NS,
							inject: (sessionId) => ({ sessionId })
						},
						ReviewPane
					)
				);
				ctx.slots.inject("sidebar.right.pane.tab.title", () =>
					ctx.slots.register(
						{ name: "sidebar.right.pane.tab.title", key: PANEL_ID, locale: NS, inject: (sessionId) => ({ sessionId }) },
						ReviewPaneTitle
					)
				);
			}

			// The host's own "Completed in 11m 59s" row becomes ours, so this turn's
			// totals sit on that line instead of a separate row below it.
			ctx.slots.inject("conversation.chat.node", () =>
				ctx.slots.register(
					{
						name: "conversation.chat.node",
						key: "turn-process",
						locale: NS,
						inject: (sessionId) => ({ sessionId })
					},
					TurnProcessView
				)
			);

			ctx.slots.inject("conversation.chat.turnTail", () =>
				ctx.slots.register(
					{ name: "conversation.chat.turnTail", id: "dsh-copilot-diff", order: -1, locale: NS, inject: (sessionId) => ({ sessionId }) },
					TurnFooter
				)
			);

			const seats = [
				["sidebar.workspaces.session.row.action", SessionRowBadge],
				["sidebar.session.row.hover", SessionRowHover]
			];
			for (const [name, Component] of seats) {
				try {
					ctx.slots.inject(name, () =>
						ctx.slots.register({ name, id: "dsh-copilot-diff", order: 20, locale: NS }, Component)
					);
				} catch {
					// A host without this seat simply has no badge there.
				}
			}
		};

		return module.exports;
	}
});
