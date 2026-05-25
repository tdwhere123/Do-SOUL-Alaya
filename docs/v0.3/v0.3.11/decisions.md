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
