# Verification and delivery notes

Development branch: `feat/copilot-review-checkpoints`, isolated checkout `dsh-copilot-diff-review`, base `e734ab3` (0.1.13). Candidate version `0.3.0`; no registry publish or GitHub push performed.

## Verified

- Final `npm test`: **81 passed / 0 failed**, exit 0, approximately 5.1 seconds. This expands the 0.2.0 suite (78) with whole-file rendering regressions: created and deleted files render their body without `@@` bars, unchanged runs fold into `⋯ N unchanged lines`, and the chat row fetches `file-text` only when a record has no local snapshot.
- `node --check` passes for `lib/client.js`, `lib/index.js`, `lib/checkpoints.js`, and the preview/browser-smoke tools.
- Synthetic browser fixture (`tools/browser-smoke.mjs`, existing CDP Chromium on 9333, no new server): opens a turn, confirms per-edit inline diffs are present by default, collapses and re-expands one, opens the Changes pane, expands an unchanged region, switches Inline → Side by side, switches files, and confirms the Restore Checkpoint dialog. No page errors. Result: `{"fixture":"synthetic","codeVisible":true,"inlineDiff":true,"pageErrors":[],"screenshot":"output/playwright/copilot-review.png"}`.
- Screenshots regenerated from the real components + synthetic data: `docs/screenshots/overview.png` (chat inline diffs + Changes pane), `docs/screenshots/inline.png` (one edit's in-place diff), `docs/screenshots/expanded.png` (whole-file pane with an unfolded unchanged region). Text/layout was cross-checked with local OCR and DOM metrics because the vision backend was unavailable during this pass (see limitations).
- DOM metrics: pane 709×938; editor bar and footer 32 px; file row 22 px; diff line 12 px/20 px monospace; no horizontal overflow; add `rgba(46,160,67,.15)`, delete `rgba(248,81,73,.13)`, gap `rgba(110,118,129,.07)`.
- `npm pack` dry-run includes `lib/checkpoints.js` and every imported runtime module; archive extraction and ESM import of the server entry succeed. Package: `output/package/dsh-copilot-diff-0.3.0.tgz`.

## Environment limitations

- Fresh requests and a browser tab to `http://127.0.0.1:3080` return 401 (requires the URL/authentication established by `dsh web`). No credentials were read or copied. Authenticated actual-host GUI integration is not claimed.
- The vision backends used for screenshot reading returned timeouts throughout this pass (`VISION_BACKEND_UNAVAILABLE_THIS_TURN`). Layout claims rest on the rendered DOM, local OCR text/coordinates, and computed styles, not on a human or model visual review. A final look in the running GUI is still recommended.
- New Chromium launch from CLI fails missing `libatk-1.0.so.0`; the existing CDP browser on port 9333 works for the synthetic component fixture.
- Installed real `LocalFileSystem` smoke reads, stats and resolves targets, but atomic writes fail `EXDEV` on the staging-directory rename in the current tool sandbox. Generic Node child-directory-to-parent rename reproduces EXDEV on the same ext4 filesystem; same-directory sibling rename succeeds. Root cause is unconfirmed. Do not claim actual host restore passed, and do not bypass the host filesystem with raw writes.
- The running Web profile has not been replaced/restarted during development, and the new build is not installed into it. Host changes need plugin reload/restart and browser refresh. No watcher `pnpm run dev:web` was running; automatic hot updates are not promised.

## Decisions

- Inline diffs open by default under each edit row because the requested behavior is "the diff appears where the file was edited", not a detached file list. A row chevron collapses it again.
- The whole-file view is reconstructed from bounded before/after snapshots plus hunk coordinates. If a historical record has no snapshot, `file-text` returns `hasText:false` (or `too-large` above 4 MiB) and the UI says so instead of truncating.
- Unchanged regions fold into a clickable `⋯ N unchanged lines` row; this gives full-file context without dumping an entire file into the chat.
- `file-text` is a read-only RPC over already-persisted records; it cannot read arbitrary paths, and it applies the same visibility filter as the review endpoints.
- Restore Checkpoint stays a separate confirmed action from per-file and per-turn Undo; Keep preserves checkpoints. Conversation history is not rewritten, and the UI says so.
