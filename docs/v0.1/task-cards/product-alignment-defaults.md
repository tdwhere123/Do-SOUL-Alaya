# Product Alignment Defaults

这些不是阻塞任务卡的问题。它们是 Alaya 独立产品化时采用的默认值。
后续如果用户想改变体验，再单独调整。

## Defaults

| Area | Default |
|---|---|
| Attach/Profile conflict UX | preview-only diff + explicit per-target confirm；不自动 merge global/project rules |
| Gateway strictness | default audit mode；strict blocking only with command flag or benchmark profile |
| Secret storage | v0.1 使用 abstract secret refs + env/local-file adapter；OS keychain deferred |
| Benchmark suite | coding continuation、review/fix-loop、long-context recall |
| Inspector visual direction | Phase 2 point/network graph；v0.1 only freezes data contract |

## Rule

AI should not stop task-card writing for these defaults. Use them unless the user
explicitly changes product direction.
