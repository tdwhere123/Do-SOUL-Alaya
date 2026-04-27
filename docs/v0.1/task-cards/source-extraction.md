# ALA-R0 - Source Extraction

## Goal

把 `do-what-new` 中已经形成的 SOUL 体系抽取成 Do-SOUL Alaya v0.1 的确定实现依据。

## Source References

- `/home/tdwhere/vibe/do-what-new/README.md:56`
- `/home/tdwhere/vibe/do-what-new/docs/handbook/invariants.md:7`
- `/home/tdwhere/vibe/do-what-new/docs/handbook/invariants.md:22`
- `/home/tdwhere/vibe/do-what-new/docs/handbook/invariants.md:27`
- `/home/tdwhere/vibe/do-what-new/docs/handbook/invariants.md:51`
- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/08-glossary.md:337`
- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/08-glossary.md:361`
- `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/08-glossary.md:373`

## Alaya Adaptation

- 用 Alaya 术语重写 do-what-new 的 SOUL 语义。
- 保留三层四轴、durable truth、runtime control、governance audit。
- 不继承 do-what-new 的 monorepo package 名称、runtime code、应用入口。

## Non-goals

- 不写实现代码。
- 不重新设计 SOUL。
- 不把历史 archive 里的旧 prototype 当作当前实现。

## Scope

- `docs/v0.1/task-cards/**`
- `docs/v0.1/extraction-ledger.md`
- 必要时同步 `docs/v0.1/README.md`

## Inputs

- do-what-new handbook、v0.1-v0.2 consolidated archive、Phase C、Phase C extension、TUI-A docs。
- Alaya handbook 和 v0.1 plan。

## Outputs

- 每张 task card 有 source references。
- 每张 task card 的 acceptance 来自 source-backed 或 alaya-adapted 内容。
- 产品默认值集中在 `product-alignment-defaults.md`。

## Acceptance

- 没有把“尚未抽取”写成“需要用户决策”。
- 所有根任务卡都能独立交给 AI 执行。
- source-backed 规则直接转成验收条件，不再作为阻塞项悬置。

## Verification

- stale marker scan confirms old unresolved-decision framing is absent.
- markdown link checker。
- read-only review against do-what-new source references。

## Review Lens

- domain language。
- source evidence completeness。
- scope drift。

## Stop Conditions

- 找不到 source reference 时，先扩大 do-what-new 搜索，不直接问用户。
- 只有确认是 Alaya 独立产品体验问题时，才放入 alignment defaults。
