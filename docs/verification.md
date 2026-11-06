# Verification and delivery notes

Development branch: `feat/copilot-review-checkpoints`, isolated checkout `dsh-copilot-diff-review`, base `e734ab3` (0.1.13). Candidate version `0.2.0`; no registry publish or GitHub push performed.

## Verified

- Baseline `npm test`: 41/41 pass.
- First integrated implementation: 63/63 pass. Independent reviews found additional state-transition and cross-session gaps; final fixes add regressions for these cases. The final expanded suite result is recorded below at completion.
- `node --check` client/checkpoint/browser/host-smoke sources, `git diff --check` passed for initial integrated branch.
- Bounded home-workspace capture measurement: approximately 1.2 seconds, 980 discovered entries, 4.8 MB captured UTF-8 text, target dsh-copilot-diff repository included. This is a local measurement, not a latency guarantee; specific project workspaces are faster.
- npm package dry-run includes `lib/checkpoints.js` plus every imported runtime module; archive extraction and ESM import of server entry succeeded. Local installer also passed against a disposable profile under output/install-check; bundle registration and server import verified without changing the active profile.
- Browser synthetic fixture: clicked a footer file, confirmed nonempty actual code diff in scoped pane, switched split mode, next-file navigation and Restore confirmation. No page errors. Fixture is visibly labelled synthetic and uses invented code/data; its counts are not a real session measurement.
- Screenshot files are generated under `output/playwright/`; reusable browser procedure is `tools/browser-smoke.mjs` using an existing CDP browser. The original existing browser tab is preserved.

## Environment limitations

- Fresh requests and a browser tab to `http://127.0.0.1:3080` return 401 (requires the URL/authentication established by `dsh web`). No credentials were read or copied. Existing CDP tab on port 3099 had no running server when checked. Authenticated actual-host GUI integration is not claimed.
- New Chromium launch from CLI fails missing `libatk-1.0.so.0`; existing CDP browser on port 9333 works for the synthetic component fixture.
- Installed real `LocalFileSystem` smoke reads, stats and resolves targets, but atomic writes fail `EXDEV` on the staging-directory rename in the current tool sandbox. Generic Node child-directory-to-parent rename reproduces EXDEV on the same ext4 filesystem; same-directory sibling rename succeeds. Root cause is unconfirmed. Do not claim actual host restore passed, and do not bypass the host filesystem with raw writes.
- The running Web profile has not been replaced/restarted during development. Host changes need plugin reload/restart and browser refresh. No watcher `pnpm run dev:web` was running; automatic hot updates are not promised.

## Decisions

- Persistent bounded text snapshots are necessary because host `workspaceChanges` offers ephemeral hunks, no durable full text or restore API.
- Checkpoints restore local captured files and preserve conversation history. Secret/dependency/cache stores, symlinks, binary and oversized files are excluded; coverage is visible. A specific code-project workspace gives better coverage than a whole-home workspace.
- Restore Checkpoint is a separate confirmed action from per-file and per-turn Undo; it may reverse subsequent captured changes. Keep preserves checkpoints.
- Development uses an isolated branch; independent backend and UI changes used disjoint file ownership followed by cross-module reviews.
