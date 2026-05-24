# v0.3.11 Plan — 学 agentmemory 外围实现 + 不动 Alaya 核心

## 概要

v0.3.11 把"记忆系统在公开 benchmark 上 ship-grade"的目标保持不变（R@5 ≥ 90%
三 bench + token efficiency 量化），但把**实现路径**从"自研召回算法精雕"转向
"学 agentmemory 外围 + 不动 Alaya 核心"。

phase 0/1/2 已 merge 进 main（commit `01182a7`），实测 R@5：
LongMemEval-S 82.4% / multiturn 85.0% / LoCoMo 43.6%。距 90% 目标缺
~7.6 / 5 / 46 pt。靠 phase 3 (embedding-on) + phase 5 (多语 BM25) +
phase 6 (graph 升级) + phase 7 (token measure) 补齐。

## 方向修正缘由

参照 v0.3.10 D19→D20 教训（设"对标 AgentMemory 95%"→ 一步步推成 RAG clone
→ 撤回）。v0.3.11 phase 1+2 也走在同一路径上：8 轮自研 hygiene damp / distinct-
query-token 公式 / B2 evidence-gist rerank 等，**净增益仅 +0.6 ~ +1.6pt**，
远不如 agentmemory 同栈直接干到 95.2%。

关键差距源（不是算法精雕能补的）：
- 多语 BM25 缺失（agentmemory 5 字符集 + jieba CJK，Alaya 只 ASCII / 拉丁）
- 本地 embedding 未默认接通（agentmemory 默认开，Alaya phase 3 实施完未 merge）
- Graph retriever 缺自动入口（Alaya 7 种 truth-relational edge 比 agentmemory
  entity co-occurrence 高质，但只能 seed → 1-hop，缺 query → entity → seed 入口）

## Alaya 核心边界（不能动 / 不学）

| 层 | 内容 | agentmemory |
|---|---|---|
| Truth boundary | propose / accept / reject + governance audit | ❌ |
| Memory ontology | evidence / source / conflict / synthesis / temporal / governance scope | ❌ |
| EventLog | auditable 全写 | ❌ |
| Plasticity / trust loop | confidence + plasticity watermark | ❌ |
| CLI 13 verbs governance | review pending / accept / reject 审计入口 | ❌ |
| Local-first / 零云依赖 | 同有 | ✅ |
| MCP attach pattern | 同有 | ✅ |

## 外围（可学可换）

embedding model / vector store / lexical retriever / fusion 公式 / graph retriever
/ rerank。学 agentmemory 实现，但 wrap 进 Alaya 现有 port (e.g.
`EmbeddingProviderPort`, `GraphExpansionPort`)，不让外部 commodity 渗进
truth boundary。

## Phase 切片

排序原则：能解耦的并行；改 query-side / 改 storage / 改 fusion weight 的工作
不互相阻塞。新 phase 全部 v0.3.11 内做，**不推到 v0.3.12**。

### Phase 0/1/2（已 merged）

不动。phase 2 自研 hygiene damp / distinct-query-token / B2 evidence-gist
rerank 等保留作 baseline（用户 2026-05-24 确认"保留不动"）。

### Phase 3 — 本地 ONNX embedding 接通（修订）

worktree `v0.3.11-phase3` HEAD `23a75d5` 已实施 235 行 `LocalOnnxEmbeddingClient`
（保留，与 fastembed-js 净差别 ~50 行，不划算换）。剩余工作：

- 模型预 fetch (`scripts/fetch-local-embedding-model.mjs`) 验证可重跑
- daemon provider 选择 (`ALAYA_EMBEDDING_PROVIDER=local_onnx`) 落地
- LoCoMo embedding-on bench → R@5 ≥ 90%
- embedding-off 路径与 phase 2 合并后位级一致（review-loop 显式 check）

验收：embedding-off R@5 不退化、embedding-on LoCoMo R@5 ≥ 90%。

### Phase 4 — WS-C abstention 弃答校准

放原 plan 位置不变。`recall-service.ts:2001` 弱信号压 `effectiveScore`，
abstention top-1 落到 `ABSTENTION_FALSE_CONFIDENT_THRESHOLD = 0.91` 之下。
四 bench 全集验证无连带回退。

### Phase 5 — 多语 BM25 (CJK + 多字符集)

`packages/core/src/recall-query-probes.ts` `splitLexicalTokens` 接 `@node-rs/jieba`
做 CJK 分词 + 5 字符集 tokenizer (Greek / Cyrillic / Hebrew / Arabic /
accented Latin)，对齐 agentmemory 实现。新建 `multilingual_lexical` fusion
stream 或扩展现有 `lexical_fts` 走多语 path。

storage 侧 `memory-entry-keyword-search.ts` FTS5 tokenizer 配套。FTS5 支持
`unicode61` + 自定义 tokenizer——具体 path 由实施 subagent 验证。

验收：LongMemEval-S 包含 CJK / 多语 query 子集 R@5 不退化；新加多语 fixture
回归测试。

### Phase 6 — Graph retriever 升级（4 子工作流）

用户 2026-05-24 原话："我们的路径轴这个，其实也应该有自动模式的，自动和手动
要并行，甚至应该让手动的要比较少才对。包括边的建立，也是应该多建立才对，
现在的现状是非常难建边。召回路径和权重也是，需要优化的。"

| 子流 | 内容 | 是否动 truth |
|---|---|---|
| **A. query-side entity 自动入口** | query → 抽 entity → 找带这些 entity 的 memory → 作为额外 seed 喂 graph_expansion | 不动 truth（query-time only，不写 graph） |
| **B. 自动建边（auto + manual 并行）** | propose/accept 之外让自动模式（LLM 推断 / 实体共现 / derives_from 自动推断）也产生 edge **proposal**，仍走 accept 流程审核 | 不动 truth（自动只产生 propose，accept 仍显式） |
| **C. 降手动门槛** | 当前"非常难建边"的具体阻力（schema 复杂 / verb 流程长 / proof 要求重 等）找根因 + 简化路径 | 视根因决定（如果是 governance 必要不动；如果是 UX 摩擦动） |
| **D. 召回路径 + 权重优化** | `graph_expansion` weight 1 偏低 / 多跳 BFS 缺失 / `MEMORY_GRAPH_EDGE_RECALL_WEIGHTS` 各 edge_type 校准 | 不动 truth |

A/B/C/D 具体方案待 3 个并行研究 subagent 报告（已派 2026-05-24）。

验收：LongMemEval 多 hop 子集 R@5 ≥ 90%（agentmemory 强项区域）；
edge 自动建立率提升（具体 metric 待 phase 6 plan 定）。

### Phase 7 — Token efficiency measurement

per recall call instrument tokens（input / output / cache hit / fusion stream
召回数 / final delivered context tokens）。结果进：

- bench-runner kpi schema 增字段
- `docs/bench-history/*` archive 含 token cost
- 与 agentmemory 报告口径对齐（~170K tokens/year 是 lifetime baseline，
  Alaya 等价 metric 待定）

验收：四 bench 全集运行后 token instrument 数据齐全；report 含 per-call
distribution；先 measure 不 brand。

### Closeout

`docs/v0.3/v0.3.11/`：
- plan.md（本文件）
- decisions.md（D1-DN 关键决策记录）
- kpi-targets.md（R@5 三 bench ≥ 90% must + token efficiency 量化 must）
- README.md（精简对外摘要）
- reports/（各 phase review-loop 报告 + bench 对比）

README + CHANGELOG 同步更新。

## KPI Targets（覆盖 v0.3.10 D20 立场）

| Tier | 指标 | must |
|---|---|---|
| 1 | LongMemEval-S R@5（500） | ≥ 90% |
| 1 | LongMemEval-S multiturn R@5（500） | ≥ 90% |
| 1 | LongMemEval-S crossquestion R@5（500） | ≥ 90% |
| 1 | LoCoMo R@5 embedding-off | ≥ 55% |
| 1 | LoCoMo R@5 embedding-on | ≥ 90% |
| 2 | Token instrument coverage | 四 bench 100% per call |
| 2 | Token cost per recall call | measure & publish（无 must 数字）|
| 2 | Edge auto-build rate (phase 6) | 待 phase 6 子工作流定 |
| 2 | Alaya-native invariants（trust loop / propose-accept 路径） | 0 回归 |

R@5 90% 三 bench 是 ship gate。token efficiency 是量化 must 但**先 measure
不 brand**——避免重蹈 v0.3.10 D19 "数字驱动设计" 坑。

## 风险登记

| Risk | 缓解 |
|---|---|
| 多语 BM25 引入新依赖 `@node-rs/jieba` | 评估 install / binary 大小 / Alaya 现有 fetch 模式；可选 fallback 纯 JS |
| Graph 自动建边可能污染 durable truth | 红线：自动只能产生 propose，accept 必须显式审核；不允许自动 accept |
| Token instrument 增加 recall latency | 同步采样 / 异步聚合二选一，preflight 测影响 |
| Phase 6 4 子工作流并行风险 | A/B/C/D 互相耦合（D 权重调优依赖 A/B 落地后的新候选分布），顺序 A → B → C → D |
| Phase 3 embedding-on bench 不到 90% | 提 `EMBEDDING_SIMILARITY_WEIGHT` + 调候选注入 K + 试 BGE-M3 备选 |
| 推回 v0.3.10 D19 老路 | 本文档 + memory [[project_v0311_pivot_to_agentmemory_learning]] 锁住；任何阶段决策若触发"对标 95%倒推" 必须停下来 |

## 实施顺序与并行

```
[已 merged] phase 0 → 1 → 2
[in flight] phase 3 (实施完未 merge，剩 bench + merge)
[next]      phase 4 / phase 5 / phase 7 (并行，互不依赖)
[after]     phase 6 (依赖 3 个研究 subagent 报告整合)
[final]     closeout (docs + bench archive + CHANGELOG + README)
```

每个 phase 独立 worktree，review-loop 后 merge → 下一 phase rebase。
