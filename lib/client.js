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
		function openPanel(callId, sessionId) {
			focusState = { callId, sessionId, revision: focusState.revision + 1 };
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
		function flattenHunks(hunks) {
			const out = [];
			for (const hunk of Array.isArray(hunks) ? hunks : []) {
				out.push({
					kind: "header",
					text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`
				});
				for (const row of hunk.rows ?? []) out.push({ kind: "line", row });
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
			const shown = expanded ? rows : rows.slice(0, PREVIEW_ROWS);
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
						if (reply?.ok === true) notify();
						else setNotice(reply?.error?.message ?? t("undo.failed", "Undo failed"));
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
		function ReviewPane(props) {
			const focus = useFocus();
			const t = makeT(props.t);
			const revision = useRevision();
			const sessionId = typeof props.sessionId === "string" ? props.sessionId : focus.sessionId;
			const [data, setData] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState(null);
			const loading = react.useRef(false);

			const load = react.useCallback(async () => {
				if (typeof sessionId !== "string" || loading.current) return;
				loading.current = true;
				try {
					const reply = await call("list", { sessionId });
					if (reply?.ok === true) setData(reply.value);
				} catch {
					// The channel is absent while the host restarts.
				} finally {
					loading.current = false;
				}
			}, [sessionId]);

			react.useEffect(() => {
				void load();
			}, [load, revision, focus.revision]);

			react.useEffect(() => {
				const timer = setInterval(() => {
					if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
					void load();
				}, 4000);
				return () => clearInterval(timer);
			}, [load]);

			const mutate = react.useCallback(
				async (endpoint, id) => {
					setBusy(true);
					setNotice(null);
					try {
						const reply = await call(endpoint, id === undefined ? { sessionId } : { sessionId, id });
						if (reply?.ok === true) {
							setData(reply.value);
							notify();
						} else {
							setNotice(reply?.error?.message ?? t("bar.failed", "That did not work"));
						}
					} catch (error) {
						setNotice(String(error?.message ?? error));
					} finally {
						setBusy(false);
					}
				},
				[sessionId, t]
			);

			if (typeof sessionId !== "string") {
				return h("div", { className: "ld-pane empty" }, t("panel.noSession", "No session is selected"));
			}
			if (data === null) {
				return h("div", { className: "ld-pane empty" }, t("panel.loading", "Loading changes…"));
			}
			const totals = data.totals;
			if (totals.edits === 0) {
				return h("div", { className: "ld-pane empty" }, t("panel.empty", "No file changes in this session yet"));
			}
			const groups = groupByCall(data.records);
			return h(
				"div",
				{ className: "ld-pane" },
				h(
					"div",
					{ className: "ld-panebar" },
					h(
						"span",
						{ className: "ld-barlabel" },
						fill(t, "bar.files", "{files} files changed", { files: totals.files }),
						h("span", { className: "ld-muted" }, ` · ${totals.edits} ${t("bar.edits", "edits")}`)
					),
					h("span", { className: "ld-add" }, `+${totals.added}`),
					h("span", { className: "ld-del" }, `−${totals.removed}`),
					h("span", { className: "ld-spacer" }),
					h(
						"button",
						{ className: "ld-btn", type: "button", disabled: busy || totals.open === 0, onClick: () => mutate("keep-all") },
						h(Icon, { name: "check" }),
						h("span", null, totals.open === 0 ? t("bar.kept", "Kept") : t("bar.keep", "Keep"))
					),
					h(
						"button",
						{ className: "ld-btn", type: "button", disabled: busy || totals.open === 0, onClick: () => mutate("revert-all") },
						h(Icon, { name: "undo" }),
						h("span", null, t("bar.undoAll", "Undo all"))
					)
				),
				notice === null ? null : h("div", { className: "ld-notice" }, notice),
				groups.map((group) => {
					const groupTotals = sumOf(group.items);
					const paths = new Set(group.items.map((record) => record.path));
					const focused = focus.callId !== undefined && focus.callId === group.callId;
					return h(
						"div",
						{ key: group.callId, className: focused ? "ld-group focused" : "ld-group", ref: focused ? scrollIntoView : undefined },
						h(
							"div",
							{ className: "ld-grouphead" },
							h(Icon, { name: "diff" }),
							h(
								"span",
								null,
								paths.size > 1
									? fill(t, "verb.editedN", "Edited {count} files", { count: paths.size })
									: verbOf(group.items[0], t)
							),
							h("span", { className: "ld-add" }, `+${groupTotals.added}`),
							h("span", { className: "ld-del" }, `−${groupTotals.removed}`)
						),
						group.items.map((record) =>
							h(PanelRecord, {
								key: record.id,
								record,
								cwd: props.cwd,
								home: props.home,
								openFile: props.openFile,
								busy,
								t,
								defaultOpen: true,
								onUndo: (id) => mutate("revert", id)
							})
						)
					);
				})
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
		 * Copilot-style completion footer under a turn: one line saying how long
		 * and how many steps it took, then the change count with Keep and Undo.
		 * Renders nothing for a turn that changed no file.
		 * @param props - `{ turn, sessionId, t }`.
		 * @returns the element, or null.
		 */
		function TurnFooter(props) {
			const t = makeT(props.t);
			const revision = useRevision();
			const [data, setData] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [notice, setNotice] = react.useState(null);
			const sessionId = props.sessionId;
			const { from, to } = turnWindow(props.turn);
			react.useEffect(() => {
				if (typeof sessionId !== "string") return undefined;
				let alive = true;
				call("list", { sessionId })
					.then((reply) => {
						if (alive && reply?.ok === true) setData(reply.value);
					})
					.catch(() => {
						// No channel yet: the footer simply stays absent.
					});
				return () => {
					alive = false;
				};
			}, [sessionId, revision]);

			if (data === null) return null;
			const rows = (data.records ?? []).filter((record) => record.time >= from && record.time <= to);
			if (rows.length === 0) return null;

			const paths = new Set(rows.map((record) => record.path));
			let added = 0;
			let removed = 0;
			for (const record of rows) {
				added += record.added ?? 0;
				removed += record.removed ?? 0;
			}
			const openCount = rows.filter((record) => record.state === "open").length;
			const steps = Array.isArray(props.turn?.steps) ? props.turn.steps.length : 0;
			const started = props.turn?.start?.time;
			const ended = props.turn?.end?.time;
			const duration =
				typeof started === "number" && typeof ended === "number" ? formatDuration(ended - started) : "";
			const stepsText = steps > 0
				? fill(t, "turn.completed", "Completed {steps} steps in {duration}", {
						steps,
						duration: duration.length > 0 ? duration : "—"
					})
				: fill(t, "turn.completedNoSteps", "Completed in {duration}", {
						duration: duration.length > 0 ? duration : "—"
					});

			/**
			 * Apply a turn-scoped action, then refresh from its reply.
			 * @param endpoint - `keep-turn` or `revert-turn`.
			 * @returns nothing.
			 */
			async function act(endpoint) {
				if (busy) return;
				setBusy(true);
				setNotice(null);
				try {
					const reply = await call(endpoint, { sessionId, from, to });
					if (reply?.ok === true) {
						setData({ ...reply.value });
						notify();
					} else setNotice(reply?.error?.message ?? t("turn.failed", "That did not work"));
				} catch (error) {
					setNotice(error instanceof Error ? error.message : String(error));
				} finally {
					setBusy(false);
				}
			}

			return h(
				"div",
				{ className: "ld-turn" },
				h(
					"div",
					{ className: "ld-turnstats" },
					h("span", { className: "ld-muted" }, stepsText),
					h("span", { className: "ld-add" }, `+${added}`),
					h("span", { className: "ld-del" }, `−${removed}`)
				),
				h(
					"div",
					{ className: "ld-turnbar" },
					h("span", { className: "ld-files" }, fill(t, "turn.files", "{files} files changed", { files: paths.size })),
					h("span", { className: "ld-add" }, `+${added}`),
					h("span", { className: "ld-del" }, `−${removed}`),
					h("span", { className: "ld-spacer" }),
					h(
						"button",
						{
							className: "ld-btn",
							type: "button",
							disabled: busy || openCount === 0,
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
							disabled: busy || openCount === 0,
							title: t("turn.undoTitle", "Write back the text every edit in this turn replaced"),
							onClick: () => void act("revert-turn")
						},
						t("bar.undo", "Undo")
					)
				),
				notice === null ? null : h("div", { className: "ld-notice" }, notice)
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
				"span",
				{ className: "ld-sidebadge", title: `${totals.files} files · ${totals.edits} edits` },
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
.ld-btn { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; flex: none; white-space: nowrap; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.38)); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 12px; line-height: 18px; cursor: pointer; }
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
.ld-sidebadge { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; order: -1; opacity: .9; }
.ld-sidebadge .ld-add, .ld-sidebadge .ld-del { font-size: 11px; }
.ld-turn { display: flex; flex-direction: column; gap: 2px; padding: 10px 0 2px; }
.ld-turnstats { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-tertiary, #8b8b8b); }
.ld-turnbar { display: flex; align-items: center; gap: 8px; padding-top: 6px; font-size: 12.5px; color: var(--dsw-alias-label-secondary, #b8b8b8); }
.ld-files { color: var(--dsw-alias-label-secondary, #b8b8b8); }
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
