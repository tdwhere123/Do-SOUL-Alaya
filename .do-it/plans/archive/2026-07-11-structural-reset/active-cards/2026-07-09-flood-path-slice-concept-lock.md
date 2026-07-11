# Flood / Path / Slice 概念锁定(2026-07-09)

> 承接(已归档):`plans/archive/2026-07-09-phase1-closeout/2026-07-06-recall-root-cause-and-levers.md`(总目标不变)。
> 前向实现卡:`claude/2026-07-09-recall-forward-after-concept-lock.md`(S0–S5)。
> 触发:用户讨论纠正「flood = 供燃开关」的扁化叙事;锁定 Path 边主语、切片 key、势能遥远性。
> 状态:**概念契约已在 2026-07-10 校正并锁定,实现走前向卡。** cleanup/review-fix 已落到 `05d98dfd`;本卡只锁共识与落地清单。
> Worklog 指针:`.do-it/worklog/2026-07-09-recall-forward.md`。
> Grill:`.do-it/grill/recall-root-cause-levers.md`。

## 0. Card Metadata

| Field | Value |
| --- | --- |
| Card ID | `2026-07-09-flood-path-slice-concept-lock` |
| Tier | Heavy (concept → later implementation) |
| Parent target | 不变:gold-bearing any@5 → 产品级 90%;p95 ≤ 1100ms(释放口径另议) |
| Primary surfaces (future) | path structure registry, derived slice keys, flood transfer, diagnostics |
| Non-goals now | 不在本卡改默认排序键;不重开 I1/coverage/bonus/盲权重;不宣称新 AUC |

## 1. 总目标(不变)

- 质量:gold-bearing any@5 ≥ 90%(全题 any@5 并报)。
- 延迟:释放口径下 p95 ≤ 1100ms(并行争用与顺序真相分开报)。
- 手段:基于已证实 miss 机制与可学习结构,不盲扫参。

已否/不默认:I1 hard floor、coverage-off、completion-bonus=0、score-first、盲 RRF 权重。  
未实验嫌疑:hub inflation、`FACET_SLICE` 产品默认——须在本概念框架下重解释后再实验。

## 2. 概念锁定(2026-07-09 用户拍板)

### 2.1 PathRelation、Flood Transfer 与对象投影

- **PathRelation(耐久结构)**:对象、对象切面、时间/风险/义务 concern 之间可学习且受治理的**条件关系结构**,不是「又一条 RRF 流」。
- **Flood transfer(运行决策)**:一次 query/slice 下沿一条有向、可召回边发生的势传递;它是 runtime control,不写回记忆本体。
- **对象 `fused_score`(上岸读数)**:逐边 transfer 聚合后的投影,不是边也不是 flood 的完整运行记录。
- 调试主键至少是 `path_id + seed + target`;诊断应回答哪条边传了多少、被何种 slice 接纳或拒绝、为何停止。

### 2.2 切片(Slice)与 Derived SliceKey

- 洪流**必须有条件**;无条件放水 ≈ 结构干扰项与 gold 同等受益。
- 切片应**丰富**,数学未定论;最小完备可从 **时间性 / 空间性 / 对象性** 等角度构思。
- v1 形态:**workspace-scoped、可重建、带 provenance/version/staleness 的派生路由 key**,不是第二层记忆本体。审计用 `key_id` 保留 provenance/version；路由用 `match_id = workspace + dimension + normalized value`，避免跨来源的同义 key 因 provenance 不同而无法相交。
  - 维护期:继续维护现有 event-time、`facet_tags`、`canonical_entities` 与 Path anchors;不新增 SliceKey 表。
  - 来源保持 typed: time 来自 event-time/validity/time-concern,space 来自带值 location facet 或确认的空间实体,object/entity 来自 canonical entities/object anchors,semantic 来自 `facet_tags`。
  - `facet_tags` 是 key derivation 的输入,不是容纳 event-time/entity/path identity 的总容器。
  - 召回期:从 query/source/target 投影导出 key,以三方交集选择合法边(选河),再允许沿边传势。
  - 性能证据若证明 read-time derivation 不足,才进入 `BL-069` 的物化索引评估。
- 今日 `FACET_SLICE`(query 与目标对象 facet 重叠)只是窄实验,**不是**SliceKey 本体或产品默认。

### 2.3 通道常在 vs 放水有条件(张力化解)

| 层 | 策略 |
| --- | --- |
| 河床 / `answers_with` 铸边通道 | **常在**(硬开合理):避免整层 flood 子系统失能 |
| 放水 / 沿边传势 | **有条件**:切片 key + 势能可达性;不是 Slice≡1 直通就等于「哲学上开了 flood」 |

默认条件的工作假设(待数学化,非最终公式):

1. **冷中性**:无合法边或无会合条件 → flood 不改分(已有 path∧evidence 雏形)。
2. **弱默认门**:path∧evidence(或等价)保证「有河床且有证据会合」才传——防止完全失能。
3. **丰富切片只加严、不当唯一总开关**:有 key 信息时收紧合法河床集合;无 key 时不靠「关死 FACET_SLICE」假装条件洪流。

### 2.4 势能与「遥远」

- 是否流到对岸,从**势能**看:判断「多远算太远」。
- 与**输入内容的力量**(查询/激活强度)相关:**太遥远则流不过去**。
- 单跳 v1 先把现有 `R_obj(seed) × edge.weight → cap → NOR → L-gate` 显式化为逐边 transfer,再加入 slice compatibility 与停止原因。
- 多跳不是先验必做:只有 trace 证明没有直接边但两跳可达的 missed gold 数量足以补齐同一样本到 90%,才开放 max-2-hop 有界传播。

### 2.5 「推理」落点(工作假设)

不是 RRF 后再挂一个 LLM,而是结构推理三层:

1. **选河(切片 key)**:当前输入下哪些高层 key 合法。
2. **沿河(边传播)**:势沿边走多远、NOR/衰减、何时停(遥远性)。
3. **上岸(与似然合成)**:传到对象后如何与 \(R_{obj}\) / L-gate 合成。

投递栈(coverage / rescue)是打包,不承担沿 path 推理。

## 3. 与现状实现的落差(归档用)

| 概念 | 现状 | 缺口 |
| --- | --- | --- |
| 边是主语 | 诊断偏对象 `flood_potential`; inflow 丢失 `path_id` | **query-scoped 边级 transfer trace** |
| Derived SliceKey | 已有 time/facet/entity/path-anchor 投影;`FACET_SLICE` 可选且默认 off | read-time key contract + selector + 生命周期证明 |
| 条件放水 | path∧evidence AND 有;Slice 默认直通 | 「弱默认 + 切片加严」未产品化 |
| 遥远性 | L-gate / NOR / cap 有碎片 | 与「输入力量」耦合的传播距离模型未立 |
| 河床常在 | answers_with 硬开已落地 | 与「无条件涨水」叙事需在文档/实验上拆开 |

## 4. 落地清单(后续实现卡,本卡不施工)

按依赖序(概念 → 观测 → 数学 → 实验 → 产品默认):

1. **文档/不变量**:Path 边主语;flood = 沿边势;切片 key 为最高层抽象;通道≠放水。
2. **边级可观测**:diagnostics 能回答「哪条边在何切片下传势/被拒/因遥远停下」。
3. **切片 key v1 contract**:time/space/object/entity/semantic 是 typed source dimensions;维度合同可扩展但不得混义;锁 identity/provenance/version/fallback;复用现有投影。
4. **传播遥远性模型**:先保持现有单跳数学逐位等价,增加 transfer trace/slice compatibility/停止原因;多跳受证据门控制。
5. **默认条件策略实验**:弱默认门 vs `FACET_SLICE` 直通;证明「常开河床 + 有条件放水」不回归干扰项翻盘。
6. **再解释 hub / FACET_SLICE**:在 key+边框架下设计实验,禁止脱离本卡的盲默认开。

## 5. 决策记录(2026-07-09)

| ID | 决定 |
| --- | --- |
| F1 | `PathRelation` 是耐久边;flood transfer 是 query-scoped 运行决策;对象分是上岸读数 |
| F2 | SliceKey 是可重建派生路由索引;typed time/space/object/entity/semantic 来源不得被压成单一 facet vocabulary |
| F3 | 河床通道可常在;放水必须有条件;用「弱默认门 + 切片加严」化解失能 vs 无条件张力 |
| F4 | 遥远性 = 势能/输入力量问题:太远不流过 |
| F5 | 总目标(90% / p95)不变;本卡先归档再实现 |
| F6 | Remoteness 先单跳;仅当 evidence gate 满足时实现有界两跳 |

## 6. Non-goals

- 不在此卡重跑 500Q 或改生产默认排序。
- 不恢复 answers_with 关开关。
- 不把投递层实验(I1/coverage/bonus)当作 flood 推理的替代。
