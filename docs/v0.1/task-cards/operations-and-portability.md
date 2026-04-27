# ALA-R9 - Operations And Portability

## Goal

实现 user/project profile、provider config、secret reference、doctor/status、import/export/backup，并保证跨机器迁移不破坏 evidence/governance。

## Source References

- `/home/tdwhere/vibe/do-what-new/docs/v0.2/tui-a-briefs/README.md:32`
- `/home/tdwhere/vibe/do-what-new/docs/handbook/frontend/runtime-contract.md:253`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/embedding-status.ts:39`
- `/home/tdwhere/vibe/do-what-new/apps/core-daemon/src/services/embedding-status-service.ts:25`
- `/home/tdwhere/vibe/do-what-new/README.md:96`
- `/home/tdwhere/vibe/do-what-new/package.json:4`
- `/home/tdwhere/vibe/do-what-new/scripts/link-root-bin.mjs:10`
- `/home/tdwhere/vibe/do-what-new/scripts/check-host-prereqs.mjs:84`

## Alaya Adaptation

- User scope provides defaults; Project scope overrides must be auditable。
- Secret storage follows the centralized default in
  [product-alignment-defaults.md](product-alignment-defaults.md).
- Provider/model configured does not imply embedding enabled。
- Doctor reports profile/storage/provider/host prereq status without leaking secrets。

## Non-goals

- 不实现 OS-specific keychain。
- 不实现 cloud sync。

## Scope

- profile model。
- config precedence。
- secret refs。
- provider status。
- import/export/backup。
- doctor/status。

## Inputs

- user profile。
- project profile。
- provider configs。
- secret refs。
- backup/export target。

## Outputs

- effective config。
- audit events for overrides。
- no-secret status reports。
- portable export/import bundles。

## Acceptance

- project override records actor/scope/old/new/reason or preview id。
- profile merge conflict follows the centralized Attach/Profile conflict UX
  default in [product-alignment-defaults.md](product-alignment-defaults.md).
- doctor reports disabled/configured/enabled/degraded provider states。
- import/export preserves evidence refs, governance audit, and source metadata。
- no secret value appears in status/export unless explicitly allowed by a future task。

## Verification

- config precedence tests。
- profile merge preview tests。
- secret redaction tests。
- import/export roundtrip tests。
- doctor snapshot tests。

## Review Lens

- operator safety。
- portability。
- secret redaction。

## Stop Conditions

- If an export can lose evidence/governance context, stop and redesign.
