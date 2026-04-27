# ALA-R6 - Provider And Agent-Assisted Proposal

## Goal

实现 provider capability model、Garden/agent-assisted proposal route、provider health/degradation，以及 LLM/agent 候选生成的 runtime gate。

## Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/compute-routing.ts:4`
- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/compute-routing-service.ts:24`
- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/compute-routing-service.ts:104`
- `/home/tdwhere/vibe/do-what-new/apps/core-daemon/src/index.ts:767`
- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/compute-provider.ts:208`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/conversation-service.ts:1298`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-a2a-briefs/README.md:73`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-a2a-briefs/README.md:99`

## Alaya Adaptation

- Providers expose capabilities: embedding, rerank, proposal, explain。
- Provider SDK details stay behind provider ports。
- LLM/agent/subagent may propose candidates but cannot write durable truth。
- Garden-style background compute must not block main turn。

## Non-goals

- 不实现 custom/local provider real behavior beyond port contract。
- 不把 provider output 直接 trusted。

## Scope

- provider capability schema。
- provider registry。
- health/status。
- proposal route。
- background garden-like job interface。

## Inputs

- provider config refs。
- capability requirements。
- scoped corpus/context。
- proposal task。

## Outputs

- provider decision。
- proposal candidates。
- provider degradation records。
- background job audit。

## Acceptance

- provider selection is deterministic by priority and tie-break。
- missing required capability fails closed or degrades only where policy allows。
- proposal candidates pass scope/governance/runtime validation before candidate/draft。
- provider status distinguishes configured/enabled/unavailable/degraded。
- no provider SDK type leaks through public runtime/API contracts。

## Verification

- provider registry tests。
- capability selection tests。
- provider failure/degradation tests。
- proposal validation tests。

## Review Lens

- provider boundary。
- governance passthrough risk。
- async/background safety。

## Stop Conditions

- If a provider can mutate storage directly, stop and fix boundary.
