# v0.3.11 Decisions

逐条记录 v0.3.11 release 期间影响产品方向 / 架构 / KPI 的关键决策。新决策 append，
不修改已有决策（可标 SUPERSEDED）。

## D1 — phase 0/1/2 自研 hygiene damp 保留不动（2026-05-24）

phase 2 累积 5 commits（B2 evidence-gist rerank + 3 道 hygiene damp + per-memory cap +
distinct-query-token 公式）已 merge 进 main（commit `01182a7`）。bench 实测 R@5
（LongMemEval-S 82.4% / multiturn 85.0% / LoCoMo 43.6%）距 90% 目标差距 ≥ 7.6pt。

**决定**：phase 0/1/2 保留不动；后续 phase 不在 hygiene damp 上继续自研。

**用户原话**：phase 2 自研代码"保留不动"（确认）。

**rationale**：8 轮 review-loop 已 settle，撤回成本高于保留成本；hygiene damp
不会被新 phase 反向影响（数据流隔离干净，architect-reviewer 已 sign off）。

## D2 — phase 3 自写 235 行 LocalOnnxEmbeddingClient 保留（2026-05-24）

vs fastembed-js 净差别仅 ~50 行（85% 是 Alaya 独家适配代码：
EmbeddingProviderPort 接口实现 / providerKind 区分 / isAvailable circuit
breaker / test seam / offline mode 强制）。

**决定**：保留 phase 3 现有 235 行实现，不换 fastembed-js。

**rationale**：换 dependency 不降复杂度；现有代码已 review + test 覆盖。

## D3 — 嵌入模型保持 `paraphrase-multilingual-MiniLM-L12-v2`（2026-05-24）

候选对比：agentmemory 用 `all-MiniLM-L6-v2`（英文，22M，384 维）；Alaya 选
多语版 L12（118M，384 维，多语含中文）；BGE-M3（多语 + 1024 维，更大更准）。

**决定**：保持 `paraphrase-multilingual-MiniLM-L12-v2`（多语轻量最佳）。

**用户原话**：嵌入模型"肯定是用多语言，这个不变，就的多语言中比较轻量化的"。

## D4 — R@5 ≥ 90% 三 bench 目标不撤（2026-05-24）

v0.3.10 D19 → D20 教训：设"对标 AgentMemory 95%"→ 一步步推成 RAG clone →
撤回。v0.3.11 表面上重蹈覆辙的风险，但路径不同：

- D19 的失败链：KPI 设 95% → 自研 cross-encoder rerank → 自研 lexical synonyms
  → 一步步变 RAG clone
- v0.3.11 的修正路径：KPI 设 90% → **学 agentmemory 外围实现 + 不动 Alaya
  核心**（不自研召回算法精雕）

**决定**：R@5 ≥ 90% LongMemEval-S / multiturn / crossquestion + LoCoMo
embedding-off ≥ 55% / embedding-on ≥ 90%——是 ship gate，不撤。

**用户原话**："三 bench 这个不撤回，这个是我们要做的一个很大的目标，就是要
证明我们可用。包括还有 token 的节约程度"。

**防 D19 重蹈**：任何阶段决策若触发"对标 95%倒推必须 X"模式必须停下来；参照
memory [[project_v0311_pivot_to_agentmemory_learning]] 锁住核心边界。

## D5 — Token efficiency = per recall call 记录，先 measure 不 brand（2026-05-24）

agentmemory 用"~170K tokens/year / ~$10/yr"宣传。Alaya 等价 metric 待定。

**决定**：per recall call instrument tokens（input / output / cache hit / fusion
stream 召回数 / final delivered context tokens），结果进 bench-runner kpi
schema + bench-history archive。

**用户原话**："我们按每轮吧，这个我觉得是我们先记录，然后后续再看怎么定宣传"。

**防 D19 重蹈**：token efficiency 是量化 must，但**先 measure 不 brand**——避免
"数字驱动设计"反模式。

## D6 — Phase 4 abstention 在 v0.3.11 内做（2026-05-24）

原 plan 已定。不推迟到 v0.3.12。

**用户原话**："Phase 4 abstention — v0.3.11 内做" 都在 v0.3.11 做。

## D7 — 多语 BM25 (CJK via jieba) 在 v0.3.11 内做，必须（2026-05-24）

研究方案：`splitLexicalTokens` 接 `@node-rs/jieba` + 5 字符集 tokenizer
（Greek / Cyrillic / Hebrew / Arabic / accented Latin），对齐 agentmemory。
storage 侧 FTS5 `unicode61` + 自定义 tokenizer。

**决定**：v0.3.11 phase 5。不推迟。

**用户原话**："我们多语言是必要的"，"不要推到 v0.3.12"。

## D8 — Phase 6 Graph 升级 4 子工作流全做（2026-05-24）

3 个并行 subagent 调研 confirm graph 是空的（公开 bench plane 0% 触发）。
A (entity 入口) / B (自动建边) / C (降门槛) / D (路径权重) 全在 v0.3.11 phase 6。

**用户原话**：4 类 auto-trigger（B-1 cross-link / B-2 LLM supports / B-3
supersedes / B-4 ConflictDetection 改 propose）"都做"。

## D9 — raw_payload 5 个 ref key 提升为 first-class，不考虑反向兼容（2026-05-24）

C2 改造把 raw_payload 5 个 ref key 提升为 `CandidateMemorySignal` first-class
字段（让 attached agent 知道字段存在）。protocol 变动。

**决定**：动 protocol 不考虑老 signal 兼容（breaking change ok）。

**用户原话**："老的可以不用考虑吧，因为我们产品没有上线的"。

## D10 — D-1 bench fixture 注入 `derives_from` 不算 bench-specific patch（2026-05-24）

bench-runner `compile-seed.ts` 用 LongMemEval session_id 邻接句天然派生
`derives_from` edge。按 [feedback_no_benchmark_specific_patches] 的"holistic
设计修正"标准评估：任何 conversational memory 系统都该把同 session 邻接句
视作 derives_from 关系——这是 holistic 合理，不是为某个 bench 调常数。

**决定**：D-1 实施，bench fixture 注入是 v0.3.11 phase 6-D 一部分。

**用户判断**：同意"按调研方案来"，并补充：edge **腐化"不是根本"**——edge
语义稳定（与 plasticity 衰减不同），auto-build 后不需要 expire/decay
机制。

## D11 — Auto-accept edge proposal 阈值 = system policy（2026-05-24）

防 prompt injection：自动建边 trigger 计算的 confidence 是 server-side
metric（trigger 内部计算），agent self-report confidence 一律 clamp ≤ 0.5
不参与 auto-accept 判断。

**决定**：B-1 floor 0.8 / B-2 0.85 / B-3 0.9 / B-4 0.9（initial，可调）。

## D12 — 每 phase review-loop 流程不动（2026-05-24）

每 phase 完成后跑 reviewer + red-team-reviewer 双 lens（必要时
architect-reviewer / code-quality-cleaner / install-release-reviewer 等），
zero Blocking/Important 才 merge。

**用户原话**："每个 phase 的 review 流程不要改就好。我会发现问题的时候自主
打断你的，你发现关键决策再找我就好"。

**编排原则**：主线程做 orchestrator 派 subagent 实施 + review；用户主动监督
+ 主线程在关键决策（KPI 调整 / 红线触线 / phase pivot / breaking change）
时主动找用户。

## D13 — Wave 编排（2026-05-24）

```
Wave 1: phase 3 收尾 (embedding-on bench + merge) + 主线程写 v0.3.11 docs
Wave 2: A entity 入口 + D-1 bench fixture + Phase 5 多语 BM25 + Phase 7
        token measure（4 线并行 3-4 worktree，互不依赖）
Wave 3: B+C 自动建边 + 降门槛（依赖 Wave 2 A 落地后才有 entity 共现统计）
Wave 4: D-2/3/4 召回路径合并 + Phase 4 abstention + closeout
```

## D14 — v0.3.11 当前只标 implementation checkpoint（2026-05-25）

`621fcec` / `8d2cbf7` / `8bf07c8` / `96e9bb9` 已在 `v0.3.11-completion`
落地 governance/bench integrity、multilingual BM25、two-hop graph diagnostics、
weak-evidence abstention calibration。

**决定**：docs/README/status surface 只能声明 implementation checkpoint /
evidence pending；不得声明 final release-ready、full evidence passed、或所有
B1/B2/I1-I9/N1 已最终 close。

**rationale**：full public benches 尚未在 HEAD `96e9bb9` 跑完，tracked
`latest-baseline*` 指针是 legacy/stale baseline，不是当前 release evidence。

## D15 — v0.3.11 evidence pointer 与 artifact hygiene 语义（2026-05-25）

artifact-hygiene worker staged 删除 23 个旧 full diagnostics；这些 deletion 只说明
release/source surface 清理，不是 KPI/report/pointer evidence。

**决定**：后续 full bench write 必须使用 `latest-run*` 记录 newest run；只有无
findings 且 executable hard gates 通过的 archive 才能推进 `latest-passing*`。
`latest-baseline*` 只保留 legacy alias 语义，不可作为 current HEAD `96e9bb9`
release evidence。

**local_onnx note**：LoCoMo embedding-on gate 仍要求 local ONNX model cache；当前
cache 缺失，必须由 parent supply/fetch 后再跑。

## D16 — B-2 当前是 rule heuristic，Phase B 重做 LLM 真版（2026-05-26）

**背景**：Phase 0 codex worktree audit 揭示
`packages/core/src/path-graph/edge-auto-producer-service.ts:224-238` 的 B-2 实现是
rule-based confidence（`confidence(features, 0.55, ..., 0.85)`），不是
`phase-6-graph-plan.md §B` + D8 / D11 锁定的 LLM pair classifier。
finding B0-2 / I0-7 关联。

**决定**：v0.3.11 Phase B 重新实施 B-2 LLM 真版，走 garden compute 本地
路径（K4.5 零云保持，本地 ONNX pair classifier 或本地 LLM 作首选）；
rule heuristic 降级为 LLM unavailable 时的 fallback，标位 `local_supports`
trigger source（见 D20 编排）。

**影响**：K3.3 `supports` 边生产者 ≥ 1 在 bench 跑前不可达，必须先完成
LLM path；Phase B subagent 编排必须显式包含 B-2 LLM 子任务，不得只
扩 heuristic。`decisions.md` 此前未记录此 silent downgrade——以本条
为准。

## D17 — commit `8bf07c8` 实际是 D-2/D-3/D-4 实施，不是 diagnostics-only（2026-05-26）

**背景**：commit subject "add two-hop graph expansion diagnostics" 低
估了 diff 实质。`packages/core/src/recall-service.ts:143,149,200,1449,1501-1503,1535`
实际改动包括 `graph_expansion: 1 → 3` fusion weight、2-hop BFS scoring、
per-edge-type hop_decay 表（`derives_from: 0.6, recalls: 0.3, supports: 0.5`）。
finding B0-4 关联。

**决定**：Phase 6 完成度表里把 `8bf07c8` 重标为 "D-2/D-3/D-4 code landed；
常数为 `phase-6-graph-plan.md §D` decay-table 初始 prior；bench-validated
calibration pending Phase E full bench + Phase F holistic tuning"。这
**不是**违反 [feedback_no_benchmark_specific_patches]——是设计原则给的
初始权重，Phase F 才允许基于 diagnostic 数据微调。

**影响**：Phase D 不再重复实施 D-2/D-3/D-4（避免重复 land）；Phase D
只做 D-5 multi-seed fan-in fuse；D-6 weight 校准延至 Phase F holistic
tuning。

## D18 — C 子工作流 v0.3.11 范围 = C1/C2/C7；C3 推 Phase C；C4 由 B-2 覆盖；C5/C6/C8/C9/C10 推 v0.3.12（2026-05-26）

**背景**：finding C§G2 / N1 揭示 `phase-6-graph-plan.md §C` 子工作流并
未全部 land。本条锁定 v0.3.11 实际范围。

**决定**：

- **v0.3.11 内做**：C1 entity 入口（已 land in `9dcfb09`）、C2 ref keys
  first-class（已 land；I0-3 raw_payload 残留 FIX-0-6 收尾）、C7 文档化
  trigger 边界。
- **Phase C 内做**：C3 默认开 `ConflictDetectionService` rule path
  （I0-4，依赖 B-4 proposal path）。
- **由 B-2 覆盖**：C4 `supports` 自动建边 = D16 的 B-2 LLM 实施。
- **推 v0.3.12**：C5（confidence floor 自适应）、C6（recall feedback
  loop）、C8（auto-decay timer）、C9（cross-session edge dedupe）、
  C10（admin review UI）。每项 close condition = v0.3.12 release
  closeout 时由该 release 的 decisions.md 记录实施状态。

**影响**：v0.3.11 Phase G closeout report 不可声明 C5/C6/C8/C9/C10 完成；
读者引用 `phase-6-graph-plan.md` 时以本条为 v0.3.11 实际范围权威。

## D19 — commit "Closes X" 措辞不构成 release evidence；以 docs 为权威（2026-05-26）

**背景**：finding I0-8 揭示 commit messages 与 docs 状态不一致：例如
`9dcfb09` "Closes the v0.3.11 phase-6 subworkflow A"、`3d07077` "Closes
v0.3.11 Tier 2 KPI K2.1" vs `README.md` / `kpi-targets.md` 显式标
"evidence pending"。

**决定**：v0.3.11 及之后 release，acceptance 权威源 = `kpi-targets.md`
+ `bench-history` archive（full bench 实测 evidence），**不**以 commit
message 的 "Closes" 措辞为权威。Phase G closeout report 必须以 evidence
archive 重新声明 actually closed scope。未来 commits 应避免 "Closes" /
"Resolves" 措辞，除非对应 evidence 已 archive；改用 "implement" /
"land" 描述代码动作。

**影响**：git log 历史不修改（避免风险）；读者引用 git log 推断完成度
时需先回查 `kpi-targets.md` + archive。

## D20 — Phase 0 audit fix 编排（2026-05-26）

**背景**：Phase 0 三 reviewer 并行审 + 主线程合并去重得到
`.do-it/findings/v0.3.11-codex-audit.md`，含 4 Blocking + 8 Important
+ 4 Nice-to-have。本条锁编排，防 Phase A 起跑前再次漂移。

**决定**：

- **Phase 0 fix-loop 内完成**：
  - FIX-0-1 release-gate seed_extraction_path 评估（B0-1，typescript-pro
    + test-automator）
  - FIX-0-2 `decisions.md` D16-D20 追加（B0-2 / B0-4 / I0-8，本批
    documentation-engineer）
  - FIX-0-3 narrow `WEAK_EVIDENCE_PRIOR_WEIGHT_FLOOR` gate 至 abstention
    candidates only（B0-3，typescript-pro）
  - FIX-0-4 ~ FIX-0-7（I0-1 / I0-2 / I0-3 / I0-7，typescript-pro bundle）
- **延 Phase B**：I0-5 K3.2 / K3.4 KPI schema instrument，与
  `edge_proposals` 表聚合逻辑耦合。
- **延 Phase C**：I0-4 `ConflictDetectionService` 默认开（依赖 B-4
  proposal path 落地）。
- **延 Phase G**：I0-6 attach/replay token_economy surface 增字段
  （surface change，非 gating）。
- **Nice-to-have**：A§N-1 / A§N-2 / A§N-3 / B§N1 在 typescript-pro
  bundle 内顺带处理；A§N-4 不修历史 commit。

**影响**：FIX-0-* 全部 land 后重派 reviewer + codex-rescue 复审；zero
Blocking / Important 才放行 Phase A 启动。Phase B / C / G 启动前
必须确认各自延期项已 enqueue。

## D21 — C3 ConflictDetection 默认开提前在 Phase 0 fix-loop 落地（2026-05-27）

**背景**：D18 声明 C3 "默认开 `ConflictDetectionService` rule path"
属于 "Phase C 内做"。spec-compliance review §"Silent scope drift
findings #2" 指出 commit `bc6152a` 已在 Phase 0 fix-loop carry-forward
阶段就把默认翻转 land 了，时机早于 D18 描述。

**决定**：以本条记录 C3 实际 landing 时机为 commit `bc6152a`
（Phase 0 fix-loop carry-forward），不是 Phase C；D18 的范围归属
（C3 在 v0.3.11 内做）不变，只是 landing 时机被提前。

**rationale**：C3 始终在 v0.3.11 scope 内，未发生 silent scope drift；
但 D14 / D15 honesty 要求所有 release 期内的实际 landing 时机
必须 traceable，本条补齐 audit 链。后续 Phase G closeout report
引用 C3 时直接用 `bc6152a`，不再用 "Phase C 内完成" 描述。

**引用 finding**：spec-compliance review §"Silent scope drift
findings #2"。

## D22 — C7 health_inbox + EventLog audit 推 v0.3.12 release（2026-05-27）

**背景**：`phase-6-graph-plan.md §C` C7 锁定 "edge 创建失败 →
`health_inbox` 写入 + `SOUL_GRAPH_EDGE_REJECTED` EventLog 类型"
作为 v0.3.11 范围。spec-compliance review §"Silent scope drift
findings #1" 指出 v0.3.11 实际只完成 raw_payload normalize 删除
（I0-3 收尾），未实现 health_inbox 写入和 audit event 落地。

**决定**：明确推 v0.3.12 close condition：v0.3.12 release 必须实现
（a）edge 创建失败时写入 `health_inbox`；（b）EventLog 增加
`SOUL_GRAPH_EDGE_REJECTED` 类型并在失败路径发射。v0.3.11 范围内
C7 只声明 "trigger 边界已文档化 + raw_payload normalize 已 land"，
不声明 audit 链完整。

**rationale**：v0.3.11 范围已经很大（Phase 6 graph 升级 + 多语
BM25 + abstention + token measure）；C7 audit gap 不阻塞 K3.x KPI
（K3.1 / K3.2 / K3.3 / K3.4 都是 edge 生产与召回度量，不依赖
失败路径 audit）；edge 创建失败本身在当前实现里已经 throw +
log，truth boundary 未受损——只是缺 governed audit surface。
deferral 走 D14 / D15 honesty 原则记录，由 v0.3.12 decisions.md
报告实施状态。

**影响**：v0.3.11 Phase G closeout report 不可声明 C7 完成；只能
声明 C7 子集 land；release notes 需点名 health_inbox + audit
event 推 v0.3.12。

**引用 finding**：spec-compliance review §"Silent scope drift
findings #1"。

## D23 — v0.3.11 release notes 必须显式声明两个默认-on 翻转（2026-05-27）

**背景**：v0.3.11 涉及两个生产 daemon 行为翻转：
（1）commit `bc6152a` 把 `ConflictDetectionService` 默认开
（rule path）；（2）commit `06fd18f` 把
`ALAYA_EDGE_PRODUCER_LLM_ENABLED` 默认 on。两者都是从 opt-in 翻成
opt-out 的运维行为变化。reviewer review §"Important #3" 指出
release notes 若不显式声明，下游 operator 升级到 v0.3.11 后会在
不知情情况下触发新的 conflict propose / LLM edge produce 路径。

**决定**：Phase G release notes 必须显式声明这两个翻转 + 各自
opt-out env 名字：

- `ConflictDetectionService` 默认开 → opt-out 环境变量
  （Phase G 收尾时按 commit `bc6152a` 实际暴露的 env 名记录）；
- `ALAYA_EDGE_PRODUCER_LLM_ENABLED` 默认 on → opt-out 时显式设为
  `0` / `false`（commit `06fd18f`）。

**rationale**：D14 / D15 honesty + 运维稳定性双重要求。默认翻转
不显式声明等于 silent prod behavior change，违反 invariants §27
（governance / configuration / import/export / backup / session
trust changes are auditable）所导出的运维公平原则。

**影响**：Phase G release notes worker 必须在产出 draft 时把这两
段 opt-out 说明落到 release notes 第一屏；review 复检时把
"两个 default-on 翻转是否在 release notes 显式声明" 列入
Important 级 checklist。

**引用 finding**：reviewer review §"Important #3"。
