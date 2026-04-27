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

## Source Classification

- `source-backed`: SOUL 三层、四轴、不变量优先级、runtime/durable
  boundary、术语语义来自上游 handbook 与 consolidated glossary。
- `alaya-adapted`: Alaya 是独立 package 与本地优先 memory core，只继承
  source truth、schema intent、review/gate 纪律，不继承 do-what-new runtime
  code、package namespace、应用入口或 monorepo wiring。
- `alaya-default`: 只有 Attach/Profile preview-confirm、Gateway audit default、
  abstract secret refs、benchmark families、Phase 2 graph direction 进入
  [product-alignment-defaults.md](product-alignment-defaults.md)。
- 禁止误用：找不到直接来源时先扩大 do-what-new 搜索；不能把 source gap
  写成产品方向阻塞；不能把 archive 旧 prototype 当作当前实现事实。
- R12 是 Alaya full-product gate 汇总卡。它可以引用 do-what-new gate/report
  纪律和前置 ALA-R1 到 ALA-R11，但不能声称 do-what-new 已有同款 Alaya
  产品 gate。

## Dependencies

- None. R0 is the source/doc preflight for ALA-R1 through ALA-R12.
- Must read current handbook invariants before changing task-card claims.

## Parallel With

- None for root-card normalization or source classification changes.
- Downstream implementation cards may start only after R0 source/classification
  checks are closed.

## Write Ownership

- `docs/v0.1/task-cards/**` task-card schema, source references, source
  classification, and implementation subcard wording.
- Do not edit handbook, archive, implementation/source files, generated state,
  or v0.1 parent docs from this card lane unless a parent task assigns it.

## Acceptance

- 没有把 source gap 写成产品方向阻塞。
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

## Implementation Subcards

### ALA-R0.1 - Source Reference Audit

#### Scope

核对 ALA-R0 到 ALA-R12 的 source references，补齐缺失的 do-what-new
来源，并删除会把 archive/prototype 或未核对内容冒充 current truth 的引用。

#### Source References

- `source-backed`: 本卡 Source References 与 `docs/v0.1/extraction-ledger.md`
  的抽取源优先级。
- `alaya-adapted`: 引用可来自 do-what-new 代码、handbook、brief、report；
  进入 Alaya 后必须改写为独立 package 语义。

#### Acceptance

- 13 张根卡都有已核对 source references。
- 绝对 do-what-new 路径存在，行号在文件范围内。
- R12 明确只聚合前置卡与 gate/report 纪律，不伪装为 do-what-new 产品同款。

#### Verification

- Validate absolute source references exist and line numbers are in range.
- Read-only review source line intent against each card's acceptance text.

#### Review Lens

- source evidence completeness。
- current-truth vs archive boundary。
- cross-card consistency。

#### Stop Conditions

- 如果 source 不存在或语义不支持 acceptance，先补查 do-what-new，再改卡片。
- 如果只有 Alaya 产品体验默认值可支撑，移到 defaults 或标成 `alaya-default`。

### ALA-R0.2 - Source Classification Blocks

#### Scope

为每张根卡追加 source-backed、alaya-adapted、alaya-default 分类说明，写清
继承点、改写点和禁止误用点。

#### Source References

- `source-backed`: `docs/v0.1/extraction-ledger.md` 状态标记与抽取账本。
- `alaya-adapted`: 本仓库 handbook 的 reset/extraction 和 package boundary。

#### Acceptance

- 每张根卡都有 `## Source Classification`。
- 弱来源区域明确标为 `alaya-adapted` 或 `alaya-default`，不写成阻塞问题。
- R2/R6/R7/R8/R9/R10/R12 的适配边界被单独点明。

#### Verification

- `rtk rg -n "## Source Classification" docs/v0.1/task-cards`
- Review known weak-source areas for explicit `alaya-adapted` /
  `alaya-default` language.

#### Review Lens

- domain language。
- adaptation honesty。
- product default containment。

#### Stop Conditions

- 如果分类会改变根卡目标，先停下修 R0/R12 汇总关系。
- 如果新增产品默认值，先确认它是否真的属于
  `product-alignment-defaults.md`。

### ALA-R0.3 - Stale Decision Framing Cleanup

#### Scope

清除 source gap 等于产品方向阻塞、旧 keychain-first、临时版本措辞等会误导
后续实现的文档表述。

#### Source References

- `source-backed`: `docs/v0.1/extraction-ledger.md` 的默认动作和状态标记。
- `alaya-default`: `product-alignment-defaults.md` 的 secret、Attach/Profile、
  Gateway 与 benchmark 默认值。

#### Acceptance

- 不再出现把 source gap 写成用户决策阻塞的表述。
- secret 口径统一为 abstract secret refs + env/local-file adapter；OS keychain
  保持后置。
- 计划文档不使用临时体验措辞描述 v0.1。

#### Verification

- Run the ALA-R0 stale-marker scan across `docs/v0.1` and `docs/handbook`.
- Targeted scan for keychain-first wording.

#### Review Lens

- docs truth hygiene。
- operator decision boundary。
- default drift。

#### Stop Conditions

- 如果一个表述确实需要 HITL/operator confirmation，保留但写成治理确认，
  不写成 source extraction 阻塞。

### ALA-R0.4 - Final Diff Summary And Defaults Confirmation

#### Scope

完成最终 diff summary，确认只触碰文档层，并列出仍由
`product-alignment-defaults.md` 集中管理的产品默认值。

#### Source References

- `source-backed`: git diff 与 task-card README 执行原则。
- `alaya-default`: centralized defaults table。

#### Acceptance

- diff 只包含 docs reset/extraction 范围内的文档变更。
- product defaults 没有散落成根卡内的新未确认决策。
- closeout 清楚说明未运行 build/test 的原因。

#### Verification

- `rtk git diff -- docs/v0.1 docs/handbook`
- `rtk git status --short`
- Docs-only verification commands from ALA-R0.1 through ALA-R0.3。

#### Review Lens

- scope control。
- evidence-backed closeout。
- no implementation drift。

#### Stop Conditions

- 如果 diff 出现实现代码或 archive prototype 迁移，停止并回滚本次不该有的编辑。
