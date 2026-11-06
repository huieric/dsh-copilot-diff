/**
 * dsh-live-diff — client half, loaded as a hand-written bundle through
 * `window.__ModuleLoader__.load` (no build step, like the other DSH web plugins).
 *
 * Two views:
 * - `tool.call.toolview` for `edit` / `write` / `apply_patch`: one row per
 *   mutation, with `+A −R` badges and the diff of that call inline, plus an
 *   Undo action for that single edit.
 * - `conversation.chat.turnTail`: a summary bar under the turn —
 *   "N files changed +X −Y" with Review / Keep / Undo all.
 */
window.__ModuleLoader__.load({
	id: "dsh-live-diff",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;

		/** Connection channel served by lib/index.js. */
		const CHANNEL = "/live-diff";
		/** Locale namespace for this plugin's strings. */
		const NS = "live-diff";
		/** Rows shown per file before the "show more" affordance. */
		const PREVIEW_ROWS = 12;

		/** Connection bridge, filled in by `apply`. */
		let bridge = null;

		//#region transport + store
		/**
		 * Call the server half and return its raw `{ ok, value?, error? }` reply.
		 * @param endpoint - channel endpoint name.
		 * @param payload - `{ sessionId, ... }`.
		 * @returns the reply.
		 */
		async function call(endpoint, payload) {
			if (bridge === null) throw new Error("live-diff is not connected");
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
		 * Verb for one record, derived from what the edit did.
		 * @param record - stored edit entry.
		 * @param t - translator.
		 * @returns the verb.
		 */
		function verbOf(record, t) {
			if (record.deleted) return t("verb.deleted", "Deleted");
			if (record.created) return t("verb.created", "Created");
			if (record.tool === "write") return t("verb.wrote", "Wrote");
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
		function LiveDiffRow(props) {
			const { phase, openFile, cwd, home, block, liveDiffSessionId } = props;
			const t = makeT(props.t);
			const revision = useRevision();
			const [detail, setDetail] = react.useState({ loaded: false, records: [], error: null });
			const [notice, setNotice] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const resultCallId = block?.callId ?? props.callId;
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
					? t("verb.editedN", "Edited {count} files").replace("{count}", String(groups.length))
					: verbOf(records[0], t);
			const label = groups.length > 1 ? null : baseName(displayPath(groups[0].path, cwd, home));

			return h(
				"div",
				{ className: "ld-row" },
				h(
					"div",
					{ className: "ld-head" },
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
					h("span", { className: "ld-add" }, `+${totals.added}`),
					h("span", { className: "ld-del" }, `−${totals.removed}`),
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
				h(DiffBox, { records, cwd, home, openFile })
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
			const [open, setOpen] = react.useState(false);
			const totals = sumOf([record]);
			return h(
				"div",
				{ className: "ld-pitem" },
				h(
					"div",
					{ className: "ld-phead" },
					h(
						"button",
						{ className: "ld-ptoggle", type: "button", onClick: () => setOpen((value) => !value) },
						h("span", { className: open ? "ld-chev open" : "ld-chev" }, h(Icon, { name: "chevron" }))
					),
					h(
						"button",
						{
							className: "ld-path",
							type: "button",
							title: record.path,
							onClick: () => {
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
								{ className: "ld-btn", type: "button", disabled: busy, onClick: () => onUndo(record.id) },
								h(Icon, { name: "undo" }),
								h("span", null, t("row.undo", "Undo"))
							)
						: h("span", { className: "ld-muted" }, record.state === "kept" ? t("row.kept", "Kept") : t("row.reverted", "Undone"))
				),
				open ? h(DiffBox, { records: [record], cwd, home, openFile }) : null
			);
		}

		/**
		 * Turn-tail bar: totals for the turn, Keep / Undo all, and the review panel.
		 * @param props - `{ sessionId }` from the slot inject.
		 * @returns the element.
		 */
		function TurnDiffBar(props) {
			const sessionId = props.sessionId ?? props.liveDiffSessionId;
			const t = makeT(props.t);
			const revision = useRevision();
			const [data, setData] = react.useState(null);
			const [open, setOpen] = react.useState(false);
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
					// The channel is simply absent while the host restarts.
				} finally {
					loading.current = false;
				}
			}, [sessionId]);

			react.useEffect(() => {
				void load();
			}, [load, revision]);

			react.useEffect(() => {
				if (typeof sessionId !== "string") return undefined;
				const timer = setInterval(() => {
					if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
					void load();
				}, 4000);
				return () => clearInterval(timer);
			}, [load, sessionId]);

			const mutate = react.useCallback(
				async (endpoint) => {
					setBusy(true);
					setNotice(null);
					try {
						const reply = await call(endpoint, { sessionId });
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

			if (data === null) return null;
			const totals = data.totals;
			if (totals.edits === 0) return null;

			const openCount = totals.open;
			return h(
				"div",
				{ className: "ld-wrap" },
				h(
					"div",
					{ className: "ld-bar" },
					h(Icon, { name: "diff" }),
					h(
						"span",
						{ className: "ld-barlabel" },
						t("bar.files", "{files} files changed").replace("{files}", String(totals.files)),
						h("span", { className: "ld-muted" }, ` · ${totals.edits} ${t("bar.edits", "edits")}`)
					),
					h("span", { className: "ld-add" }, `+${totals.added}`),
					h("span", { className: "ld-del" }, `−${totals.removed}`),
					h("span", { className: "ld-spacer" }),
					h(
						"button",
						{
							className: open ? "ld-btn toggled" : "ld-btn",
							type: "button",
							onClick: () => setOpen((value) => !value)
						},
						h(Icon, { name: "diff" }),
						h("span", null, open ? t("bar.hide", "Hide") : t("bar.review", "Review"))
					),
					h(
						"button",
						{ className: "ld-btn", type: "button", disabled: busy || openCount === 0, onClick: () => mutate("keep-all") },
						h(Icon, { name: "check" }),
						h("span", null, openCount === 0 ? t("bar.kept", "Kept") : t("bar.keep", "Keep"))
					),
					h(
						"button",
						{ className: "ld-btn", type: "button", disabled: busy || openCount === 0, onClick: () => mutate("revert-all") },
						h(Icon, { name: "undo" }),
						h("span", null, t("bar.undoAll", "Undo all"))
					)
				),
				notice === null ? null : h("div", { className: "ld-notice" }, notice),
				open
					? h(
							"div",
							{ className: "ld-panel" },
							data.records
								.slice()
								.reverse()
								.map((record) =>
									h(PanelRecord, {
										key: record.id,
										record,
										cwd: props.cwd,
										home: props.home,
										openFile: props.openFile,
										busy,
										t,
										onUndo: async (id) => {
											setBusy(true);
											setNotice(null);
											try {
												const reply = await call("revert", { sessionId, id });
												if (reply?.ok === true) {
													setData(reply.value);
													notify();
												} else setNotice(reply?.error?.message ?? t("undo.failed", "Undo failed"));
											} catch (error) {
												setNotice(String(error?.message ?? error));
											} finally {
												setBusy(false);
											}
										}
									})
								)
						)
					: null
			);
		}
		//#endregion

		//#region styles
		/** Inline stylesheet; injected once and scoped by the `ld-` prefix. */
		const CSS = `
.ld-wrap { display: flex; flex-direction: column; gap: 6px; margin: 8px 0 2px; }
.ld-bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28)); border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-module-platform, rgba(128,128,128,.06)); font-size: 12.5px; color: var(--dsw-alias-label-primary, #e6e6e6); }
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
.ld-btn { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.38)); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary, #e6e6e6); font-size: 12px; line-height: 18px; cursor: pointer; }
.ld-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.ld-btn:disabled { opacity: .45; cursor: default; }
.ld-btn.toggled { border-color: var(--dsw-alias-state-business-primary, #4c8dff); color: var(--dsw-alias-state-business-primary, #4c8dff); }
.ld-panel { border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.28)); border-radius: var(--dsw-radius-md, 8px); overflow: hidden; }
.ld-pitem + .ld-pitem { border-top: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.22)); }
.ld-phead { display: flex; align-items: center; gap: 6px; padding: 4px 10px; font-size: 12.5px; }
.ld-ptoggle { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; padding: 0; border: 0; background: none; color: var(--dsw-alias-label-tertiary, #8b8b8b); cursor: pointer; }
.ld-chev { display: inline-flex; transition: transform .12s ease; }
.ld-chev.open { transform: rotate(90deg); }
.ld-pitem .ld-diff { margin: 0 10px 6px 32px; }
`;

		/** Inject the stylesheet unless an earlier mount already did. */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			const id = "dsh-live-diff/live-diff.css";
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(id)}]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-live-diff";
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
			"bar.failed": "操作未成功"
		};
		const en = {
			"verb.edited": "Edited",
			"verb.wrote": "Wrote",
			"verb.created": "Created",
			"verb.deleted": "Deleted",
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
			"bar.failed": "That did not work"
		};
		//#endregion

		/** Client services this bundle needs. */
		exports.inject = ["slots", "locale", "connection"];

		/**
		 * Register the row views, the turn-tail bar, dictionaries and styles.
		 * @param ctx - client plugin context.
		 */
		exports.apply = async function apply(ctx) {
			bridge = ctx.get("connection");
			ensureStyles();
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "live-diff: dictionaries");

			for (const key of ["edit", "write", "apply_patch"]) {
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

			ctx.slots.inject("conversation.chat.turnTail", () =>
				ctx.slots.register(
					{
						name: "conversation.chat.turnTail",
						id: "dsh-live-diff",
						order: -1,
						locale: NS,
						inject: (sessionId) => ({ sessionId })
					},
					TurnDiffBar
				)
			);
		};

		return module.exports;
	}
});
