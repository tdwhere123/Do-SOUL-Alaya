# v0.3.10 Synthesis-in-Recall 复盘

> 复盘对象:把 L2 `synthesis_capsule` 接入召回投递的这一轮工作
> (codex 初版 → 主线程 review → 根因诊断 → C 方案重做 → 双 benchmark 验证)。
> 目的:留一份诚实记录,供后续反思。日期:2026-05-22。

## 1. 背景

L2 synthesis 层在 S4 被"唤醒"(能创建 `synthesis_capsule` 行、有 FTS 索引),
但召回从不竞争性地使用它 —— §24 把这点记为"核心问题"。本轮目标:让 synthesis
真正能通过召回投递给 agent。

## 2. 第一次尝试(codex 初版)及其结构性错误

codex 的方案:把 synthesis 当作**融合管线里多出来的一条流**(`synthesis_fts`,
权重 8),synthesis 候选作为 coarse candidate 进入 fusion,和 memory 一起排序。

**这个模型结构上行不通。** 融合用 RRF:每条流的贡献是 `weight/(k+rank)`(k=60)。
一个 synthesis 候选只在 `synthesis_fts` 一条流上有信号,所以它的融合分**天花板**
就是 `8/(60+1) ≈ 0.131`。而一个 memory_entry 在 ~6 条流上累加(existing_score
权 8、evidence_structural_agreement 权 6、evidence_fts 权 3、lexical_fts ……),
轻松到 0.27+。实测:最强 synthesis 融合分 0.131,第 10 名 memory 0.27,第一条
synthesis 排在 ~84/229 名。**synthesis 一条都投递不出去。**

RRF 天生奖励"出现在多条流里"的候选;synthesis 只有词法 FTS 一种信号。"多加
一条流"对单信号对象类型无效 —— 提高权重也不行(权重再高,单流上限仍是
`weight/(k+1)`,且会变成对 memory 不公平的"无依据加成")。

## 3. 诊断过程(留作方法记录)

1. 第一次 500q bench:`fusion-rrf-synthesis-v2` 与 `fusion-rrf-v1` 基线**完全持平**。
2. 翻 19 MB 召回诊断:`synthesis_capsule` 出现 **0 次** —— synthesis 在被测路径
   上是死的,"持平"是因为特性没跑起来,不是"无害验证通过"。
3. 逐层排除:synthesis 确实被 seed(每题 42–49 条)、FTS 可查、`synthesisSearchPort`
   已接入 —— 都正常。
4. 加探针:`collectSynthesisCoarseCandidates` 每题收集 44 条 synthesis 候选、
   `synthesisFtsRanks` 正确喂进打分器 —— 收集端没问题。
5. 探针下移到融合后:44 条 synthesis 进 `assessCoarseFilter`,0 条出。打印融合分:
   最强 synthesis 0.131,与 RRF 单流上限 `8/61` 逐位吻合 —— 根因锁定。

**方法教训:** 一个"bench 持平"的结果,在没确认特性真的执行过之前,不能当作
"中性验证通过"。诊断必须一路追到"特性在被测路径上确实生效"。

## 4. 重做:预留槽位(C 方案)

放弃"竞争融合",改为**显式预留**:

- `reserveSynthesisDeliverySlots` —— 按 synthesis FTS 相关度取前
  `SYNTHESIS_DELIVERY_RESERVE`(2)条,放在投递预算窗口的**尾部**。尾部放置 →
  头部高排名 memory(LongMemEval gold 形态)不被挤掉。
- 连带修复:synthesis summary 是 ~4000 字的 L2 digest(~1000 token),2 条撑爆
  `max_total_tokens`。`buildSynthesisCoarseRecallCandidate` 现在把投递内容裁到
  600 字预览(`SYNTHESIS_RECALL_PREVIEW_CHARS`);FTS 仍索引全文。
- `synthesis_fts` 融合流保留,但只用于"synthesis 行之间排序"以挑预留对象;它对
  跨类型投递已不起作用(预留覆盖)。

诚实定性:预留是**尽力而为的条目数保证**,不是硬投递保证 —— 紧 token 预算下
尾部 synthesis 仍可能被 `max_total_tokens` 挤掉。是 v0.3.10 的务实机制,不是终态。

## 5. 双 Benchmark 验证(embedding-off / no-LLM)

| benchmark | 指标 | v1 基线 | v2 预留版 | Δ |
|---|---|---|---|---|
| LongMemEval-S 500q | R@1 | 57.2 | 56.8 | −0.4 |
| | R@5 | 81.0 | 81.0 | 0 |
| | R@10 | 85.6 | 85.0 | −0.6 |
| LoCoMo 1982q | R@1 | 22.0 | 22.1 | +0.1 |
| | R@5 | 42.4 | 42.3 | −0.1 |
| | R@10 | 56.3 | 56.3 | 0 |

**结论:synthesis 预留在两个 benchmark 上都是 recall-neutral —— 零回退,也零实测正收益。**

零正收益的原因不是机制,是**评测口径**:LongMemEval 和 LoCoMo 的 gold 答案都是
memory_entry id;synthesis_capsule 是 bench 自己 seed 的 L2 聚合,**永远当不了
gold**,所以 recall@k 这把尺子结构上量不到它的价值。LongMemEval R@10 −0.6 是
预留 2 槽让出的 memory 槽位的预期成本(噪声带内)。

synthesis 召回的真实价值只会在"答案本身就是跨证据综合"的工作负载里体现,而
当前两个 benchmark(按现有 gold 口径)都不测这个。

## 6. 反思点

1. **"多加一条流"不是万能扩展点。** RRF / 多信号融合奖励多信号候选;对只有单一
   信号的对象类型(synthesis 只有词法),融合流模型结构性失效。新对象类型进召回
   前,先问"它有几种可比信号"。
2. **bench 持平 ≠ 验证通过。** 必须确认特性在被测路径上真的执行过(本轮
   `synthesis_capsule` 在诊断里 0 次,才暴露问题)。
3. **评测能不能 credit 这个特性,要先想清楚。** 给 synthesis 做召回投递,却用
   gold=memory_entry 的 benchmark 去测 —— 注定测不出价值。下一波要先有
   synthesis-aware 的评测,再谈"synthesis 召回有没有用"。
4. **大改动必须自带 bench。** codex 的 46 文件改动初版一次 bench 都没跑;是
   "bench 当反馈环"这条纪律(commit 前必跑)把它挡下了。
5. **诚实记录优于乐观叙事。** 本特性 ship 为 recall-neutral 的基础设施,decisions/
   release-notes 如实写,不吹成"提升"。

## 7. v0.3.11 待办

- 给 synthesis 一个**可与 fusion 比较的打分信号**,让它按价值排位、而不是靠
  尾部预留(预留是 stopgap)。
- 一个**能 credit synthesis 的评测** —— 否则 synthesis 召回的价值永远无法量化。
- `SYNTHESIS_DELIVERY_RESERVE` / `SYNTHESIS_RECALL_PREVIEW_CHARS` 从模块常量
  迁到 recall policy 配置。
- `CoarseRecallCandidate` 的 synthesis 伪 `MemoryEntry` 形态(伪造 dimension/
  source_kind/formation_kind)改成 discriminated union,让编译器强制"按 objectKind
  分支",而不是靠 `scoreRecallFusionStream` 的 fail-closed 护栏 + 注释。
