# S5 Control Provenance Gap — 2026-07-10

The first stratified control run completed 100 questions with R@5 `77/100`,
p95 `922.038433 ms`, `24617` extraction cache hits, zero LLM calls, and zero
offline fallbacks. It is diagnostic-only and cannot be paired for promotion.

Post-run archive inspection found that the sequential shard provenance sidecar
was not copied beside the merged KPI. More importantly, provenance recorded
HEAD `05d98dfd` but not the uncommitted truth-plane contents. A treatment after
repair could therefore appear commit-matched while executing different code.

Root fixes:

- gate exports a deterministic worktree-state SHA over HEAD, the complete
  tracked binary diff, and sorted nonignored untracked file contents;
- attributed provenance requires and strictly compares that SHA;
- the immutable run manifest binds the same SHA, so resume rejects drift;
- successful one-shard merge copies and byte-verifies the shard provenance
  beside the merged KPI.

Reviewed bundle SHA:
`9110bd804c747c63c0028bea2d3027ea969d8ff760437cf3c5c44d3f239d53f0`.

Reviewed worktree-state SHA:
`f4eeb7b1d917fe6886e4c61cb9f0fc22fc55575670c813487473e93bcc25da55`.

Two focused reviewers returned CLEAN. The control must be rerun from a fresh
unique root; the earlier artifact remains supporting diagnostics only.
