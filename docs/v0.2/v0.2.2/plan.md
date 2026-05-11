# Alaya v0.2.2 — Host Autonomy Evidence (#BL-038 + #BL-037)

> Briefer plan. Detailed task cards are written when v0.2.1 lands and
> v0.2.2 becomes the active wave.

## 1. Goal

Close the two evidence items that v0.1 left open because they depend
on external conditions (a real Codex / Claude Code session, a
specific Codex CLI version):

- **#BL-038 — Host autonomous use of `soul.*` tools.** Capture a
  recording of a real Codex (or Claude Code) session that
  autonomously calls `soul.recall` and `soul.report_context_usage`
  during a normal conversation, and add an offline replay regression
  so the behaviour stays observable across host upgrades.
- **#BL-037 — Codex `/alaya-inspect` host slash recognition.** Either
  prove that the Codex CLI host recognizes the Alaya-managed slash
  registry entry, or document that it does not and retire the
  expectation from `runtime-status.md`.

After v0.2.2, the `MCP tool surface` subsystem in `runtime-status.md`
moves from `mcp-callable` to `agent-used` for the validated host(s).

## 2. #BL-038 work

### Recording

- Fresh install in an isolated config directory, fresh attach, no
  pre-seeded memory.
- Start a real MCP stdio session against the target Codex (or
  Claude Code) CLI version. The exact version is recorded in the
  fixture metadata.
- Run a memory-sensitive prompt the host model has plausibly trained
  on as a recall-worthy scenario (e.g. "What was the user's stated
  naming preference for retry helpers?").
- Capture EventLog rows from the daemon: at minimum one
  `soul.recall.delivered` and one `soul.context_usage.reported` with
  `usage_status == "used"`, both originating from the host (not a
  test harness).

### Offline replay regression

- Fixture lives at `docs/v0.2/v0.2.2/host-autonomy-fixtures/<host>-<version>/`.
- A new test boots a daemon with the fixture's pre-seeded state,
  replays the recorded MCP stdin transcript, and asserts that the
  daemon produces the same EventLog rows (modulo timestamps,
  delivery_id, and similar non-deterministic identifiers).
- Test runs offline; no live host required. This keeps the regression
  durable across host model upgrades — when the upstream model
  changes its autonomous tool-selection behaviour, the recording
  ages out and a fresh one is captured, but the offline replay still
  pins the daemon contract.

### Out-of-scope here

- Provider-backed Garden compute autonomy proof is a separate slice
  driven by `garden.compute.provider_kind` config, not by host
  autonomy. v0.2.0's pi-mono swap proves it on the daemon side; the
  end-to-end host autonomy + provider autonomy combined proof can
  wait for a later release.

## 3. #BL-037 work

### Confirmation gate

Two outcomes are acceptable; either closes the issue.

- **Codex CLI supports a documented slash registry.** Codex publishes
  (or documents internally) a fixed format for third-party slash
  commands. `alaya attach codex` writes the documented format; a
  recorded session shows `/alaya-inspect` appears in the composer
  and dispatches to `node <repo>/bin/alaya.mjs inspect --open`.
- **Codex CLI does not support a third-party slash registry.** The
  `cli-consumable` expectation is removed from `runtime-status.md`;
  `alaya inspect --open` plus MCP/CLI fallback is documented as the
  supported path; `#BL-037` is closed as "intentionally not
  supported by host" with a maintenance-note pointer to the Codex
  version that was tested.

### Profile mutation hygiene

If Codex does support the registry, the profile mutation should be
the same audit-first, preview-then-confirm flow that the v0.1
attach path uses. No silent profile rewrites.

## 4. Release condition

- #BL-038: at least one (host, host-version) pair has a recorded
  fixture and a passing offline replay regression on CI.
- #BL-037: either positive proof (slash dispatch transcript) or
  negative proof (a written note in `docs/handbook/maintenance.md`
  citing the Codex version tested and the supported fallback path).
- `docs/handbook/runtime-status.md` is updated to reflect the new
  readiness label for `MCP tool surface`.
- `docs/handbook/backlog.md` marks #BL-037 and #BL-038 as Resolved
  with evidence links.

## 5. Out of scope

- Other host CLIs (Aider, Cursor, etc.). v0.2.2 covers Codex and
  Claude Code only; other hosts open separate backlog issues when a
  user surfaces a real need.
- Real-time host autonomy metrics dashboards beyond
  `alaya status --recall-stats` (already shipped in v0.1.1).
- LLM-driven evaluation of recall quality (deferred to a later
  release; v0.2.0's recall refinement is mechanical, not learned).

## 6. Critical files

```
docs/v0.2/v0.2.2/host-autonomy-fixtures/<host>-<version>/            (new)
apps/core-daemon/src/__tests__/host-autonomy-replay.test.ts          (new)
docs/handbook/runtime-status.md                                      (MCP tool surface readiness)
docs/handbook/backlog.md                                             (#BL-037 + #BL-038 closure)
docs/handbook/maintenance.md                                         (Codex version notes)
```
