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
			focusState = { callId, sessionId, ...scope, revision: focusState.revision + 1 };
			for (const listener of Array.from(focusListeners)) listener(focusState);
			try {
				if (typeof sidebarRight?.openTab !== "function") return false;
				sidebarRight.openTab(PANEL_KIND, { revealIfOpened: true });
				return true;
			} catch {
				return false;
			}
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
			for (const hunk of Array.isArray(hunks) ? hunks : []) {
				out.push({
					kind: "header",
					text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
				});
				for (const row of hunkRows(hunk)) out.push({ kind: "line", row });
			}
			return out;
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
				diff: "M12 3v18M5 8h5M5 16h5M15 8h5M15 16h5"
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
			const { label, hunks, added, removed, path, openFile } = props;
			const [expanded, setExpanded] = react.useState(false);
			const rows = flattenHunks(hunks);
			const shown = props.full || expanded ? rows : rows.slice(0, PREVIEW_ROWS);
			const hidden = rows.length - shown.length;
			return h("div", { className: "ld-file" }, [
				h(
					"div",
					{ className: "ld-filehead", key: "head" },
					h(
						"button",
						{
							className: "ld-path",
							type: "button",
							title: path,
							onClick: () => {
								if (typeof openFile === "function" && typeof path === "string") openFile(path);
							}
						},
						baseName(label)
					),
					h("span", { className: "ld-add" }, `+${added}`),
					h("span", { className: "ld-del" }, `−${removed}`)
				),
				h(
					"div",
					{ className: "ld-difflines", key: "lines" },
					shown.map((item, index) => {
						if (item.kind === "header") {
							return h("div", { className: "ld-line ld-hunk", key: `h${index}` }, h("span", { className: "ld-text" }, item.text));
						}
						const row = item.row;
						const cls = row.t === "+" ? "ld-line add" : row.t === "-" ? "ld-line del" : "ld-line";
						return h(
							"div",
							{ className: cls, key: `r${index}` },
							h("span", { className: "ld-ln" }, row.old === null || row.old === undefined ? "" : String(row.old)),
							h("span", { className: "ld-ln" }, row.new === null || row.new === undefined ? "" : String(row.new)),
							h("span", { className: "ld-sign" }, row.t === " " ? "" : row.t),
							h("span", { className: "ld-text" }, row.s)
						);
					})
				),
				hidden > 0
					? h(
							"button",
							{ className: "ld-more", type: "button", key: "more", onClick: () => setExpanded(true) },
							`Show ${hidden} more lines`
						)
					: expanded && rows.length > PREVIEW_ROWS
						? h(
								"button",
								{ className: "ld-more", type: "button", key: "less", onClick: () => setExpanded(false) },
								"Collapse"
							)
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
				groups.map((group) =>
					h(DiffBody, {
						key: group.path,
						label: group.path,
						path: group.path,
						hunks: group.items.flatMap((item) => item.hunks ?? []),
						added: sumOf(group.items).added,
						removed: sumOf(group.items).removed,
						openFile,
						cwd,
						home
					})
				)
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
			for (const hunk of hunks ?? []) {
				result.push({ header: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` });
				const rows = hunkRows(hunk);
				for (let i = 0; i < rows.length;) {
					if (rows[i].t === " ") { result.push({ left: rows[i], right: rows[i] }); i++; continue; }
					const left = [], right = [];
					while (i < rows.length && rows[i].t !== " ") {
						(rows[i].t === "-" ? left : right).push(rows[i++]);
					}
					for (let j = 0; j < Math.max(left.length, right.length); j++) result.push({ left: left[j], right: right[j] });
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
			const key = `${sessionId}:${scoped.turn ?? scoped.from ?? "all"}:${scoped.callId ?? ""}:${focus.revision}`;
			const [snapshot, setSnapshot] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState(null);
			const [mode, setMode] = react.useState("unified");
			const [selection, setSelection] = react.useState(null);
			const generation = react.useRef(0);
			const fetchGeneration = react.useRef(0);
			react.useEffect(() => {
				generation.current++;
				setBusy(false);
				return () => { generation.current++; };
			}, [key]);
			react.useEffect(() => {
				let alive = true;
				const ticket = ++fetchGeneration.current;
				setSnapshot((value) => value?.key === key ? value : null); setNotice((value) => value?.key === key ? value : null); setSelection((value) => value?.key === key ? value : null);
				async function load() {
					try {
						const endpoint = typeof scoped.turn === "number" ? "review-turn" : scoped.callId ? "detail" : "list";
						const reply = await call(endpoint, { sessionId, turn: scoped.turn, callId: scoped.callId });
						const error = actionError(reply);
						if (error) throw new Error(error);
						let data = reply.value;
						if (typeof scoped.from === "number") data = { ...data, records: (data.records ?? []).filter((record) => record.time >= scoped.from && record.time <= scoped.to) };
						// list deliberately omits bodies. Hydrate each call before rendering a diff.
						if (endpoint === "list") {
							const calls = [...new Set((data.records ?? []).map((record) => record.callId))];
							const details = await Promise.all(calls.map(async (callId) => {
								const detail = await call("detail", { sessionId, callId });
								if (actionError(detail)) throw new Error(actionError(detail));
								return detail.value.records ?? [];
							}));
							data = { ...data, records: details.flat() };
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
			const choose = (path) => setSelection({ key, path });
			const label = typeof scoped.turn === "number" ? (zh ? `第 ${scoped.turn} 轮` : `Turn ${scoped.turn}`) : typeof scoped.from === "number" ? (zh ? "所选轮次" : "Selected turn") : scoped.callId ? (zh ? "所选调用" : "Selected call") : (zh ? "全部变更" : "All changes");
			return h("div", { className: "ld-pane" },
				h("div", { className: "ld-panebar" }, h("strong", null, zh ? "变更" : "Changes"), h("span", { className: "ld-muted" }, label), scoped.turn !== undefined || scoped.from !== undefined || scoped.callId ? h("button", { className: "ld-btn", onClick: () => openPanel(undefined, sessionId), "aria-label": "Review all changes" }, zh ? "全部变更" : "All changes") : null),
				notice?.key === key ? h("div", { className: "ld-notice", role: "alert" }, notice.text) : null,
				data === null ? h("div", { role: "status" }, typeof sessionId === "string" ? "Loading changes…" : "No session is selected") : h("div", { className: "ld-panebar" },
					h("span", null, (zh ? `${groups.length} 个文件已修改` : `${groups.length} files changed`)), h("span", { className: "ld-add" }, `+${totals.added}`), h("span", { className: "ld-del" }, `−${totals.removed}`), h("span", { className: "ld-spacer" }),
					...["keep", "revert"].map((action) => h("button", { key: action, className: `ld-btn ${action === "keep" ? "ld-primary" : ""}`, disabled: busy || !(data.records ?? []).some((r) => r.state === "open"), "aria-label": `${action === "keep" ? "Keep" : "Undo"} ${label}`, onClick: () => mutate(action) }, action === "keep" ? (zh ? "保留" : "Keep") : (zh ? "撤销" : "Undo")))),
				data && !selected ? h("div", null, "No file changes in this scope") : null,
				selected ? h("div", { className: "ld-review" },
					h("div", { className: "ld-panebar" }, ...["unified", "split"].map((value) => h("button", { key: value, className: "ld-btn", "aria-pressed": mode === value, onClick: () => setMode(value) }, value === "unified" ? (zh ? "统一视图" : "Unified") : (zh ? "并排视图" : "Side by side"))),
						h("button", { className: "ld-btn", disabled: index === 0, "aria-label": "Previous file", onClick: () => choose(groups[index - 1].path) }, zh ? "上一个" : "Previous"), h("span", null, `${index + 1}/${groups.length}`),
						h("button", { className: "ld-btn", disabled: index === groups.length - 1, "aria-label": "Next file", onClick: () => choose(groups[index + 1].path) }, zh ? "下一个" : "Next")),
					h("select", { className: "ld-select", value: selected.path, "aria-label": "Changed file", onChange: (event) => choose(event.target.value) }, groups.map((group) => h("option", { key: group.path, value: group.path }, displayPath(group.path, data.root ?? props.cwd, props.home)))),
					h("div", { key: selected.path, ref: scrollIntoView, className: "ld-review-file" }, selected.items.map((record) => h("div", { key: record.id },
						h("div", { className: "ld-filehead" }, h("span", null, `${record.created ? "A" : record.deleted ? "D" : "M"} ${displayPath(record.path, data.root ?? props.cwd, props.home)}`), h("span", { className: "ld-add" }, `+${record.added}`), h("span", { className: "ld-del" }, `−${record.removed}`), record.state === "open" ? h("button", { className: "ld-btn", disabled: busy, "aria-label": `Undo ${record.path}`, onClick: () => mutate("revert", record.id) }, "Undo") : h("span", { className: "ld-muted" }, record.state)),
						mode === "split" ? h(SideDiff, { hunks: record.hunks }) : h(DiffBody, { label: record.path, path: record.path, hunks: record.hunks, added: record.added, removed: record.removed, full: true, openFile: props.openFile }))))) : null);
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
			const available = checkpoint && ["available", "limited", "ready"].includes(checkpoint.status) && turn.status === "closed";
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
			return h("div", { className: "ld-checkpoint" },
				h("button", { type: "button", className: "ld-btn", disabled: !available || busyKey === key, "aria-label": `Restore checkpoint before turn ${number ?? "unknown"}`, onClick: () => setConfirmation(key) }, h(Icon, { name: "undo" }), "Restore Checkpoint"),
				!available ? h("span", { className: "ld-muted" }, checkpoint ? `${zh ? "不可用" : "Unavailable"} (${checkpoint.status})` : zh ? "不可用：此历史轮次没有可靠快照" : "Unavailable — no reliable snapshot for this historical turn") : null,
				checkpoint?.limitations?.length ? h("details", { className: "ld-coverage ld-muted" }, h("summary", null, zh ? "捕获范围" : "Capture coverage"), h("div", null, checkpoint.limitations.map((item) => typeof item === "string" ? item : item.reason ?? JSON.stringify(item)).join("; "))) : null,
				confirmation === key && available ? h("div", { className: "ld-confirm" }, h("p", null, zh ? `将捕获的文件恢复至第 ${number} 轮开始前？此操作也会撤销后续已捕获的文件改动。仅恢复文件，对话记录保持不变。` : `Restore captured files to before turn ${number}? This also reverses subsequent captured changes. Only files are restored; the conversation is preserved.`), h("button", { className: "ld-btn", disabled: busyKey === key, onClick: restore }, zh ? "恢复" : "Restore"), h("button", { className: "ld-btn", disabled: busyKey === key, onClick: () => setConfirmation(null) }, zh ? "取消" : "Cancel")) : null,
				result?.key === key ? h("div", { className: result.error ? "ld-notice" : "ld-muted", role: result.error ? "alert" : "status" }, result.text) : null);
		}

		function TurnProcessView(props) {
			const t = makeT(props.t);
			const sessionId = props.sessionId;
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
			const label = stopped
				? fill(t, "node.stopped", "Stopped", {})
				: failed
					? fill(t, "node.failed", "Failed", {})
					: duration.length > 0
						? fill(t, "node.took", "Completed in {duration}", { duration })
						: fill(t, "node.worked", "Completed", {});
			const sums = turnSums(records, turn);
			const toggle = () => {
				if (canCollapse) owner.setOpen(!open);
			};
			const root = typeof records?.root === "string" ? records.root : undefined;
			const turnRows = (records?.records ?? []).filter((record) => inTurn(record, turn));
			const rowList =
				!open || turnRows.length === 0
					? null
					: h(
							"div",
							{ className: "ld-turnrows" },
							turnRows.map((record) =>
								h(
									"button",
									{
										key: `${record.callId}\u0000${record.path}`,
										type: "button",
										className: "ld-trow",
										title: fill(t, "node.openFile", "Open {path} in the review panel", { path: record.path }),
										onClick: (event) => {
											event.stopPropagation();
											openPanel(undefined, sessionId, { turn: turnNumber(turn), path: record.path, ...(turnNumber(turn) === undefined ? turnWindow(turn) : {}) });
										}
									},
									h("span", { className: "ld-trowdot" }),
									h("span", { className: "ld-trowverb" }, verbOf(record, t)),
									h("span", { className: "ld-trowpath" }, displayPath(record.path, root, undefined)),
									h("span", { className: "ld-add" }, `+${record.added ?? 0}`),
									h("span", { className: "ld-del" }, `−${record.removed ?? 0}`)
								)
							)
						);

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
				h("span", null, label),
				canCollapse
					? h(
							"svg",
							{ className: "ld-chevron", viewBox: "0 0 16 16", width: 12, height: 12, "aria-hidden": "true" },
							h("path", { d: "M4 6.5 8 10l4-3.5", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" })
						)
					: null
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
									openPanel(undefined, sessionId, { turn: turnNumber(turn), ...(turnNumber(turn) === undefined ? turnWindow(turn) : {}) });
								}
							},
							h("span", { className: "ld-add" }, `+${sums.added}`),
							h("span", { className: "ld-del" }, `−${sums.removed}`)
						);

			return h(
				"div",
				{ className: "ld-process" },
				h(CheckpointControl, { sessionId, turn, payload: records, t }),
				h("div", { className: "ld-processhead" }, head, badge),
				rowList,
				h("span", { className: "ld-visuallyhidden", role: "status", "aria-live": "polite", "aria-atomic": "true" }, stopped
					? fill(t, "node.stopped", "Stopped", {})
					: failed
						? fill(t, "node.failed", "Failed", {})
						: fill(t, "node.worked", "Completed", {}))
			);
		}

		/**
		 * Copilot-style completion footer under a turn: the change count with
		 * Keep and Undo.
		 * Renders nothing for a turn that changed no file.
		 * @param props - `{ turn, sessionId, t }`.
		 * @returns the element, or null.
		 */
		function TurnFooter(props) {
			const t = makeT(props.t);
			const revision = useRevision();
			const data = useSessionRecords(props.sessionId);
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState(null);
			const [expandedFiles, setExpandedFiles] = react.useState(true);
			const sessionId = props.sessionId;
			const { from, to } = turnWindow(props.turn);
			const scopeKey = `${sessionId}:${turnNumber(props.turn) ?? from}`;
			const active = react.useRef(scopeKey);
			active.current = scopeKey;

			if (data === null) return null;
			const rows = (data.records ?? []).filter((record) => inTurn(record, props.turn));
			if (rows.length === 0) return null;

			const paths = new Set(rows.map((record) => record.path));
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

			return h(
				"div",
				{ className: "ld-turn" },
				h(
					"div",
					{ className: "ld-turnbar" },
					h(
						"button",
						{
							type: "button",
							className: "ld-files",
							"aria-expanded": expandedFiles || undefined,
							title: t("turn.filesTitle", "Show the files this turn changed"),
							onClick: () => openPanel(undefined, sessionId, { turn: turnNumber(props.turn), ...(turnNumber(props.turn) === undefined ? { from, to } : {}) })
						},
						h("span", { className: "ld-fileschevron", "data-open": expandedFiles || undefined }, "›"),
						fill(t, "turn.files", "{files} files changed", { files: paths.size })
					),
					h("span", { className: "ld-add" }, `+${added}`),
					h("span", { className: "ld-del" }, `−${removed}`),
					h("span", { className: "ld-spacer" }),
					h(
						"button",
						{
							className: "ld-btn ld-primary",
							type: "button",
							disabled: busy === scopeKey || openCount === 0,
							title: t("turn.keepTitle", "Dismiss these edits without touching the files"),
							onClick: () => void act("keep-turn")
						},
						t("bar.keep", "Keep")
					),
					h(
						"button",
						{
							className: "ld-btn",
							type: "button",
							disabled: busy === scopeKey || openCount === 0,
							title: t("turn.undoTitle", "Write back the text every edit in this turn replaced"),
							onClick: () => void act("revert-turn")
						},
						t("bar.undo", "Undo")
					)
				),
				expandedFiles && byPath.length > 0
					? h(
							"div",
							{ className: "ld-filelist" },
							byPath.map((item) =>
								h(
									"button",
									{
										key: item.path,
										type: "button",
										className: "ld-fileitem",
										title: item.path,
										onClick: () => openPanel(undefined, sessionId, { turn: turnNumber(props.turn), path: item.path, ...(turnNumber(props.turn) === undefined ? { from, to } : {}) })
									},
									h("span", { className: "ld-fileicon", "aria-hidden": true }, rows.find((record) => record.path === item.path)?.created ? "A" : rows.find((record) => record.path === item.path)?.deleted ? "D" : "M"),
									h("span", { className: "ld-filepath" }, displayPath(item.path, data?.root ?? props.cwd, props.home)),
									h("span", { className: "ld-add" }, `+${item.added}`),
									h("span", { className: "ld-del" }, `−${item.removed}`)
								)
							)
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
.ld-pane button:focus-visible, .ld-pane select:focus-visible, .ld-turn button:focus-visible, .ld-process button:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary, #0078d4); outline-offset: 2px; }
.ld-select { width: 100%; min-height: 28px; background: var(--dsw-alias-bg-base, #1f1f1f); color: var(--dsw-alias-label-primary, #cccccc); border: 1px solid var(--dsw-alias-border-l1, #333); border-radius: 4px; }
.ld-review { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.ld-review-file { border: 1px solid var(--dsw-alias-border-l1, #333); border-radius: 4px; overflow: hidden; }
.ld-review-file .ld-filehead { flex-wrap: wrap; }
.ld-side-diff { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); background: var(--dsw-alias-markdown-code-block, #181818); }
.ld-side-code { min-width: 0; overflow-x: auto; }
.ld-side-code + .ld-side-code { border-left: 1px solid var(--dsw-alias-border-l1, #333); }
.ld-checkpoint { width: 100%; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding-bottom: 4px; }
.ld-coverage { max-width: 100%; }
.ld-coverage summary { cursor: pointer; }
.ld-coverage div { max-height: 160px; overflow: auto; padding: 6px; }
.ld-confirm { width: 100%; padding: 8px; border: 1px solid var(--dsw-alias-border-l1, #333); border-radius: 4px; }
.ld-confirm p { margin: 0 0 8px; }
.ld-primary { background: var(--dsw-alias-state-business-primary, #0078d4) !important; color: #fff !important; }
.ld-fileitem, .ld-trow { min-height: 28px; }
.ld-barlabel { white-space: nowrap; }
.ld-muted { color: var(--dsw-alias-label-tertiary, #8b8b8b); font-size: 12px; }
.ld-warn { color: var(--dsw-alias-state-error-primary, #f85149); font-size: 12px; }
.ld-spacer { flex: 1 1 auto; }
.ld-row { display: flex; flex-direction: column; gap: 6px; padding: 2px 0; }
.ld-head { display: flex; align-items: center; gap: 6px; min-height: 22px; font-size: 13px; color: var(--dsw-alias-label-primary, #e6e6e6); flex-wrap: wrap; }
.ld-ico { width: 15px; height: 15px; flex: 0 0 auto; color: var(--dsw-alias-label-tertiary, #8b8b8b); }
.ld-verb { color: var(--dsw-alias-label-secondary, #b8b8b8); }
.ld-path { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; color: var(--dsw-alias-label-primary, #e6e6e6); background: none; border: 0; padding: 0; cursor: pointer; }
.ld-path:hover { text-decoration: underline; }
.ld-pathstatic { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; color: var(--dsw-alias-label-primary, #e6e6e6); }
.ld-add { color: var(--dsh-diff-add-color, #3fb950); font-size: 12px; font-variant-numeric: tabular-nums; }
.ld-del { color: var(--dsh-diff-del-color, #f85149); font-size: 12px; font-variant-numeric: tabular-nums; }
.ld-pending { color: var(--dsw-alias-label-tertiary, #8b8b8b); }
.ld-notice { margin: 0 0 0 21px; padding: 4px 8px; border-radius: 6px; font-size: 12px; color: var(--dsw-alias-state-error-primary, #f85149); background: rgba(248, 81, 73, .1); }
.ld-diff { margin-left: 21px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28)); border-radius: var(--dsw-radius-md, 8px); overflow: hidden; background: var(--dsw-alias-markdown-code-block, rgba(0,0,0,.22)); }
.ld-file + .ld-file { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28)); }
.ld-filehead { display: flex; align-items: center; gap: 8px; padding: 4px 10px; background: rgba(128,128,128,.08); font-size: 12px; }
.ld-difflines { overflow-x: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: var(--dsh-diff-line-height, 20px); }
.ld-line { display: flex; align-items: flex-start; width: max-content; min-width: 100%; }
.ld-ln { flex: 0 0 auto; width: 34px; text-align: right; padding-right: 8px; color: var(--dsw-alias-label-tertiary, rgba(139,139,139,.8)); user-select: none; }
.ld-sign { flex: 0 0 auto; width: 12px; text-align: center; color: var(--dsw-alias-label-tertiary, #8b8b8b); }
.ld-text { flex: 1 1 auto; white-space: pre; padding-right: 12px; color: var(--dsw-alias-label-primary, #e6e6e6); }
.ld-line.add { background: rgba(63, 185, 80, .13); }
.ld-line.add .ld-sign { color: var(--dsh-diff-add-color, #3fb950); }
.ld-line.del { background: rgba(248, 81, 73, .13); }
.ld-line.del .ld-sign { color: var(--dsh-diff-del-color, #f85149); }
.ld-hunk { background: rgba(128,128,128,.1); color: var(--dsw-alias-label-tertiary, #8b8b8b); }
.ld-more { display: block; width: 100%; text-align: left; padding: 3px 10px; border: 0; border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22)); background: none; color: var(--dsw-alias-state-business-primary, #4c8dff); font-size: 12px; cursor: pointer; }
.ld-more:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.1)); }
.ld-btn { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; flex: none; white-space: nowrap; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.38)); border-radius: 4px; background: transparent; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 12px; line-height: 18px; cursor: pointer; }
.ld-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.ld-btn:disabled { opacity: .45; cursor: default; }
.ld-btn.toggled { border-color: var(--dsw-alias-state-business-primary, #4c8dff); color: var(--dsw-alias-state-business-primary, #4c8dff); }
.ld-pitem + .ld-pitem { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22)); }
.ld-phead { display: flex; align-items: center; gap: 6px; padding: 4px 10px; font-size: 12.5px; }
.ld-ptoggle { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0; border: 0; background: none; color: var(--dsw-alias-label-tertiary, #8b8b8b); cursor: pointer; }
.ld-chev { display: inline-flex; transition: transform .12s ease; }
.ld-chev.open { transform: rotate(90deg); }
.ld-pitem .ld-diff { margin: 0 10px 6px 32px; }
.ld-phead { display: flex; align-items: center; gap: 6px; padding: 6px 8px; min-width: 0; cursor: pointer; }
.ld-phead:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.08)); }
.ld-phead .ld-path { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ld-phead .ld-btn { flex: 0 0 auto; margin-left: 2px; }
.ld-toggle { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--dsw-alias-label-secondary, #b8b8b8); cursor: pointer; transition: transform .12s ease, background .12s ease; }
.ld-toggle.open { transform: rotate(90deg); }
.ld-toggle:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); color: var(--dsw-alias-label-primary, #e6e6e6); }\n.ld-toggle .ld-ico { width: 14px; height: 14px; }
.ld-badge { display: inline-flex; align-items: center; gap: 5px; padding: 1px 7px; border: 1px solid transparent; border-radius: 999px; background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.12)); font-variant-numeric: tabular-nums; cursor: pointer; }
.ld-badge:hover { border-color: var(--dsw-alias-border-l2, rgba(128,128,128,.45)); background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18)); }
.ld-badge .ld-add, .ld-badge .ld-del { font-size: 11.5px; line-height: 16px; }
.ld-row.focused > .ld-head { box-shadow: inset 2px 0 0 var(--dsw-alias-state-business-primary, #4c8dff); border-radius: 4px; }
.ld-pane { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px 16px; font-size: 12.5px; color: var(--dsw-alias-label-primary, #e6e6e6); }
.ld-pane.empty { padding: 24px 16px; color: var(--dsw-alias-label-tertiary, #8b8b8b); }
.ld-panebar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-bottom: 8px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22)); }
.ld-group { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.24)); border-radius: var(--dsw-radius-md, 8px); overflow: hidden; background: var(--dsw-alias-bg-base, transparent); }
.ld-group.focused { border-color: var(--dsw-alias-state-business-primary, #4c8dff); box-shadow: 0 0 0 1px var(--dsw-alias-state-business-primary, #4c8dff) inset; }
.ld-grouphead { display: flex; align-items: center; gap: 6px; padding: 6px 10px; background: rgba(128,128,128,.08); font-size: 12px; color: var(--dsw-alias-label-secondary, #b8b8b8); }
.ld-grouphead .ld-ico { width: 13px; height: 13px; }
.ld-panetitle { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; }
.ld-sidebadge { border: 0; background: transparent; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; order: -1; opacity: .9; }
.ld-sidebadge .ld-add, .ld-sidebadge .ld-del { font-size: 11px; }
.ld-turn { display: flex; flex-direction: column; gap: 2px; padding: 10px 0 2px; }
.ld-process { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ld-processlabel { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 13px; color: var(--dsw-alias-label-tertiary, #8b8b8b); background: transparent; border: 0; padding: 0; cursor: pointer; }
.ld-processlabel:disabled { cursor: default; }
.ld-processlabel:hover { color: var(--dsw-alias-label-secondary, #b9b9b9); }
.ld-chevron { transition: transform .15s ease; transform: rotate(-90deg); flex: none; }
.ld-processlabel[data-open="true"] .ld-chevron { transform: none; }
.ld-processbadge { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 13px; background: transparent; border: 0; border-radius: 6px; padding: 2px 6px; cursor: pointer; }
.ld-processbadge:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, .14)); }
.ld-visuallyhidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.ld-turnbar { display: flex; align-items: center; gap: 8px; padding-top: 6px; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #b8b8b8); }
.ld-files { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; font: inherit; color: var(--dsw-alias-label-secondary, #b8b8b8); cursor: pointer; }
.ld-files:hover { color: var(--dsw-alias-label-primary, #e8e8e8); }
.ld-fileschevron { display: inline-block; font-size: 13px; line-height: 1; transform: rotate(0deg); transition: transform .12s ease; }
.ld-fileschevron[data-open] { transform: rotate(90deg); }
.ld-filelist { display: flex; flex-direction: column; gap: 2px; padding: 6px 0 0 14px; }
.ld-fileitem { display: flex; align-items: center; gap: 8px; width: 100%; padding: 2px 6px; border: 0; border-radius: 4px; background: none; font: inherit; font-size: 12px; color: var(--dsw-alias-label-secondary, #b8b8b8); cursor: pointer; text-align: left; }
.ld-fileitem:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06)); }
.ld-fileicon { flex: none; width: 12px; color: var(--dsw-alias-label-tertiary, #8f8f8f); }
.ld-filepath { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary, #e8e8e8); }
.ld-fileitem .ld-add, .ld-fileitem .ld-del { flex: none; font-variant-numeric: tabular-nums; }
.ld-processhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ld-turnrows { display: flex; flex-direction: column; gap: 2px; padding: 6px 0 0 22px; }
.ld-trow { display: flex; align-items: center; gap: 8px; width: 100%; padding: 2px 6px; border: 0; border-radius: 4px; background: none; font: inherit; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #b8b8b8); cursor: pointer; text-align: left; }
.ld-trow:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06)); }
.ld-trowdot { flex: none; width: 7px; height: 7px; border-radius: 50%; opacity: .75; background: var(--dsw-alias-state-business-primary, #4c8dff); }
.ld-trowverb { flex: none; color: var(--dsw-alias-label-secondary, #b8b8b8); }
.ld-trowpath { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-primary, #e8e8e8); }
.ld-trow .ld-add, .ld-trow .ld-del { flex: none; font-variant-numeric: tabular-nums; }
.ld-turnbar .ld-btn, .ld-turn .ld-btn { flex: none; white-space: nowrap; }
.ld-sidehover { display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 12px; color: var(--dsw-alias-label-secondary, #b8b8b8); }
.ld-sidehover .ld-ico { width: 13px; height: 13px; }
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
			"turn.completed": "已完成 {steps} 步 · 用时 {duration}",
			"turn.completedNoSteps": "已完成 · 用时 {duration}",
			"turn.files": "{files} 个文件已修改",
			"turn.keepTitle": "保留这些改动，只是不再追踪",
			"turn.undoTitle": "把这一轮每一处改动都改回去",
			"turn.failed": "操作失败"
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
			"turn.completedNoSteps": "Completed in {duration}",
			"turn.files": "{files} files changed",
			"turn.keepTitle": "Keep these edits and stop tracking them",
			"turn.undoTitle": "Write back the text every edit in this turn replaced",
			"turn.failed": "That did not work"
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
			} catch {
				// A host without a right sidebar keeps the inline row and the bar.
			}
			ensureStyles();
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "copilot-diff: dictionaries");

			for (const key of [
				"edit",
				"write",
				"apply_patch",
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
