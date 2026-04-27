# ALA-R7 - Session Audit And Trust

## Goal

实现 session audit 与 trust reporting，明确 installed、configured、delivered、used、skipped、unverifiable、mixed 的语义和证明要求。

## Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/runtime-port.ts:79`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/runtime-event-normalizer.ts:55`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/serial-delegation-event-intake.ts:50`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/serial-delegation-service.ts:287`
- `/home/tdwhere/vibe/do-what-new/docs/handbook/runtime-status.md:108`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/evidence-capsule.ts:6`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/memory-service.ts:176`

## Alaya Adaptation

- Session truth is event-backed and auditable。
- No direct proof means Alaya must not claim `used`; use `unverifiable` or weaker reported states。
- Late terminal events must be handled without corrupting trust state。

## Non-goals

- 不实现 benchmark scoring。
- 不实现 UI visualization。

## Scope

- session lifecycle events。
- context delivery records。
- usage proof records。
- trust summary。
- terminal event ordering。

## Inputs

- activation mode。
- context pack id。
- agent/tool events。
- proposal/governance outcomes。

## Outputs

- session audit record。
- usage summary。
- trust report。
- unverifiable/skipped reasons。

## Acceptance

- installed/configured/delivered/used/skipped/unverifiable/mixed states are distinct。
- delivered context does not imply used。
- `used` requires explicit proof or accepted proof signal。
- terminal event handling is deterministic and robust to late finish/error ordering。
- trust report links memory usage to context pack, evidence, and run identity。

## Verification

- session lifecycle tests。
- usage-state transition tests。
- late terminal event tests。
- trust report snapshot tests。

## Review Lens

- proof semantics。
- audit completeness。
- concurrency/ordering。

## Stop Conditions

- If the implementation infers `used` from delivery alone, stop and fix.
