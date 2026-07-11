# Recall 根因与最大杠杆计划(2026-07-06)

> **ARCHIVED 2026-07-09** — superseded by `plans/claude/2026-07-09-recall-forward-after-concept-lock.md` + `plans/claude/2026-07-09-flood-path-slice-concept-lock.md`. Do not execute this card as active work.
>

> 基础材料:`.do-it/findings/card7-recall-full-gate-500q-2026-07-05.md`(仅作起点,本计划对其做了独立复核并部分推翻)。
> 数据源:`.do-it/bench-runs/.bench-artifacts/public/2026-07-05T161121Z-71749d1-policy-stress/longmemeval-diagnostics.json`(500Q 全量 per-question / per-gold 诊断,含 7 个 delivery 阶段的逐阶段 rank)。
> 复核脚本:历史 `.do-it/bench-runs/scripts/analyze-500q-miss-stages.py` 已在 2026-07-08 bench 脚本清理中删除;当前复核入口改为正式 `apps/bench-runner/scripts/replay-longmemeval-diagnostics.mjs` 与 guarded `.do-it/bench-runs/scripts/longmemeval-recall-cache-only-gate.sh`。
> 状态:**Active (engineering)** — Card E / F1b / I1 / flood hard-on / Card C code 已落地(见 worklog)。**概念重解释锁定 2026-07-09** → [`2026-07-09-flood-path-slice-concept-lock.md`](./2026-07-09-flood-path-slice-concept-lock.md)(path=边; flood 沿边; slice key; 遥远性=势能×输入力)。总目标不变。决策记录见 §6(2026-07-06 用户已拍板 D1/D3,D2 改向,D4 见分析)。

## 0. Card Metadata

| Field | Value |
| --- | --- |
| Card ID | `2026-07-06-recall-root-cause-and-levers` |
| Tier | Heavy |
| Target | 把 any@5 从 78.6%(gold-bearing 85.8%)推向产品级 90%,基于已证实的 miss 机制而非猜测 |
| Primary surfaces | `packages/core/src/recall`, `apps/bench-runner`, `.do-it/bench-runs` |
| Verification gate | 离线 replay 对账 → 100Q 抽查 → 500Q 全量门禁复跑 |

## 1. 独立复核结论(对 findings 文档的确认与推翻)

### 1.1 确认的判断

- 池子远强于投递:pool@100=87.9% vs coverage@5=30.8%,问题主要在最终排序/投递,不在候选缺席(candidate_absent 仅 6)。
- KPI merge 丢字段是纯实现缺口:`buildMergedKpi`(`apps/bench-runner/src/cli/merge-command-shards.ts:386-421`)从未写入 `full_gold_coverage`,而单 shard 路径(`runner-archive-payload.ts:200-203`)有;merged diagnostics 已经拼齐了全部 per-question 记录,补一行调用即可。
- graph_expansion 弱(hit@5 7%)有结构性原因:仅走 `derives_from/recalls/supports` 三类边、2 hop、fanout 12、种子置信度门槛 0.85、fusion 权重 3(vs embedding 12)。
- budget 门禁失败(35>8)与召回质量是两件事:真实 budget 致 miss 仅 6 题。

### 1.2 被推翻或需要修正的判断

**R1. "embedding 语义近邻挤占" 不是近窗 miss 的主导机制 — 方向弄反了。**

对 65 个 gold-bearing miss 按 best-gold 的 `rank_after_fusion` 分桶,再把 gold 与该题 rank-5 占位者的 per-stream RRF 贡献逐流相减:

| fusion 桶 | miss 数 | gold 相对 rank-5 占位者的贡献差(均值) |
| --- | ---: | --- |
| 6–10 | 27 | embedding **+0.0089**、lexical **+0.0044**,但 evidence_structural_agreement **−0.0117**、path_expansion **−0.0090**、evidence_fts **−0.0081**、source_evidence_agreement **−0.0063** |
| 11–25 | 16 | embedding **−0.0385** 主导,辅助流同样为负 |
| 26+ / >100 | 7 | 全面落后,含 4 个 rank>100 的深度失败 |

即:最大的可修桶(6–10,占 miss 的 42%)里,gold 在 embedding 和 lexical 上**赢过** rank-5 干扰项,输在 evidence/path/agreement 这些"辅助支持流"上。这些流的行为像**流行度先验**——在多个上下文里反复出现的对象积累更多 evidence/path 支持,把主题近邻干扰项抬进 top-5。`evidence_structural_agreement` 权重是 6(全表第二高,streams 表:`packages/core/src/recall/delivery/fusion-delivery-streams.ts:5-19`),是最大单一负贡献项。findings 文档说"embedding 主导一切所以怀疑语义挤占",混淆了"贡献绝对值大"与"造成排序差的边际项"。

**R2. 30 个 `_abs` 弃答全灭是纯校准伪 miss,机制已定位,占全题头条约 6.0pp。**

弃答判定阈值 `relevance_score >= 0.91`(`abstention.ts`,`ABSTENTION_FALSE_CONFIDENT_THRESHOLD`),而 `relevance_score` = `effectiveScore`(`fine-assessment-selection.ts:178`),是 clamp01 的加法分。实测 5000 条 delivered 结果里 **95.6% 恒等于 1.0**,rank-1 在 498/500 题上 = 1.0。阈值面对饱和分数永真 → 弃答题**结构上不可能通过**。这不是召回排序问题,是分数饱和 + 阈值设计问题。

**R3. "数学化 flood 模型"在本次跑分配置下是死代码——归因已由子代理溯源修正(2026-07-06)。**

死代码结论成立,但机制不是最初写的 slice 耦合。实际链条(全部 file:line 已核):

- `verifiedFloodFuel`(`integrated-flood-scoring.ts:113-119`)= `slice.value > 0 && path.countsAsFuel && evidence.countsAsFuel`。它**不读** `slice.countsAsFuel`;FACET_SLICE 关闭时 slice 是 `value=1` 的 pass-through,**不阻挡** fuel。
- 真正的门是 **path ∧ evidence 双燃料**,这是 Card 2 的有意设计(PR #11:"Fix: require path+evidence flood fuel"),不是接线事故(git 溯源:首版即如此)。
- 跑分中死掉的原因:path 燃料只来自 `answers_with` 关系(`path-relations.ts:108-114`,"only answer relations carry path inflow"),而开关 `ALAYA_RECALL_ANSWERS_WITH` 默认 off(`runner-question.ts:157-158`)→ `pathInflowByTarget` 恒空 → `path.countsAsFuel` 恒 false → AND 门恒 false。evidence 侧底物大概率存在(seed 每条都写 `evidence_refs`,`daemon-seed-operations.ts:176`),不是瓶颈。
- `beta=0` 是有意默认("Disable evidence beta until query-orthogonal support exists"),独立于 flood 生死。
- 测试没拦住是因为 warm 用例全部**手动注入** inflow/evidence vectors,绕开了 `answersWithPathFuelEnabled()` 门控;没有任何测试断言"默认 env 全量跑分应有 `fuel_verified_count > 0`"。
- 本次 500Q 诊断 `score_factors` 里无任何 flood/fuel/per-axis 字段(已实测),无法事后对账 fuel 覆盖——L5 观测缺口的又一实证。

结论:flood 数学与公式实现都没问题;死因是**跑分配置没供燃料**(ANSWERS_WITH off)。用户"数学没问题、是落地哪里逻辑不通"的直觉方向正确,但不通的点在配置/燃料底物,不在代码耦合。

**R4. 后融合 delivery 层堆栈整体是净零到净负的,且一半是恒 noop 的死层。**

对全部 458 个 gold-bearing 题的 best-gold 逐阶段追踪:

| 阶段 | promote 进 top5 | evict 出 top5 | 状态 |
| --- | ---: | ---: | --- |
| feature_rerank(top-50 重排) | 12 | 9 | 净 +3 |
| coverage_selector | 10 | 12 | **净 −2** |
| lexical_priority | 0 | 0 | 本次无效果 |
| session_coverage | 0 | 0 | **恒 noop(代码即恒等)** |
| synthesis_reserve | 0 | 0 | **恒 noop(reserve 数恒 0)** |
| structural_reserve | 0 | 0 | 默认 off |

65 个 miss 中有 **9 个是 fusion 时 gold 已在 top-5、被我们自己的后处理层踢出去的**(coverage_selector 6 个、feature_rerank 3 个)。整套"rescue 栈"的复杂度没有换来命中。

**R5. H1(fuel 饥饿)证伪。**

gold 对象的 per-stream rank 覆盖率:evidence_fts 90%、path_expansion 70%、graph_expansion 76%——gold 并不缺 fuel;top-5 非 gold 的覆盖率更高(98%/90%/84%)。问题是 H2 形态:**辅助流系统性偏向干扰项**,不是 gold 没有信号。

### 1.3 复核补充的新事实

- **单 gold 题是重灾区**:any@5 按 gold 数分层 = 1 个 gold 67.7%、2–5 个 87.0%、6–10 个 89.6%。ANY-of-N 评分掩盖了单对象精度的弱势;产品上"记住那一件事"恰恰是单 gold 场景。
- gold 判定是会话/轮级启发式(答案轮物化出的**所有** memory_entry 都算 gold,`deriveLongMemEvalGoldMemoryIds`),对象粒度不精确 → any@5 有虚高成分,full@5 有虚低成分,两个数都要带着这个脚注读。
- `question_type` 在数据集里有、recall-only 诊断里没持久化 → 无法按 temporal/knowledge-update/multi-session 分型定位,属于低成本高价值的观测缺口。
- 诊断产物已含逐流贡献与逐阶段 rank → **权重/门控类改动可以离线 replay,不必重跑 500Q**。这是迭代速度的关键事实。

## 2. 核心问题(一句话)

**排序天花板不是 embedding 也不是 flood 公式,而是:饱和的加法分之上,一组充当流行度先验的辅助"支持流"决定了近窗胜负,外加一整层净负/死的后处理和一个结构性必挂的弃答校准——三者互相掩盖,让头条指标无法归因。**

## 3. 最大杠杆(按期望收益排序,基数 = 全题 any@5 78.6%)

| # | 杠杆 | 上限 | 性质 |
| --- | --- | --- | --- |
| L1 | 弃答校准修复(真置信度信号替代饱和分阈值) | **+6.0pp**(30 题) | 机制已证,确定性高 |
| L2 | 辅助流再平衡:evidence_structural_agreement/path/evidence_fts 的权重或条件化(仅在与查询相关时计入) | **+5.4pp 上限**(6–10 桶 27 题) | 需 replay A/B 证实 |
| L3 | 分数去饱和(effectiveScore 95.6% 恒 1.0) | 自身不直接加分,但 L1 的前置,并让 tie-break、coverage 的 0.65 score-ratio 门恢复意义 | 结构修复 |
| L4 | delivery 栈裁剪 + flood 供燃实验(删死层;coverage_selector 修或关;`ANSWERS_WITH=1` 实跑验证,见 Card E) | +1~2pp,主要收益是可归因性与代码量 | 简化 |
| L5 | 观测与评测修复:merged `full_gold_coverage`、`question_type` 持久化、per_axis/flood 诊断透传、离线 replay 工具 | 0pp 直接收益,**所有后续迭代的速度杠杆** | 前置 |

11–25 桶(16 题,embedding 真输)和 graph 弱是第二梯队,收益/成本比低于上表,放 Phase 2。

## 4. 工作分解(Phase 1,五张卡)

**Card A — 离线 replay 工具(前置,L5)**
用 500Q 诊断里的 per-stream 贡献离线重算 fused rank,支持改权重/关流/改 RRF-k 后重打分,输出 any@5/coverage@5 差异。**必须复现 facetOverlapCount 字典序优先的真实排序键**(§7.3)与 `compareMemoryEntries` 的 tie-break 链(activation↓/created_at↑/object_id↑),否则对账必然漂移。**边界声明(Gemini 反思采纳)**:这是 scoring replay,不是 candidate-retrieval replay——凡改动候选抽取/图扩展参数的配置,冻结特征即失效,工具须显式拒绝或警告。先对账:默认参数下 replay 结果必须复现 393/458。当前实现入口是 `apps/bench-runner/scripts/replay-longmemeval-diagnostics.mjs`;不要再向 `.do-it/bench-runs/scripts/` 添加一次性分析脚本。

**Card B — 评测与观测修复(L5)**
1) `buildMergedKpi` 补 `full_gold_coverage`(调用已有 `buildLongMemEvalFullGoldCoverage(mergedQuestions)`);2) recall-only 诊断持久化 `question_type`;3) `freezeFusionBreakdown` / bench schema 透传 `per_axis_contribution`、`flood_potential`、`flood_fuel_coverage`;4) budget 门禁改成率基(绝对数 ≤8 在 500Q 尺度必挂,见 §6 决策 D3);5) **SemVer 检查(Gemini B3 采纳)**:所有 schema 改动先验证是否从 `mcp-types.ts` 传递可达(invariant §25 的判定标准是传递可达性,不是文件清单)——bench-runner 内部诊断 schema 大概率出界,但 `packages/core` 侧的 recall diagnostics 若触发 `semver-surface.test.ts` 快照移动,PR 必须引 §25 并声明版本步进。

**Card C — 分数去饱和 + 弃答校准(L1/L3,文献精读定稿)**
文献精读结论(MemTrace/STALE-CUPMem/GroupMemBench 全文,2026-07-06):三篇都没做过检索分的 Platt/isotonic 校准(该协议是我们的推断,需自证);但特征选择有强实证——STALE 实测 premise 失败时 old-top-1 占据率 84.5%、失败率 99%,**绝对分无效、排名主导性(margin)才是有效信号**;GroupMemBench 警示"假弃答"(Mem0 弃答 82.6% 靠保守存储而非校准拒答)。设计定稿:
- **信号**:`p_answerable` 用 top1-top2 margin、top1-top5 均值差、跨流覆盖度(多少条独立流支持 top-1)为主特征;归一 fused 分只作特征之一,禁止单独当规则。gold-plane 一致性仅限离线评测,runtime 不可用。**先验污染防护(Gemini I1 采纳)**:跨流覆盖度必须区分似然流(embedding/lexical/evidence-FTS)与结构先验流(structural/graph/path/agreement)——纯结构流支持的 top-1 是"流行度撑起来的假信心",特征集要加一个"似然流独立支持数"(仅数似然流),Card D ③ 落地 L 门控后再加门控分作为特征。注意 Gemini 论证里"似然流对 `_abs` 返回空"的前提对 embedding 不成立(稠密检索永远返回 top-k 近邻),所以单靠"似然流有没有命中"不是有效信号,margin 才是。
- **校准**:isotonic 在 470 个非弃答题上拟合;30 个 `_abs` 只做 hold-out 监控,**不参与阈值搜索**(每 fold 仅 1–2 题,必然过拟合);阈值用约束优化(最大化 answerable F1,约束弃答 recall ≥ 目标)。**负样本修正(Gemini 反思采纳,原设计有洞)**:阈值搜索空间里若完全没有负样本,"弃答 recall ≥ 目标"约束不可求值,最优阈值退化为"永不弃答"。修正:用**合成负样本**参与搜索——对答得出的题做 leave-gold-out 重放(从冻结特征里剔除 gold 行再算特征,得到"证据确实不在"的真负例),或跨题错配 query;30 个真 `_abs` 仍然完全 hold-out。
- **双边界结构**:本卡只实现边界 A(证据缺失→弃答);边界 B(前提为假→纠正)按 §7.7 第 3 条留 schema 位(`premise_invalid` 恒 false),Phase 2 实现——STALE 证明两者是不同能力(SR 92% 的系统 PR 只有 30%),混在一个阈值里必然失败。
- **验收**:30 个 `_abs` correct-abstain 显著 >0;**同时报告 answerable F1 变化与弃答/召回权衡曲线**,防"假高弃答"(把阈值调高到什么都拒)。先审 `computeEffectiveScoreDetails`(`scoring.ts`)饱和来源,确认 margin 特征在去饱和前是否已可用(fused 分未饱和,大概率可直接用)。

**Card D — 辅助流条件化 A/B(L2,先 replay 后实跑;E1–E3 前置裁决,见 §7.6a)**
前置便宜实验:E3(三管道分层)**已跑**——排序管道占 69%,单 gold 弱势主因确认在 rank 侧,E4(写时 trigger)不触发,本卡靶心成立(§7.6a)。剩余前置:E1 拒答 ROC(归 Card C 启动项)、E2 facet 字典序反事实——**硬门(Gemini B1/Card D 联动确认)**:facetOverlapCount 是排序第一键,overlap 数不同的候选对之间**任何权重调整都零作用**,权重-only 的 A/B 配置只在同 overlap 层内有效;E2 不先跑并确认作用面,本卡后续所有配置的结论都不可信。然后:
文献精读定稿(Inverted Locality/CICL/Memanto/GraphRAG-bench 全文,2026-07-06):四篇都用**单一标量全序**排序,没有一篇支持字典序前置或多条相关结构流叠加;Inverted Locality 实测 reuse/recency 对未来检索**反预测**(AUC 0.24–0.49),坐实"结构流当先验必须压缩"。Π 的推荐形式:`Π(o)=exp(β·log(1+NOR_ρ(s₁..s₄)))`(NOR 复用 conformant 轴现有实现),外加 **L 门控**:`Π_eff=1+w·g(L)·(Π−1)`,似然已高时结构增益关闭——这是防"流行干扰项靠结构翻盘"的机制正解。权重 w/β/ρ/τ 用 gold 标签离线网格校准(单 gold 子集加"Π 不得翻转 L 排名"的 pairwise 约束),不做在线 LLM 自适应。
replay A/B 按文献信息量排序执行:①**去 facet 字典序前置**(=E2,并入分数或仅同分 tie-break;single-gold 预期↑↑);②**乘法 L×Π×ω + NOR 折叠四条结构流**(直接检验 §7.2 重复计票);③**Π 的 L 门控**;④Π=0 纯似然 ablation(测结构先验净效应,multi-hop 可能↓);⑤NOR vs max-pool vs log(1+S) 形式对比;⑥旧方案(agreement 权重 6→{3,1,0}、RRF-k 敏感性)降为对照组。replay 上任何 ≥+2pp 的配置再上 100Q 实跑确认,最后 500Q。**禁止不经 replay 的盲调参(工作流 R1–R5)。**

**Card E — delivery 栈裁剪 + flood 供燃(L4,按 D2 溯源结论 + 文献精读定稿)**
文献精读结论(MemTrace/ContextSniper/SEEM/A-TMA 全文,2026-07-06):四篇没有一篇支持"coverage/session 多样性配额可以踢高分证据";共同形态是**单一有预算的 packager + 不丢可达证据**。Card E 采纳三条不变量:
- **I1 rank floor**:fusion rank ≤5 的项禁止硬驱逐,除非换入项 marginal utility 严格更高且被降级项保留 locator+恢复路径;
- **I2 default fill**:未消费的 slot 按 fusion rank 降序回填(A-TMA stable pre-rank 兜底);
- **I3 expansion over eviction**:同事件碎片走 provenance 扩展(SEEM RPE,cap 2×),不做配额换入。
执行项:1) 删恒 noop 的 session_coverage / synthesis_reserve 阶段**实现**,但保留 stage 槽位与 env 挂点(`ALAYA_RECALL_SESSION_COVERAGE_BAND` 等)并在 §7.7 warm-readiness 清单挂账(Gemini I2 折中:多 session 热态可能需要 session 多样性,但要按"多样性约束"重新设计,不是恢复现实现——现 session_coverage 本来就是 noop,"保留代码"保不住任何行为);2) coverage_selector 按 I1 重写或默认 off(净 −2,17/74 miss 是投递层自伤,E3 已证 use 管道占 23%)。**机制补充(Gemini B2 核实为真)**:S4 `evidenceSetCoverageBonus` 里 `SESSION_COVERAGE_BONUS=+0.06` 加给**已被选中 session 的同 session 证据成员**(`evidence-set-coverage.ts:83-85`)——这是同 session 放大器而非多样性,可能是有意的"证据集补全"设计,但与"coverage=多样性"的命名相悖;重写时该项要么改名为 evidence-set completion 并单独 A/B,要么删除;feature_rerank 保留但限定为池内 reorder + 失败回退 pre-rank;投递 trace 增发 `fusion_rank/post_rank/in_final_packet/eviction_reason` 字段,使 reach→deliver→use 三段可归因(MemTrace 式);3) flood 供燃实验:`ALAYA_RECALL_ANSWERS_WITH=1` 跑 100Q(flood 改变 fusion 分本身,冻结的 per-stream 贡献不含它,**不能用 Card A replay,必须实跑**),同时经 Card B 透传 `fuel_verified_count` / per-axis 诊断确认燃料真到位;FACET_SLICE 保持 off(开启只会在无 facet 重叠时把 slice.value 置 0 反而闷死 fuel);`beta` 维持 0(设计前提"query-orthogonal support"尚不存在)。有增益 → 500Q 定版并默认开启;供燃后仍无增益 → 删除 integrated-flood 路径重新上桌。附带卫生项:删 slice 轴无用的 `countsAsFuel` 字段;补一条"默认 env 下 fuel_verified_count>0"的集成断言(本次死路径正是因为 warm 测试全靠手动注入才漏网)。

依赖:A → (B∥C∥D) → E;每张卡走 review-protocol,离线结论与实跑结论分开报告。

## 5. 验证门槛(Phase 1 出口)

- 500Q 全量门禁复跑:gold-bearing any@5 ≥ 90%(现 85.8%),全题 any@5 ≥ 86%(现 78.6%,含弃答修复),coverage@5 显著抬升并在 merged KPI 里可见。
- 单 gold 子集 any@5 单列报告(现 67.7%),不设硬门但必须可见。
- 同快照 QA 全量对照一次(D4 哨兵):recall any@5 达标但 QA 答对率不涨即视为 gold 粒度虚高证据,重开 D4。
- `rtk pnpm build` + 相关 `rtk pnpm exec vitest run` 通过;replay 工具对账零漂移。
- 弃答侧出口证据(Gemini 反思采纳):在 30 个 `_abs` hold-out 上出 ROC——校准特征(margin+似然流覆盖度)vs 原始 fused 分,AUC 必须显著更高,证明先验偏置已从弃答判定里剥离。
- flood 供燃验证:`ALAYA_RECALL_ANSWERS_WITH=1` 实跑后 `fuel_verified_count > 0`(Card E 集成断言落地)。

## 6. 决策记录(2026-07-06 用户拍板)

- **D1 头条分母 — 已定:双数并报,主门禁挂 gold-bearing any@5。** 全题 any@5(含弃答)与 gold-bearing any@5 并列报告;§5 的门禁口径不变。
- **D2 flood — 溯源已完成,结论:不是代码 bug,是配置断供燃料;修活 = 开 `ALAYA_RECALL_ANSWERS_WITH=1`,零代码改动。** 用户"数学没问题、落地哪里不通"的直觉方向正确;详细链条见 R3(修正版)。path∧evidence 双燃料 AND 门是 Card 2 有意设计,不动;`beta=0` 有意默认,单独议。执行落在 Card E 第 3 项。残留代码卫生项:slice 轴上从未被读取的 `countsAsFuel` 字段删除或注释归位(Nice-to-have)。
- **D3 budget 门禁 — 已定:改率基。** Card B 第 4 项执行(建议 ≤2% 题目触发,标定时用本次 35/500=7% 作为已知超标参照)。
- **D4 gold 粒度 — 建议不做全量对象级收紧,理由见下,待用户确认。**

### D4 成本与必要性核算

成本(高,且非一次性):

1. sidecar 只存轮级原文(`optionalSeedContent`,`runner-question-seeding.ts:190`——且仅 QA/pool-dump 模式下才存),同一答案轮物化出的 N 条 memory_entry 共享同一段轮文本,**无法用现有数据区分哪条真含答案**。对象级标注必须去快照 DB 里读每条实体化后的 entry 内容,再逐条做 LLM 判答(467 gold-bearing 题 × 中位数 5 条 ≈ 2500+ 次判定)。
2. gold id 在每次快照重建时全部重新生成 → 标注不是一次性成本,必须做成随快照重跑的自动流水线。
3. 改变所有历史指标语义:bench-history 全部基线失去可比性,门禁阈值需整体重标。

必要性(从真实用户体验看,低):

- 用户真正感知的是端到端 QA 答对率;recall any@5 只是内部代理指标。gold 粒度松导致的"虚高命中"(送达的是答案轮的兄弟事实而非答案本身)如果真发生,会直接体现为 QA 正确率与 recall 命中率的背离——**QA 指标本身就是免费的对象级真值**,不需要再造一套标注。
- 单 gold 子集(本次 31 题)天然就是对象级精度,计划已要求单列报告(§5),这是不受粒度污染的哨兵指标。
- 虚高风险真正的危害是 Phase 1 出口"提前宣胜"。廉价对冲:出口除 recall 门禁外,加一次同快照 QA 全量跑,若 recall any@5 达标而 QA 答对率不涨,即为虚高证据,再回头议对象级标注。

**结论:D4 从 "Phase 2 再议" 改为 "默认不做";用三个零成本哨兵替代(单 gold 子集单列 + full_gold_coverage 双报 + Phase 1 出口同快照 QA 对照)。** 仅当 QA 对照暴露背离时重开。

## 7. 数学定位(2026-07-06 深化,基于两份代码盘点)

> 事实来源:打分链数学盘点与动态闭环盘点两个只读子代理报告(全部 file:line 已核),叠加 500Q 逐题诊断。本节回答"算法在数学上该坐在哪",是 L1–L5 的理论地基。

### 7.1 现状:两套打分系统缝在一起

- **旧加法系**:`effectiveScore = clamp01(Σwᵢxᵢ)·μ`,正项权重和 ≈ **1.47 > 1**(phase4b 1.0 + plasticity 0.15 + no-embedding 0.24 + confidence 0.08)——饱和是权重超额+clamp 的必然,非调参问题。它不驱动 fusion 主排序,但作为 delivered `relevance_score` 喂给弃答、作为 `existing_score` 流回灌 fusion、并当 tie-break——三个下游全被饱和毒化。
- **新公理系**(Card 0–7 conformant 轴):RRF 对象轴 + NOR 去相关(ρ=0.5,λᵢ=1−ρ 折扣相关证据)+ fuel 门控 + manifestation 乘子 ω。数学形态明显更干净:**NOR 正是反重复计票的正确工具,fuel gate 正是"动态项无信息时保持中性"的正确形态**——但它当前只管 flood 轴,而 flood 无燃料恒死(R3)。

即:**数学上更合理的那套系统处于休眠,数学上退化的那套系统在生产分数。**

### 7.2 病灶的统一数学解释:似然与先验未分离 + 先验重复计票

把流按查询依赖性分类(盘点已逐流核实):

- **似然类(query-dependent)**:embedding(12)、lexical/trigram/evidence FTS、facet_overlap(4)。
- **先验类(query-independent,即结构/流行度)**:structural(1)、graph_expansion(3)、path_expansion(3)、workspace_activation。
- **混血**:evidence_structural_agreement(6,全表第二高)= `sqrt(E·T)+0.1·min(E,T)`,E 是查询侧证据 FTS、**T 是纯结构分**——它把结构先验用√几何混合抬进一条高权流;source_evidence_agreement 同构。

重复计票的实锤:结构先验 T 同时进入 structural(1)、agreement(6 的一半)、graph_expansion(3)、path_expansion(3)≥4 条流;evidence 信号同时进 evidence_fts(3)+两条 agreement。RRF 加法融合下**先验的有效权重是各相关流权重之和**,远超任何单流标称值。这精确解释 6–10 桶:gold 赢 embedding/lexical(似然)却输给积累了更多结构支持的干扰项(先验)。多上下文反复出现 → evidence_refs 更多、path/graph 扇入更大 → 每条先验流都加分。**flood 轴内部有 NOR 防这个,RRF 流栈没有。**

### 7.3 隐藏的主排序键:facetOverlapCount 字典序优先

fusion 秩的第一比较键是 `facetOverlapCount` 降序,**fusedScore 只是第二键**。即真实排序 = 字典序(facet 命中数, RRF 分)。任何 replay/调参若不建模这一层,对账必然漂移 → **Card A 工具必须复现该字典序**(已写入 Card A)。这也意味着:改 RRF 权重对 facet 命中数不同的候选对**完全无效**,L2 的可作用面比想象小,replay 前需先统计 6–10 桶里 gold 与占位者 facet 数相同的比例。

### 7.4 "非固定参数的动态记忆系统"假设与代码现实的对齐

动态闭环盘点结论:**生产路径的双向动力学是实打实存在的**——karma(±0.05~0.3)、retention 半衰期(7d–∞)、freshness 30d 衰减、path plasticity 强化+0.1/弱化−0.05/30d 退休、重复使用减半、[0,1] clamp。"只增不减的富者愈富"在生产上有界(clamp+衰减+退休),虽无除法归一化,但不是裸的 preferential attachment。

**但默认 bench 里这套动力学几乎全关**:recall 交付侧 co-recall 不跑、karma 不跑、Garden 周期不跑、usage 报告 none。跑分测的是**冷态静态切片** + 一份 seed 时预注入的 co_recalled 拓扑(`accrueSessionCoRecall`,gold-盲、相邻对×3 重放)。两个推论:

1. 500Q 里的"流行度先验"不是动力学失控,而是**静态结构积累**(evidence_refs 数量、seed 注入的 path 扇入)——所以修法在融合数学(7.2),不在动力学。
2. benchmark 与核心假设测的不是同一个系统:动态性(karma/plasticity/衰减)完全在测量范围外。**用户已定策略(2026-07-06):冷态先行——先证静态召回成立,再经 LongMemEval-V2 或其它 benchmark 验证热态。** 暖态验证为独立后续阶段,Phase 1 不为其动刀,但设计决策不得堵死暖态路径(如:诊断 schema 预留 usage 反馈字段)。

### 7.5 目标形态(排序目标的原则性写法)

\[ \text{score}(o \mid q) = \underbrace{L(q,o)}_{\text{似然:embedding/lexical/evidence-FTS}} \times \underbrace{\Pi(o)}_{\text{先验:全部结构流经 NOR 折叠为一项,log 压缩,校准权重}} \times \underbrace{\omega(o)}_{\text{manifestation}} \]

配套原则:① 每个动态/结构项都要有 fuel-gate 式中性退化(冷启动 → 纯似然);② delivered 分数必须可校准(用 gold 标签做 isotonic/Platt),饱和加法分退役出 delivery 路径;③ 先验只用一次投票权。这个形态不要求推倒重写——NOR、fuel gate、ω 都已在 conformant 轴里,方向是**把 conformant 数学从 flood 轴推广到整个先验侧**,让旧加法分退居 tie-break。

### 7.6a 外部研究对照(2026-07-06,基于 `.do-it/grill/agent_memory_papers_repos_catalog.md` 反思报告)

用前沿工作对本计划做对抗检验后的净结论:

**三管道模型(替代单一"排序问题"叙事)。** 外部文献一致把 miss 拆成三条独立管道:reachability(可达性/写入期索引缺失,T-Mem 式)、rank(排序期流行度先验)、use(可达且排进 top-5 后被投递层丢弃,MemTrace 式)。**E3 已跑**(`analyze-single-gold-pipes.py`,467 gold-bearing / 74 miss,分母含 9 个带 gold 的 `_abs` 题,较 §1 的 458/65 口径略宽):

| 管道 | 单 gold(10 miss) | 全部 gold-bearing(74 miss) | 判决 |
| --- | ---: | ---: | --- |
| reachability(absent) | 2 | 6(8%) | T-Mem 写时 enrichment 挑战**被定界**:非主要瓶颈,E4 不触发 |
| rank(fusion 6+) | 7 | 51(69%) | **单 gold 弱势主因仍是排序管道**,L2 打的靶没错 |
| use(fused≤5 被踢) | 1 | 17(23%) | 比早先"9 个"口径更大(含 budget/后期丢弃),**L4 权重上调** |

单 gold 样本小(10 miss),方向性结论;但三个子集方向一致。

**对各杠杆的外部裁决:**

- **L1 强支持**(MemTrace/STALE/GroupMemBench 都把拒答校准当一等公民),但有一个我们没想到的细化:**"证据缺失该拒答"与"前提为假该纠正"是两个不同的决策边界**,isotonic 校准只解决前者。冷态 LME 的 30 个 `_abs` 题主要是前者,Phase 1 够用;premise rejection 留 Phase 2(LME-V2 有 premise 维度)。
- **L2 中等支持但被两面夹击**:Inverted Locality/Decision-Aware Memory Cards 支持"出现多≠相关"的先验压制方向;但 "Is GraphRAG Needed?" 类工作警告结构增益普遍被高估,+5.4pp 上限可能乐观。**结论:L2 保留但降级为"经三个更便宜的前置实验裁决后再上"**(见下)。
- **L4 的优先级被外部证据抬升**:MemTrace 的核心发现是失败主因常在 evidence use(可达但未投递)而非 retrieval——我们 9/65 的后处理踢出 miss 正是这个桶,且修复确定性比 L2 高。
- **L5 强支持**(MemoryData/MemTrace 都要求模块级归因,否则暖态验证时无法区分增益来源)。
- **冷热分阶段策略与 LME-V1→V2 产品线一致**,但 Beyond Static Leaderboards 警告:冷态最优权重 ≠ 暖态最优。Phase 1 验收的应是 **L×Π×ω 接口的不变性**(暖态只需 refuel,不需重写 scoring),而非某组全局权重。

**便宜实验序列(在 Card D 全量 A/B 之前,均为纯离线):**

- **E1 拒答 ROC**:30 个 `_abs` 题上 raw vs 校准分的 ROC 曲线——L1 收益的零代码验证。
- **E2 facet 字典序反事实**:replay 中仅把 facetOverlapCount 从第一排序键降为 tie-break,测单 gold any@5 变化。若显著,L2 打错靶心,先修排序键结构。
- **E3 reach/use 归因细化**:全量 miss 的三管道分层已有(9% / 14% / 77%),补单 gold 子集切片。
- **E4(储备,当前不触发)T-Mem 式写时 trigger enrichment**:E3 已证 reachability 仅 8%,E4 转为储备设计。精读后的规格要点:trigger 作为 memory_entry 的 sidecar 索引字段(entity/bridge/horizon 多视图向量),只扩候选池、不进 evidence、检索侧 cosine 硬门 τ≈0.85;挂载点是 Garden post-turn extraction(可合并 prompt 摊薄成本,估 $1–3/千条,需实测)。激活门槛:reachability 桶持续 ≥8% 且 associative 子类主导 + trigger 后该子集 R@k 相对提升 ≥30%。T-Mem 自己的 ablation 警示:item 级 Bridge 增益微弱(−0.25pp),scene 级 Horizon 才是主增益(−12.47pp)——若激活,优先 scene 级。

### 7.6 对杠杆的修订

- **L2 升级**:从"逐流降权/条件化"升级为"**先验合并实验**"——replay A/B 增加一组配置:structural/path/graph/agreement-结构半边折叠为单条 NOR 先验流(近似:大幅降相关流权重+保留最强单流),与逐流调参对照。Card D 已更新。
- **L3 精确化**:饱和只毒化 delivery/弃答/existing_score 回灌/tie-break,不毒化 fusion 主序——去饱和的最小改动是**换 delivered 分数来源**(fused 归一+校准),不必动 effectiveScore 的内部权重。
- **Card A 追加对账约束**:必须复现 facetOverlapCount 字典序,否则 replay 无效。

### 7.7 暖态就绪清单(Phase 1 预埋,LongMemEval-V2 精读结论)

LME-V2 事实:451 题、web-agent 轨迹域、25M–115M tokens,五能力轴 static/dynamic/workflow/gotchas/premise;评测契约是 `Insert(trajectory)` 顺序写入 + `Query(q)→context`(200K 截断)+ 延迟为第二指标;弃答题为 zero-support,评的是"指认错误前提"而非 UNKNOWN(UNKNOWN 一律算错);memory 层不强制做 premise 检测,但做了的 baseline(AgentRunbook-C)拒答显著更好。

Phase 1 必须预埋(否则暖态返工):

1. **评测 schema 加轴标签**:`ability` 五轴 + `is_abstention` + anchor 题 id(Card B 顺手做,与 `question_type` 持久化同一改动面)。
2. **三分法错误归因字段**:reachability / ranking(含 premise mishandling)/ reading——Card E 的投递 trace 字段已覆盖前两段,补 reader 段留位。
3. **拒答输出契约留 premise 通道**:Card C 的判定输出加结构化 `premise_invalid` 位(Phase 1 恒 false,不实现检测逻辑)——这是"证据缺失"与"前提为假"双边界在 schema 上的最小预留。
4. **usage 动力学模拟钩子可导出**(karma/plasticity 事件),冷态禁用但接口保留——已是现状,列为验收项防回退。
5. **session 多样性槽位挂账(Gemini I2)**:Card E 删除 session_coverage 的 noop 实现但保留 stage 槽位与 env 挂点;暖态多 session 场景(Inverted Locality 实测 recency 反预测,AUC 0.24–0.49)若出现"当前 session 淹没历史事实"证据,按**多样性约束**(不是同 session 加分)重新设计并 A/B,不恢复旧实现。

Phase 1 明确不做:memory 层主动 premise 检测、多模态摄入、workflow/procedural 记忆面。

### 7.8 Gemini 反思对账(`.do-it/grill/2026-07-06-recall-root-cause-reflection.md`,2026-07-06)

**采纳(已落进卡片):**

- **B3 SemVer**:Card B 新增第 5 项——schema 改动先按 invariant §25 的传递可达性判定,快照移动必须声明版本步进。
- **Card A 边界与 tie-break**:补"scoring replay ≠ candidate-retrieval replay"边界声明 + `compareMemoryEntries` tie-break 链复现要求。
- **Card C 阈值搜索退化**(Gemini 抓到原设计的真洞):`_abs` 全 hold-out 导致搜索空间零负样本,"弃答 recall 约束"不可求值,阈值必然退化为永不弃答。修正:leave-gold-out 合成负样本参与搜索,真 `_abs` 仍 hold-out。
- **I1 先验污染弃答**:Card C 特征集区分似然流/结构流覆盖度;§5 出口加 `_abs` ROC 门(校准特征 vs 原始 fused 分)。方向与我们 §7.5 L×Π×ω + Card D ③ L 门控独立收敛,互为佐证。
- **B2 核实为真**:`SESSION_COVERAGE_BONUS=+0.06` 加给已选中 session 的同 session 成员,是同 session 放大器,与 coverage 命名相悖——写入 Card E 重写清单。
- **I2 折中**:session_coverage 删实现、留 stage 槽位与 env 挂点,§7.7 第 5 条挂账暖态重设计。

**修正 Gemini 的错误前提(不采纳原文推理):**

- Gemini 论证 I1 时假设"`_abs` 题的似然流返回空、fused 分坍缩到零"——对 embedding 流不成立:稠密检索永远返回 top-k 近邻,`_abs` 题的 embedding rank 照样填满。所以"分数坍缩→干净分界"不会字面发生,margin/覆盖度仍是主信号,L 门控是压先验、不是造零分。
- **B2 定级过重**:同 session 加分可能是有意的"证据集补全"设计(文件名 evidence-set-coverage 即此意),按设计-命名错位处理,在 Card E 重写时改名单独 A/B 或删除,不作为立即阻断项。
- **I2 "保留现实现"无意义**:现 session_coverage 本来就是被旁路的 noop,保代码保不住任何行为;真正要保的是槽位、env 与暖态重设计的设计原则(多样性约束,非同 session 加分)。
- **B1 无新增事实**:facet 字典序问题本计划 §7.3/E2 已确立;采纳其"权重 A/B 在异 overlap 候选对间零作用"的表述,把 E2 从"前置实验"升格为 Card D 的硬门。

## 8. Non-goals

- 不做盲权重扫参;每个改动先有 replay 证据。
- 不为 11–25 桶 / graph 弱 / QA 链路在 Phase 1 动刀。
- 不新增排序分支;只修证实有问题的层,删证实无用的层。
