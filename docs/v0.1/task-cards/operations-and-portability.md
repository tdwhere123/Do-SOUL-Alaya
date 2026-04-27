# ALA-R9 - Operations And Portability

## Goal

实现 User scope / Project scope profile、provider config、secret reference、
portable doctor/status、import/export/backup，并保证跨机器迁移不破坏
source、evidence、governance 与 audit truth。

## Source References

- `docs/v0.1/extraction-ledger.md` - 已冻结 User scope + Project scope
  override、abstract secret refs、env/local-file adapter、import/export/backup
  integrity、provider/embedding 显式 opt-in。
- `/home/tdwhere/vibe/do-what-new/apps/core-daemon/src/index.ts:202` - `DATA_DIR`
  controls daemon database location when supplied。
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/tui-briefs/README.md:96` - same
  `DATA_DIR` reconnect/resume evidence。
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/tui-a-briefs/README.md:37` -
  configured provider/model does not imply embedding enablement。
- `/home/tdwhere/vibe/do-what-new/docs/handbook/frontend/runtime-contract.md:257`
  - read-only secret-free embedding status endpoint。
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/embedding-status.ts:39`
  - disabled embeddings must stay keyword-only and must not carry degraded
  reason。
- `/home/tdwhere/vibe/do-what-new/apps/core-daemon/src/services/embedding-status-service.ts:25`
  - provider/model/storage/degradation inputs for status derivation。
- `/home/tdwhere/vibe/do-what-new/README.md:91` - host doctor command posture。
- `/home/tdwhere/vibe/do-what-new/scripts/check-host-prereqs.mjs:84` - host
  prereq report shape and strict-principal mode。
- `/home/tdwhere/vibe/do-what-new/package.json:4` and
  `/home/tdwhere/vibe/do-what-new/scripts/link-root-bin.mjs:10` - package bin
  and local link/install experience source。

## Source Classification

- `source-backed`: `DATA_DIR` local-state location, package/bin install posture,
  doctor/host prereq reporting, workspace config/status surfaces, and
  provider/embedding status semantics where do-what-new already has explicit
  runtime truth。
- `alaya-adapted`: User/Project profile precedence, import/export/backup
  integrity, portable status reports, and audit semantics are rewritten for
  independent `@do-soul/alaya` product boundaries。
- `alaya-default`: secret references follow the existing Alaya default
  (`abstract secret refs + env/local-file adapter`); this card must not add OS
  keychain acceptance or cloud sync。

## Dependencies

- ALA-R0 source/doc preflight.
- ALA-R1 storage/profile/provider doctor baseline.
- ALA-R4 governance audit rules for profile and trust-boundary changes.
- ALA-R8 Attach/Profile integration for install/config surfaces.

## Parallel With

- ALA-R8 integration work after profile, secret-ref, and status contracts are
  aligned.
- ALA-R10 benchmark work only after export/backup and provider-posture outputs
  are stable enough for fixtures.

## Write Ownership

- Planned profile model, config precedence, secret refs, provider status,
  import/export/backup, doctor/status reports, and focused tests.
- Do not own OS keychain behavior, cloud sync, Inspector state, benchmark view,
  or context pack durable truth.

## Acceptance

- project override records actor/scope/old/new/reason or preview id。
- profile merge conflict follows the centralized Attach/Profile conflict UX
  default in [product-alignment-defaults.md](product-alignment-defaults.md)。
- doctor reports profile/storage/provider/host prereq status and never leaks
  secret values。
- status distinguishes disabled/configured/enabled/degraded provider states。
- import/export preserves source refs, evidence refs, governance audit, profile
  scope, and backup metadata。
- no secret value appears in status/export unless explicitly allowed by a future
  task。

## Verification

Planned implementation verification only:

- config precedence tests。
- profile merge preview tests。
- secret redaction tests。
- provider status state-table tests。
- import/export roundtrip tests。
- doctor/status snapshot tests。

## Review Lens

- operator safety。
- portability。
- secret redaction。
- audit integrity。

## Stop Conditions

- If an export can lose evidence/governance context, stop and redesign。
- If secret handling requires OS keychain behavior to satisfy acceptance, return
  `NEEDS_CONTEXT` instead of adding that default。
- If this card needs changes to task-card defaults or implementation code, stop
  for parent action。

## Implementation Subcards

### ALA-R9.1 - User/project profile and precedence

#### Scope

Define User scope defaults, Project scope overrides, effective-config
resolution, conflict preview, and audit records for profile changes。

#### Source References

- `docs/v0.1/extraction-ledger.md` - User scope + Project scope override is a
  frozen Alaya product decision。
- `docs/v0.1/full-product-loop.md` - installer initializes two profile layers
  and reports local data path/runtime/MCP/Attach status。
- `/home/tdwhere/vibe/do-what-new/docs/handbook/frontend/runtime-contract.md:216`
  - workspace engine config read/update semantics as source material。

#### Acceptance

- Effective config records which values came from User scope, Project scope,
  environment, or runtime default。
- Project override wins over User scope only with actor, timestamp, changed
  fields, and reason or preview id。
- Conflict preview does not write durable state until accepted。
- Profile status can be rendered without reading secret values。

#### Verification

Planned tests cover precedence ordering, conflict preview, audit append, and
effective-config snapshots。

#### Review Lens

Check that precedence is deterministic, auditable, and does not create a hidden
third truth layer。

#### Stop Conditions

Stop if the implementation cannot explain why a Project value won over a User
value。

### ALA-R9.2 - Secret refs and provider status

#### Scope

Implement abstract secret references, provider config status, embedding/provider
posture, and no-secret doctor/status output。

#### Source References

- `docs/v0.1/extraction-ledger.md` - v0.1 secret default is abstract refs plus
  env/local-file adapter, with OS keychain deferred。
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/tui-a-briefs/README.md:37` -
  provider/model configured does not imply embedding enabled。
- `/home/tdwhere/vibe/do-what-new/docs/handbook/frontend/runtime-contract.md:278`
  - endpoint must not return provider secrets, API keys, or raw credentials。
- `/home/tdwhere/vibe/do-what-new/apps/core-daemon/src/services/embedding-status-service.ts:25`
  - provider/model/storage/degradation fields drive status derivation。

#### Acceptance

- Secret refs store identity, source type, and resolution state, never raw secret
  values in status/report output。
- Provider status distinguishes missing, configured, enabled, disabled,
  degraded, and unavailable states where applicable。
- Configured provider/model does not enable embedding or semantic recall by
  itself。
- Secret-resolution failures degrade status with explicit reason and audit
  context。

#### Verification

Planned tests cover no-secret serialization, configured-but-disabled status,
missing provider, unavailable storage, degraded provider, and failed secret ref
resolution。

#### Review Lens

Check no-secret boundaries, explicit opt-in semantics, and provider-status
truthfulness。

#### Stop Conditions

Stop if a status, fixture, export, log, or snapshot contains raw provider
credentials。

### ALA-R9.3 - Import/export/backup integrity

#### Scope

Define portable bundle contents, import validation, backup metadata, restore
policy, and integrity checks for durable memory state。

#### Source References

- `docs/v0.1/extraction-ledger.md` - import/export/backup preserves
  evidence/governance/audit integrity。
- `docs/handbook/invariants.md` - durable memory and governance changes require
  explicit source/evidence/audit。
- `docs/v0.1/full-product-loop.md` - operator can export or back up
  profile/memory bundle after inspection。

#### Acceptance

- Export includes Memory Ontology entries, evidence refs, governance audit,
  profile scope, schema/version metadata, and integrity manifest。
- Import validates bundle version, required evidence refs, governance history,
  and source metadata before writing。
- Restore never silently promotes runtime projections, context packs,
  benchmark views, or Inspector state to durable truth。
- Backup/restore writes auditable events with actor, source bundle id, and
  result。

#### Verification

Planned tests cover export manifest snapshots, missing-evidence rejection,
governance-audit preservation, version mismatch, corrupt bundle rejection, and
roundtrip restore。

#### Review Lens

Check data-loss risk, trust semantics, and whether non-truth projections are
being smuggled into durable storage。

#### Stop Conditions

Stop if import/export cannot prove source/evidence/governance preservation。

### ALA-R9.4 - Portable doctor/status reports

#### Scope

Implement doctor/status reporting for local data path, storage, profile,
provider, MCP/CLI attachment, host prerequisites, backup/export readiness, and
degraded runtime posture。

#### Source References

- `/home/tdwhere/vibe/do-what-new/README.md:91` - host doctor posture。
- `/home/tdwhere/vibe/do-what-new/scripts/check-host-prereqs.mjs:84` - prereq
  report and strict-principal behavior。
- `/home/tdwhere/vibe/do-what-new/apps/core-daemon/src/index.ts:202` - `DATA_DIR`
  location controls daemon DB path。
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/tui-briefs/README.md:96` - same
  `DATA_DIR` supports reconnect/resume evidence。

#### Acceptance

- Doctor reports local data path, storage readiness, profile readiness,
  provider posture, MCP/CLI attachment state, and backup/export readiness。
- Report has human-readable and machine-readable forms with no raw secrets。
- Strict mode can fail on required host prerequisites without changing durable
  memory state。
- Status explains degraded states with actionable reason codes。

#### Verification

Planned tests cover doctor snapshots, strict-mode failure, missing host prereq,
missing `DATA_DIR` fallback, degraded provider, and no-secret output。

#### Review Lens

Check local usability, portability, and whether doctor output is diagnostic
without becoming durable truth。

#### Stop Conditions

Stop if doctor/status needs to mutate profile, provider, or memory state to
produce a report。
