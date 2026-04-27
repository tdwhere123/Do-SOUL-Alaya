# ALA-R8 - Agent Integration

## Goal

实现 MCP-first 接入、CLI fallback、Attach/Profile installer、Codex/Claude Code first targets、optional Gateway envelope。

## Source References

- `/home/tdwhere/vibe/do-what-new/docs/handbook/invariants.md:13`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-a2a-briefs/README.md:99`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-a2a-briefs/README.md:132`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-briefs/task-c9-extension-plane-slicing.md:14`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-briefs/task-c9-extension-plane-slicing.md:253`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/tool-hot-path/conversation-tool-executor.ts:71`
- `/home/tdwhere/vibe/do-what-new/README.md:96`
- `/home/tdwhere/vibe/do-what-new/scripts/check-host-prereqs.mjs:5`

## Source Classification

- `source-backed`: MCP/tool governance boundary、extension plane governance、
  EventLog-first runtime transitions、tool execution records 与 permission policy。
- `alaya-adapted`: Alaya 暴露 MCP server/tools/resources/prompts 与 CLI fallback，
  但两者共享同一 runtime/API/governance boundary；MCP 是 transport/discovery，
  不是 governance 本身。
- `alaya-default`: Attach/Profile preview+confirm 与 Gateway audit/strict envelope
  是 Alaya 独立产品 surface；它们不是 do-what-new direct product surface，也不能
  绕过 Alaya runtime。

## Dependencies

- ALA-R0 source/doc preflight.
- ALA-R1 runtime/API boundary and doctor/status baseline.
- ALA-R4 governance gate and ALA-R7 session trust semantics.
- ALA-R9 profile/config ownership for Attach/Profile writes.

## Parallel With

- ALA-R9 operations work after profile, secret-ref, and status fields are
  aligned.
- ALA-R10 benchmark runner work after Connect/Attach/Gateway activation-mode
  contracts are named.

## Write Ownership

- Planned MCP server/tools/resources/prompts baseline, CLI fallback commands,
  Attach/Profile preview/write, Codex and Claude Code target snippets, Gateway
  runner, and focused tests.
- Do not own full Inspector UI, OS keychain integration, or any integration path
  that bypasses runtime/governance validation.

## Acceptance

- MCP and CLI fallback call the same runtime boundary。
- MCP tools cannot bypass governance/runtime validation。
- Profile writes implement the centralized Attach/Profile conflict UX default in
  [product-alignment-defaults.md](product-alignment-defaults.md).
- Gateway implements the centralized strictness default in
  [product-alignment-defaults.md](product-alignment-defaults.md).
- installed-but-unused sessions are detectable。

## Verification

- MCP contract tests。
- CLI parity tests。
- profile preview/write tests。
- Gateway audit and strict-mode tests。
- Codex/Claude snippet snapshot tests。

## Review Lens

- integration boundary。
- install safety。
- governance bypass risk。

## Stop Conditions

- If MCP/CLI creates separate truth or writes storage directly, stop and fix.

## Implementation Subcards

### ALA-R8.1 - MCP server/tool/resource baseline

#### Scope

- 定义 Alaya MCP server baseline：tools、resources、prompts/discovery metadata、
  runtime endpoint binding、capability disclosure。
- MCP 调用必须进入同一 runtime/API/governance boundary，不得直接访问 storage。
- MCP tool/resource 只能 expose Alaya 操作语义，不拥有 durable truth。

#### Source References

- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-a2a-briefs/README.md:99`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-briefs/task-c9-extension-plane-slicing.md:14`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-briefs/task-c9-extension-plane-slicing.md:253`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/tool-hot-path/conversation-tool-executor.ts:71`
- `../../handbook/invariants.md`

#### Acceptance

- MCP tools cannot bypass governance/runtime validation。
- MCP resource reads distinguish durable ontology, runtime projection, audit summary。
- MCP discovery includes capability and strictness metadata without leaking secrets。
- tool execution has auditable records and permission/governance checks where required。

#### Verification

- Planned contract tests: tool schemas、resource schemas、discovery metadata。
- Planned governance tests: MCP tool path hits runtime/governance boundary。
- Planned audit tests: MCP tool execution records permission outcome。

#### Review Lens

- MCP transport 与 governance boundary 是否分离。
- direct storage access risk。
- tool/resource naming 是否匹配 Alaya public API。

#### Stop Conditions

- If MCP tools write storage directly or skip governance, stop and fix.
- If MCP resources expose projection as durable truth, stop and redesign.

### ALA-R8.2 - CLI fallback parity

#### Scope

- 定义 CLI fallback commands，与 MCP 调用同一 runtime operation：attach/profile、
  recall/context、proposal、session trust、doctor/status。
- CLI 是 fallback/automation surface，不是第二套 truth 或第二套 config。
- CLI 输出必须清楚区分 installed、configured、delivered、used、unverifiable。

#### Source References

- `/home/tdwhere/vibe/do-what-new/README.md:96`
- `/home/tdwhere/vibe/do-what-new/scripts/check-host-prereqs.mjs:5`
- `../extraction-ledger.md`
- `../../handbook/invariants.md`

#### Acceptance

- MCP 与 CLI 对同一 operation 使用同一 runtime contract。
- CLI doctor/status 不宣称未实现 runtime readiness。
- CLI fallback 能在 MCP 不可用时完成同等治理路径，而不是绕过治理。
- CLI output 可被 tests/snapshots 检查，避免 installed-but-unused 混淆。

#### Verification

- Planned parity tests: MCP operation 与 CLI operation payload/result 等价。
- Planned doctor/status tests: reset/extraction 状态不被误报为 runtime-ready。
- Planned audit tests: CLI-triggered operation 有相同 audit trail。

#### Review Lens

- CLI 是否引入第二套 truth。
- output wording 是否避免 readiness 夸大。
- fallback 是否仍然 governance-first。

#### Stop Conditions

- If CLI fallback creates separate truth or bypasses runtime, stop and fix.
- If CLI claims runtime commands exist before package surface exists, stop and revise docs.

### ALA-R8.3 - Attach/Profile preview and confirm flow

#### Scope

- 定义 Attach/Profile installer：target detection、profile diff preview、conflict
  explanation、per-target confirm、write audit。
- 首批 target 是 Codex + Claude Code；user scope 与 project scope override 都必须
  明确。
- Attach/Profile 写入是 installation/config behavior，不是 memory truth 或 usage
  proof。

#### Source References

- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-briefs/task-c9-extension-plane-slicing.md:14`
- `/home/tdwhere/vibe/do-what-new/scripts/check-host-prereqs.mjs:5`
- `../extraction-ledger.md`

#### Acceptance

- preview 显示将写入的文件、scope、target agent、conflict 与 rollback hint。
- confirm 是 per-target/per-scope，不自动合并 global 与 project rules。
- install result 只能产生 installed/configured 状态，不产生 delivered/used 状态。
- all writes have audit records with operator decision and reason when provided。

#### Verification

- Planned snapshot tests: Codex profile preview、Claude Code profile preview、
  project override preview。
- Planned confirmation tests: accept、decline、conflict、partial target success。
- Planned trust tests: install/config 不会生成 used proof。

#### Review Lens

- install safety 与 operator consent。
- user/project scope override 是否清楚。
- installed/configured 与 delivered/used 是否严格分离。

#### Stop Conditions

- If Attach/Profile writes without preview+confirm, stop and fix.
- If installer output is treated as memory usage proof, stop and align with ALA-R7.

### ALA-R8.4 - Gateway audit/strict envelope

#### Scope

- 定义 optional Gateway envelope：audit mode default、strict mode via explicit flag
  or benchmark profile、runtime/session/context/proposal enforcement。
- Gateway 使用同一 Alaya runtime/session/context APIs，不实现另一套 recall 或 trust。
- strict envelope 可阻断绕过 Alaya 的 execution path，并保留 audit evidence。

#### Source References

- `/home/tdwhere/vibe/do-what-new/docs/handbook/invariants.md:13`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-a2a-briefs/README.md:132`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-briefs/task-c9-extension-plane-slicing.md:253`
- `../extraction-ledger.md`

#### Acceptance

- default Gateway mode 是 audit，不默认强制 blocking。
- strict mode 必须由 command flag 或 benchmark profile 显式开启。
- Gateway audit links session、context pack、provider decision、proposal/trust
  records。
- Gateway 不把 enforcement log 当成 durable memory truth。

#### Verification

- Planned tests: audit default、strict flag、benchmark strict profile、bypass detected、
  audit linkage。
- Planned parity tests: Gateway operation 与 MCP/CLI runtime result 使用同一 contract。
- Planned trust tests: Gateway delivered context 仍不等于 used proof。

#### Review Lens

- strictness default 是否符合 Alaya product default。
- Gateway 是否只是 envelope，不是新 runtime。
- bypass/audit evidence 是否足够支持 benchmark。

#### Stop Conditions

- If Gateway implements separate recall/trust logic, stop and redesign.
- If strict blocking is enabled by default without explicit flag/profile, stop and fix.
