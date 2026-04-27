# 开放问题（v0.1 计划）

这些问题会影响实现顺序或公共契约冻结。

## Contract And Policy

1. 高风险候选的精确定义字段是什么？
2. 哪些操作必须 block 等待 HITL，哪些只需要 soft warning？
3. 不同 memory type 的 minimum evidence payload 是什么？
4. 哪些 governance actions 在所有模式下都必须要求 operator reason？

## Integration

1. v0.1 MCP baseline 是否包含 tools + resources + prompts 三类？
2. 哪些 CLI protocol commands 必须与 MCP baseline 等价？
3. Installer 遇到全局/项目 profile merge conflict 时如何展示？
4. Project scope 是否允许自动写 profile，还是必须逐项确认？

## Activation And Session Audit

1. 直接 proof 不可得时，`used` 与 `unverifiable` 如何区分？
2. Connect mode 与 Gateway mode 的 compliant threshold 是否不同？
3. Benchmark report 中哪些 violation 是 blocking，哪些是 informational？

## Recall And Retrieval

1. 多路召回 merge 的 deterministic ordering policy 是什么？
2. 哪些 route degradation 可以 partial success，哪些必须 hard fail？
3. 每条 exclusion record 的 minimum explanation payload 是什么？
4. embedding provider 的本地优先最低要求是什么？
5. agent-assisted recall 能看到的 scoped corpus 最大边界是什么？

## Provider And Configuration

1. provider capability schema 如何表达 embedding、rerank、proposal、explain？
2. secret reference 如何跨 OS keychain 表达？
3. provider health/status 如何影响 recall degradation？
4. user scope 与 project scope 的 provider override 如何审计？

## Inspector And Evaluation

1. Phase 2 Inspector 哪些视图是第一批信任闭环必需？
2. 最小 benchmark suite 包含哪些任务类型？
3. 哪些 metrics 是 release gate，哪些只是 diagnostics？

## 决策顺序建议

1. 先冻结 contract/policy。
2. 再冻结 integration parity 与 installer policy。
3. 再冻结 recall degradation 与 provider policy。
4. 最后冻结 Inspector 与 evaluation scope。
