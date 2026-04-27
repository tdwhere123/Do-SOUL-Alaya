# 完整产品闭环（v0.1 计划）

本文件描述 Do-SOUL Alaya 作为本地独立产品的端到端闭环。目标不只是
“能召回”，还要证明 agent 是否真的使用了记忆，以及 operator 是否能信任
这些记忆。

## 1. 安装与 Profile 初始化

1. 用户运行 installer。
2. Installer 建立或更新两层 profile：
   - User scope：跨项目默认配置、默认 provider、默认激活策略。
   - Project scope：repo/workspace 覆盖规则、本地敏感性、项目召回约束。
3. Installer 输出：
   - local data path；
   - daemon/runtime endpoint；
   - MCP config snippet；
   - Codex / Claude Code Attach/Profile 写入预览；
   - 是否已确认写入全局或项目规则。

退出条件：operator 能看到 profile、storage、MCP、Attach 状态。

## 2. 启动 Core Service

1. 启动 local daemon core。
2. Daemon 承载 runtime API、MCP server、CLI protocol fallback、后台任务调度。
3. Runtime 是唯一 durable truth gate；adapter 不得绕过 runtime。

退出条件：health/doctor 能报告 runtime、storage、migration、provider、
profile 与 activation 状态。

## 3. 选择激活模式

每次 agent run 选择一种模式：

- Connect：MCP tools/resources/prompts 可用，agent 自己决定何时调用。
- Attach：写入或生成 Codex/Claude/profile 规则，提高主动调用概率。
- Gateway：可选强制 envelope，用于 benchmark 或需要强证明的任务。

Fallback：

- MCP 不可用时走 CLI protocol。
- fallback 不能削弱 session audit、trust state 或 governance 语义。

## 4. 运行前召回与 Context Assembly

1. Runtime 接收 task/query、agent identity、user/project scope。
2. 多路召回执行：
   - structured recall；
   - lexical/FTS recall；
   - path-aware recall；
   - embedding recall；
   - agent-assisted semantic recall。
3. Runtime 输出 context pack：
   - included candidates + reasons；
   - excluded candidates + reasons；
   - source plane labels；
   - usage recommendations；
   - degradation metadata。
4. Session 记录 context pack 与 delivery 状态。

退出条件：session 有 context-pack id，并能解释召回与排除原因。

## 5. Agent 执行与使用证明

1. Agent 通过 MCP 或 CLI protocol 使用 Alaya。
2. Agent、子智能体或 LLM provider 可以提出候选记忆、候选 path、候选治理动作。
3. Runtime 校验 source/evidence、scope、sensitivity、governance 与风险等级。
4. Session 记录 delivered / used / skipped / unverifiable。

退出条件：run 结束时存在 session usage summary，而不只是工具调用日志。

## 6. 运行后写入与治理

1. 低风险候选可静默进入 `candidate` / `draft`，但必须 audit。
2. 高风险变更必须 HITL 确认。
3. governance actions 必须显式、可追踪、可解释。
4. durable write、reject、skip、defer 都要记录结果。

高风险默认包括：

- `ClaimForm`；
- reject / retire / override / strengthen；
- 敏感内容；
- 跨项目或全局强记忆；
- 强 `PathRelation` 改写。

## 7. 检查、导出与评测

1. Operator 查看 session、召回解释、候选写入、治理结果。
2. Operator 可导出或备份 profile/memory bundle。
3. Benchmark mode 可比较 Connect / Attach / Gateway 的记忆使用效果。

退出条件：operator 能回答：

- 召回了什么，为什么；
- 排除了什么，为什么；
- agent 实际用了什么；
- durable memory 改了什么；
- 哪些只是候选，哪些已经治理通过。

## v0.1 闭环验收

- 任意 CLI agent 都有接入路径。
- Runtime 保持 durable truth gate。
- Session audit 区分 installed、configured、delivered、used、skipped、
  unverifiable。
- fallback path 不削弱契约和审计。
- 高风险写入不能绕过确认。
