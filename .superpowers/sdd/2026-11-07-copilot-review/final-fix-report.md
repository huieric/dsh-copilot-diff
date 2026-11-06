# Consolidated final fix report

Implemented the six groups from final-fix-brief.md against reviewed base f421781. Parent documentation commits remain separate.

- Full Restore includes reverted paths in its expected-current-state preflight. The exact A→B→C / Undo2 / Undo1 / Restore2 sequence refuses before any write when the selected start is inconsistent. Normal newer Undo then older Restore remains supported. Scoped Undo only checks selected checkpoint coverage.
- Original-call Undo obtains host versions, verifies content/version consistency, uses replaceIfVersion/createIfAbsent/delete version guards, recognizes FS_NOT_FOUND and ENOENT, forwards session policy, and runs under maintenance plus the checkpoint queue. Successful Undo reconciles the net record after-state without recapturing or replacing the starting snapshot. Restart and subsequent Restore are tested.
- All Changes hydrates only exact list record identities and reports missing detail coverage. Original inline call detail remains complete. Both mixed apply_patch RPC coverage and client mixed hydration are tested.
- Numeric turn requests retain from/to windows. One backend matcher prefers numeric record identity and uses validated windows only for legacy rows; no-window requests never include arbitrary historical rows. Legacy review/Keep/Undo do not require checkpoints, while historical Restore stays unavailable.
- Badge navigation uses optional uiWorkspace.openSession and observes sidebarRight.mounted before opening the target tab. Never-adopted B, mounted A, no current session, unsupported navigation, and subsequent A selection are tested. Session changes clear stale scope. Existing pane file callbacks stay attached to pane props; absent file callbacks disable the path opener rather than fabricate resource addresses. Preview fixture now supplies the mounted observable contract.
- Persistence checks file size before reading, validates turns/snapshots/records, paths, state and original-baseline consistency before adoption, and recomputes diff bodies from validated text. Invalid history remains untouched with visible unavailable coverage. Acquisition stops at the retained checkpoint count/byte budget and records one bounded unavailable turn range; later Restore refuses crossing that gap. Existing baselines are not evicted. File-to-directory transitions report unsupported coverage instead of a false deletion.

## Verification

- `node --test test/checkpoints.test.js`: 19 passed.
- `node --test test/server.test.js`: 23 passed before adding the mixed RPC regression; the full suite includes 24 server tests.
- `node --test test/client.test.mjs`: 18 passed, including the final deterministic async totals fixture (no wall-clock readiness sleep).
- `npm test`: 77 passed, 0 failed (baseline 63; 14 added regressions). Full run exited successfully in about 5.2 seconds.
- `node --check lib/index.js`, `node --check lib/checkpoints.js`, and `git diff --check`: passed during implementation.

Initial failed runs exposed outdated fixture service contracts, malformed synthetic apply_patch results, and missing summaries.sums in the badge fixture; fixtures were corrected to actual RPC/host shapes and rerun. No production assertions were removed to hide failures.

## Evidence limits

No publish, installation, host restart, or live session mutation was performed. Authenticated host GUI navigation and successful installed-host writes are not claimed. The known real-host FS smoke EXDEV/tool-sandbox atomic rename limitation remains; all workspace writes still go through host fs, with no raw-write fallback. Parent owns browser smoke and package/docs verification.

Snapshots remain bounded best-effort local text capture: concurrent raw filesystem growth can exceed a pre-stat/enumeration allocation expectation; alternate provider execution worlds are not established here. External filesystem writers remain outside session maintenance, host CAS guards protect providers supporting versions, and multi-file restoration is not transactional after preflight. The client safely declines cross-session navigation when optional navigation/mounted services are absent or the target never mounts (pending intent expires after ten seconds).
