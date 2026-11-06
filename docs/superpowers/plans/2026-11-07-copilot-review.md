# Copilot Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Copilot-like sidebar file review, shell mutation tracking and persistent per-turn Restore Checkpoint.

**Architecture:** A bounded workspace capture module stores immutable file revisions per session and turn, with the server coordinating tool lifecycle capture and host-policy restore. The existing client bundle consumes additional checkpoint and turn-review endpoints and opens a scoped review sidebar.

**Tech Stack:** Node ESM, node:test, existing DSH React module-loader and connection/slots/fs services.

**Spec:** docs/superpowers/specs/2026-11-07-copilot-review.md

## Global Constraints
- Build on dsh-copilot-diff 0.1.13; no new runtime dependency or model interception.
- Preserve dirty/untracked files, file creation/deletion and exact text bytes; never reset git/index/refs.
- Host fs policy governs writes; preflight conflicts; excluded content must be visible.
- Persistent checkpoints remain available after Keep and restart; historical turns without snapshots are unavailable.
- Use existing GUI http://127.0.0.1:3080; do not start a replacement DSH server.

## Review Focus
- Shell exits nonzero after modifying a file: capture mutation anyway.
- Same file changed by editor and shell in one turn: final review must show full net change.
- Later external edit on a restore target: refuse all writes before restore begins.
- Home-root workspaces and nested repositories: bounded discovery, explicit coverage.
- Reopening an older turn after session switch: no stale records or whole-session actions.

### Task 1: Persistent workspace snapshots and lifecycle integration
**Files:** Create lib/checkpoints.js, test/checkpoints.test.js; modify lib/index.js and test/server.test.js.
**Interfaces:** list response adds checkpoints[] summaries {turn,time,status,files,limitations}; `review-turn` {sessionId,turn} returns {records,totals,root}; `checkpoints` returns summaries; `restore-checkpoint` {sessionId,turn} restores to that turn start with conflict preflight. Checkpoint records carry before/after, hunks, turn, path, absPath; `detail` continues supporting existing call ids.
- [ ] Add real-workspace tests for sed/Python/failure writes, create/delete, multi-turn restore, conflicts, restart, exclusions.
- [ ] Implement bounded capture, persistence and conflict-checked restore using host fs writes.
- [ ] Wire turn/start/end, shell pre-execute/result and review/checkpoint RPCs; avoid double-counting net turn records.
- [ ] Run npm test and inspect failures; preserve existing supported behavior.

### Task 2: Scoped Copilot review UI and checkpoint controls
**Files:** Modify lib/client.js, test/client.test.mjs and tools/preview.mjs.
**Interfaces:** Consume Task 1 endpoints; openPanel accepts optional scope {turn,path}; checkpoint summaries are read from list. Existing call-level navigation remains compatible.
- [ ] Add client tests for footer-file opens sidebar, turn-scoped actions, checkpoint controls and diff mode.
- [ ] Implement compact changed-file list with status/file icons and scoped sidebar navigation; unified/side-by-side modes.
- [ ] Add Restore Checkpoint before each turn using supported transcript slot or turn-process prefix, explicit confirmation and errors; explain file-only restore.
- [ ] Run client tests and render labelled component fixture.

### Task 3: Integration, independent review and delivery
**Files:** Modify package.json, README.md; add browser smoke tooling as needed.
- [ ] Run complete tests and validate npm package contents include new modules.
- [ ] Review full diff independently for restore correctness and GUI lifecycle issues; address findings.
- [ ] Exercise rendered UI with browser automation and existing GUI where feasible, record accurate limitations.
- [ ] Document coverage/limits, endpoints, upgrade and checkpoint semantics; deliver branch and verification evidence.

## Execution ruling
User explicitly requested implementation; proceed autonomously with isolated worktree and delegated backend task, then UI and integration. Do not pause for an implementation-method choice.
