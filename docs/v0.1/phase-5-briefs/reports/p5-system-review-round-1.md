# Phase 5 System Review — Round 1 (Merged)

- **Date**: 2026-05-03
- **HEAD at review**: `8e5051a`
- **Reviewers (10)**: architect / red-team / sql-pro / install-release / pr-review / test-automator / plan-challenger / documentation / typescript-pro / codex (external)
- **Convergence status**: **NOT CONVERGED** — Round 2 required after fix-loop
- **Initial findings (deduplicated)**: **Blocking 11 / Important 21 / Nice-to-have 11**
- **Source drafts (not in git)**: `.do-it/p5-system-review/round-1/{architect,redteam,sql,install-release,pr-review,tests,plan-challenge,docs,types,codex}.md`

---

## Executive Summary

Gate-5 关闭时声明的"零 Blocking/零 Important"在 10 维度独立扫描下**站不住**。共出现 11 条新 Blocking（多数与已修 finding 同根但落在另一路径或另一边界），其中 5 条由多个 reviewer 独立确认、根因聚类到同一架构原则缺失："Alaya redesign 默认未做 scope/isolation"。`#BL-024` 在多个角度被证明已经是发布范围内的事实漏洞而非"backlog 可推后"。

"真实可用 + 稳定运行" 的工程师视角判断：**部分能** —— 仓库内通过 `node ./bin/alaya.mjs` 直跑 MCP happy path 可闭环；但 (a) 文档承诺的 `pnpm exec alaya` 命令实际未注册到 PATH，attach 写入用户 codex/claude 配置后必然 spawn 失败；(b) 一个 MCP 写入工具信任 LLM 提供的 workspace/run scope；(c) HTTP 路径事务破口、跨 workspace 泄露、shutdown 不 drain 等失败模式仍存在。这些都需在 Round 2 收敛前关闭。

---

## Blocking findings (11)

### MR-B01 · HTTP `/proposals/:id/review` 非原子 + 非串行 + 无 workspace 校验（#BL-024 升级）
- **What**: HTTP `POST /proposals/:id/review` 路由直接调 `ProposalService.review()`，跨 9 步独立 SQL 写盘（无事务）；并发两路同 ID 可双倍 karma + last-writer-wins；任何 localhost 客户端不需 workspace context 即可解析任意 proposal。
- **Where**:
  - `apps/core-daemon/src/routes/proposals.ts:33-49`（HTTP route，无 lock / 无 CAS / 无 workspace guard）
  - `packages/core/src/proposal-service.ts:218-317`（非原子 review 序列）
  - `packages/core/src/proposal-service.ts:305-309`（用 `updateResolution` 而非 `updatePendingResolution`）
  - 对照已修 MCP 路径：`apps/core-daemon/src/mcp-memory-proposal-workflow.ts:72-77,134-231,238-257`
- **Root Cause**: `2f3ea08` / `9509e6c` 仅在 MCP 路径做 atomize+CAS+per-proposal lock，HTTP 路径是同一逻辑的 vendor 多 service 调用残留。`#BL-024` 把它当 backlog 推后，但 daemon 进程实际监听 HTTP（`apps/core-daemon/src/index.ts:1058-1062`），等于带病发布。
- **Fix Direction**: **删除 HTTP `POST /proposals/:id/review`** —— v0.1.0 release surface 是 MCP+CLI，HTTP route 不是发布表面；`routes/proposals.ts:33-49` 删除路由 + `app.ts` 同步移除注册 + 添加路由级测试断言"删除后返回 404"。这是最小代码改动 + 完全消除事务破口，同时 close `#BL-024`。如未来 v0.2+ 需要 HTTP 入口，再走完整 atomic 化（详见 `.do-it/p5-system-review/round-1/sql.md` 附录）。
- **Verify**: `git grep -n "POST.*proposals/.*review"` 无命中；新加 `routes-proposals.test.ts` 断言 POST 返回 404；vitest 全集通过；端到端 `tools call soul.review_memory_proposal` 仍工作。
- **Reported by**: red-team (F-red-002), sql-pro (F-sql-001), pr-review (F-pr-004), plan-challenge (F-pc-004), codex (F-codex-004)

### MR-B02 · HTTP `GET /memories/:id` 跨 workspace 泄露 memory 内容
- **What**: commit `41d6dad` 修了 MCP `soul.open_pointer` 的 workspace scope 检查，但等价的 HTTP `GET /memories/:id` 路径未修；任何 localhost 客户端凭 `object_id` 即可读取任何 workspace 的 memory 内容。修在了错误的边界（MCP handler 而非 service 层）。
- **Where**:
  - `apps/core-daemon/src/routes/memories.ts:33-41`
  - `apps/core-daemon/src/app.ts:245-270`（`isProtectedRequest` 不含 `/memories/:id`）
  - 对照已修：`apps/core-daemon/src/mcp-memory-tool-handler.ts:219-224`
- **Root Cause**: open_pointer 漏洞修在 MCP handler 而非 `MemoryService.findById` 数据访问层；HTTP route 直接调 service 绕过 handler 修复。
- **Fix Direction**: 双重根治：(a) 在 `MemoryService` 加 `findByIdScoped(objectId, workspaceId)` 方法（service 层 scope）；(b) 删除 `routes/memories.ts` GET 路由（HTTP 不是 release surface），与 MR-B01 一并；MCP handler `open_pointer` 改用 `findByIdScoped`；废弃裸 `findById`。
- **Verify**: `git grep "memoryService.findById\b"` 无命中；新增 negative-path 测试用例：foreign workspace context → NOT_FOUND。
- **Reported by**: pr-review (F-pr-001)

### MR-B03 · `soul.emit_candidate_signal` 信任 LLM 提供的 workspace/run scope
- **What**: MCP handler 接受请求 payload 中的 `workspace_id` / `run_id` / `surface_id`，忽略可信的 MCP call context。被附加的 agent 可写入任何 workspace 的 candidate signal。
- **Where**: `apps/core-daemon/src/mcp-memory-tool-handler.ts:232-242`
- **Root Cause**: Alaya MCP handler 在 clean-room 这条路径时丢失了 vendor `scopeOverride` 行为（`vendor/do-what-new-snapshot/packages/soul/src/signal-handler.ts:74-87`）。
- **Fix Direction**: 强制使用 `context.workspaceId` / `context.runId` 作为 scope，要求 `runId` 非 null 否则 VALIDATION；从公开 input schema 移除 scope 字段或在 server-side overwrite。
- **Verify**: 回归测试：payload scope 为 `foreign-ws/run` 但 context 为 `workspace-1/run-1` 时，存储的 signal 必须用 context scope；缺 runId 必须返回 VALIDATION。
- **Reported by**: codex (F-codex-001)

### MR-B04 · ProposalService 与 ClaimService 属性名漂移被 `as never` 掩盖（claim event 顺序错乱）
- **What**: `ProposalService.review()` 把 deferred 事件存进 `options.deferredNotificationEvents`，但 `ClaimService.transitionLifecycle` 实际读 `options.deferredBroadcastEvents`。两边属性名不一致，runtime 时 `options.deferredBroadcastEvents` 为 undefined，claim-lifecycle 事件**先于** review-created 广播。`apps/core-daemon/src/index.ts:451-460` 用 `claimService as never` 掩盖了 TS 结构不匹配错误；`proposal-service.test.ts:521-572` 是 false-green（mock 假设 intended 接口而非真实 ClaimService）。
- **Where**:
  - `packages/core/src/proposal-service.ts:55-66, 378-384`
  - `packages/core/src/claim-service.ts:163, 190, 234, 266-270`
  - `apps/core-daemon/src/index.ts:451-460` (`as never`)
  - `packages/core/src/__tests__/proposal-service.test.ts:521-572` (false-green mock)
- **Root Cause**: Adapter 漂移；`as never` 让 TS 看不到错误；测试用 mock 验证"intended"而不验证"production"。
- **Fix Direction**: 统一属性名为 `deferredNotificationEvents`（其余 service 已用此名）→ 改 `claim-service.ts` 内全部出现；删除 `as never` cast；用真实 `ClaimService` 或精确 spy（仅 honor 实际属性名）替换测试 mock。
- **Verify**: `git grep "deferredBroadcastEvents"` 无命中（除注释）；`git grep "as never" apps/core-daemon/src/index.ts:451-460` 无命中；新测试断言 review accept 时 `notifyEntry` 顺序为 `review.created → claim.lifecycle_changed → review.completed → proposal.resolved`。
- **Reported by**: red-team (F-red-001)

### MR-B05 · `alaya` 二进制未注册到 PATH，但 attach 写入 `command="alaya"`，导致 MCP 子进程必然 spawn 失败
- **What**: 仓库无任何 `package.json` 暴露 `bin: { alaya: ... }`，`pnpm exec alaya` 实际报 `Command "alaya" not found`。但 `attach codex` / `attach claude` 把 `command="alaya"` 写进用户 `~/.codex/config.toml` / `~/.claude.json`。Codex/Claude Code 拉起 MCP 子进程时找不到 `alaya`，链路断裂。`alaya doctor` 当前看不出。
- **Where**:
  - `package.json:1-19`（无 bin）
  - `apps/core-daemon/package.json:1-22`（无 bin / files / engines）
  - `apps/core-daemon/src/profile-mutation.ts:100-101`（`ALAYA_MCP_COMMAND = "alaya"`）
  - `bin/alaya.mjs:1-119`（入口存在但未注册）
  - `README.md:113-118`、`CLAUDE.md:138-152`（文档承诺 `pnpm exec alaya`）
- **Root Cause**: 全部 release E2E 走 in-memory MCP transport（`gate4-attached-agent-mcp-proof.test.ts`），从未验证真实 stdio 子进程 spawn。
- **Fix Direction**:
  1. 根 `package.json` 加 `"bin": { "alaya": "./bin/alaya.mjs" }`（root 已 `private: true`，仅暴露在 `node_modules/.bin/`）。
  2. `apps/core-daemon/src/profile-mutation.ts` 检测 `process.env.ALAYA_MCP_LAUNCHER` 覆盖；如未设置则启动前用 `which alaya` 校验，找不到回退为 `command: "node", args: [<repo-abs>/bin/alaya.mjs, "mcp", "stdio"]` 或 fail-fast 提示用户 `pnpm link --global`。
  3. README + CLAUDE.md 把 `pnpm install + pnpm build` 标为 prerequisite。
- **Verify**: `pnpm install && which alaya` 解析到 `node_modules/.bin/alaya`；`CODEX_HOME=$(mktemp -d) pnpm exec alaya attach codex --yes` 后生成的 toml 命令在该 sandbox spawn 成功。
- **Reported by**: install-release (F-inst-001), codex (F-codex-002)

### MR-B06 · `alaya install` 不做 schema/build/db 前置检查；`alaya doctor` 看不出来
- **What**: `install` 仅 render `alaya.toml` + `.env`；不 open SQLite、不跑 migration、不 verify schema 版本、不检查 `apps/core-daemon/dist/` 是否存在。`doctor` 仅文件存在 + W_OK 检查，看不出 schema 状态。用户从 `pnpm i` 跑到 `tools call` 必断在中间。
- **Where**:
  - `apps/core-daemon/src/cli/install.ts:54-140`
  - `apps/core-daemon/src/cli/doctor.ts:181-215`
  - `bin/alaya.mjs:9-11`（依赖 dist/）
- **Root Cause**: install 设计目标是 "render 配置"，但用户合理预期是 "make this work"。
- **Fix Direction**:
  1. `install` 写 toml 之后调 `applyMigrations(resolved.db_path)` 实际打开 SQLite + 跑 migration；失败回滚 toml。
  2. `install` 入口检查 `apps/core-daemon/dist/cli/bridge.js` 存在；缺则 exit-code 75 + stderr 提示 `run pnpm build first`；同样改进 `bin/alaya.mjs:23-29` 的 catch 文案。
  3. `doctor.ts:inspectStorage` 加 `schema_ok` 字段：用 storage 包的 `MIGRATION_FILES.length` vs db `schema_migrations` 表比对，不匹配则 `checks.storage = "fail"`。
- **Verify**: 删 `~/.config/alaya`，install 后 `~/.config/alaya/alaya.db` 应有 migration 后的表；故意 `rm -rf apps/core-daemon/dist`，install 应 exit-code 75 而非 throw `Cannot find module`。
- **Reported by**: install-release (F-inst-002)

### MR-B07 · `alaya install` 中途崩溃记 `partial_state` 但不回滚
- **What**: install 顺序写 secret → toml → env，任一步失败留下脏状态；catch 仅写 audit `failed`，不 rollback；二次 install 不会读 audit、不会警告 partial_state。对比 `profile-mutation.ts:307-329` 已有 `restoreOperationBefore` 反向 unwind —— install 没有同等设计。
- **Where**:
  - `apps/core-daemon/src/cli/install.ts:72-139`
  - 对照 `apps/core-daemon/src/profile-mutation.ts:307-329`
- **Root Cause**: install 没用 plan/apply/rollback 模式；audit 是事后记录而非事务边界。
- **Fix Direction**:
  1. install 改成 plan/apply/rollback：`partialState` 同时记录 `{path, beforeContent | undefined}`；catch 倒序写回 before（before 为 null 时 unlink）。
  2. `executeInstall` 入口先扫最近 `audit/install-*.json`，发现 `status === "started"|"failed"` 要求 `--force` 或先报告 partial_state。
  3. 同时修复 `profile-mutation.ts:307-329` 的 rollback 失败补偿（捕获每个 `restoreOperationBefore` 失败累积进 composite Error，原 error 通过 `Error.cause` 保留；audit 写 `rollback_failure` 类型行供 `doctor` 后续读取）。
- **Verify**: mock fs 让 env 写抛错 → toml 与 .env 内容应与 install 前一致；`alaya install` 两次的 hash 一致（idempotent）。
- **Reported by**: install-release (F-inst-003), architect (F-arch-003, F-arch-004)

### MR-B08 · 上一轮 review 报告缺 review-protocol §"Review Finding Record" 8 字段，结论非合法 review 输出
- **What**: `review-protocol.md:42-72` 规定每条 finding 必须含 ID/Severity/Headline/Location/Observed/Expected/Repro·Witness/Cause Class 8 字段。Round-1（上一轮）的 4 个 perspective 报告全部以"closed by `fix(...)` commit"一句话替代 finding 记录。技术上不构成合法 review 产出，Gate-5 "PASS" 站不住。
- **Where**:
  - `docs/v0.1/phase-5-briefs/reports/p5-final-review-perspective-{a,b,c,d}.md`（4 文件）
  - 对照模板：`docs/v0.1/phase-2-briefs/reports/post-gate-2-review.md:49-100`
- **Root Cause**: task-card §2.3 写"produce a similar report shape"被解读为"结论格式相似"而非"字段格式相同"。re-reviewer 没把 8 字段缺失判为 Blocking。
- **Fix Direction**:
  1. `review-protocol.md` §Checklist 末尾加硬条："若任何 finding 缺 8 字段则该次 review 自身为 Blocking — 不允许结论上岸。"
  2. task-card 模板 §2.3 的 "MAY produce similar shape" 改 "MUST be a Review Finding Record block (all 8 fields)"。
  3. 本轮所有 finding 在合并入 git 前已遵循（"What/Where/Root Cause/Fix Direction/Verify/Reported by"映射 8 字段 + 在 fix-task 完成时补全 Repro·Witness 测试 path）。
- **Verify**: `grep -L "Severity:" docs/v0.1/phase-5-briefs/reports/p5-final-review-perspective-*.md` 必须返回空。
- **Reported by**: plan-challenge (F-pc-001)

### MR-B09 · Perspective D 在最后一次 docs-only 修复后**主动跳过** re-review 但记 CLEAR（违反 review-protocol §127-131）
- **What**: review-protocol.md §127-131 规定"Blocking/Important — fresh reviewer-agent pass. Acceptance requires zero on the fix commit itself"。Perspective D 报告 line 22-24 白纸黑字说 "The final docs-drift rerun was intentionally not dispatched after the last docs-only fix per user instruction. Controller disposition is CLEAR based on the targeted sweep below"。Controller 既是被审者（修了 D 的 finding）又是审者（自己签 CLEAR），破坏 4-perspective 互检独立性。
- **Where**:
  - `docs/v0.1/phase-5-briefs/reports/p5-final-review-perspective-d.md:22-24`
  - `docs/v0.1/phase-5-briefs/reports/task-p5-final-review.md:71-74`
  - 被违反的硬规则：`docs/handbook/workflow/review-protocol.md:127-131`
- **Root Cause**: review-protocol.md 没有写明"user instruction 不是 re-review 弃权理由"。
- **Fix Direction**: 在 `review-protocol.md` 加硬条："Skipping re-review at user request is forbidden when the fix-loop emitted any Important or Blocking findings; user can defer the *card*, never the *re-review*."
- **Verify**: `grep -rn "per user instruction" docs/v0.1/phase-5-briefs/reports/` 无命中（或仅出现在被 supersede 的旧报告中）。
- **Reported by**: plan-challenge (F-pc-002)

### MR-B10 · 3 条已修 Blocking 共享同一根因（默认无 scope/isolation），无人抽象为 invariant，复发风险高
- **What**: `confine import storage restore` / `scope pointer opens by workspace` / `use configured daemon storage` —— 3 条 Blocking 各自看是独立 bug，本质都是"Alaya 自己重新设计的层默认无 scope/isolation"。Phase 6 / v0.1.1 是新代码，根因不抽象就会复发。
- **Where**: 上一轮 perspective-a + perspective-c 报告中三条 Blocking 描述；`docs/handbook/invariants.md` 中无对应不变式。
- **Root Cause**: review-protocol.md §"Cause Class" 是单点标签，没要求收口阶段做跨 finding 聚类；缺"防复发清单"机制。
- **Fix Direction**:
  1. `docs/handbook/invariants.md` 增加 §"Default Scope Invariant"：requires-redesign / clean-room 的存储/路径/资源访问，**默认必须 workspace-scoped 且 caller-context-bound**；缺失即 Blocking by default。
  2. `review-protocol.md` 加节"Cause Class Aggregation"：单轮 ≥2 条同 cause class 必须开 backlog 票要求 invariant 化。
  3. 3 条已闭环 Blocking 的回归测试模板化（提取为可复用 fixture，Phase 6 新代码必经）。
- **Verify**: `docs/handbook/invariants.md` 含新 § 编号；下次 task-card 模板含 "scope-default Blocking" 复选。
- **Reported by**: plan-challenge (F-pc-003)

### MR-B11 · `9509e6c` 的"并发 CAS race"测试是 false-green（进程内锁串行了两次调用，根本没触达 CAS）
- **What**: commit 9509e6c 加的 governance 测试 "rolls back duplicate review events when pending-state CAS loses" 用 `Promise.allSettled` 模拟并发，但同 commit 引入的 `proposalReviewLocks: Map<string, Promise<void>>`（`mcp-memory-proposal-workflow.ts:72-77, 238-257`）会把第二个调用串行排队；锁释放后第二次 `findScopedById` 已读到 ACCEPTED 直接 VALIDATION，**根本不会进 updatePendingResolutionWithEvents**。CAS 路径在 mock 实现下没被真正测过。同 commit 的进程内锁在 `2f3ea08` atomize 后已是冗余冗余防御，未清理。
- **Where**:
  - `apps/core-daemon/src/mcp-memory-proposal-workflow.ts:72-77, 138-146, 238-257`
  - `apps/core-daemon/src/__tests__/mcp-memory-governance.test.ts`（"prevents duplicate ..." 用例）
- **Root Cause**: 测试断言强度不够；进程内锁在 storage CAS 落地后未做清理。
- **Fix Direction**:
  1. 移除 `proposalReviewLocks` + `withProposalReviewLock`，依赖 SQLite transaction CAS（多进程亦正确）。
  2. governance 测试改为 mock `findScopedById` 两次返回 PENDING + `updatePendingResolutionWithEvents` 第二次抛 CONFLICT，断言：events 数 == 3、第二次 promise rejected with VALIDATION。
- **Verify**: `git grep "proposalReviewLocks\|withProposalReviewLock"` 无命中；governance vitest 在 PENDING+CONFLICT mock 下断言通过。
- **Reported by**: pr-review (F-pr-002, F-pr-003)

---

## Important findings (21)

### Architecture / runtime

#### MR-I01 · `runtime-notifier.notifyAll` 把 listener 异常反传到 mutation 调用者
- **What**: `notifyAll` 串行 `await listener(value)` 无 try/catch；任一 listener 抛错会中断后续 listener、且把 reject 反传到 `notifyEntry` 调用者，让 EventLog+DB 已 commit 的 service 调用看到失败响应。
- **Where**: `apps/core-daemon/src/runtime-notifier.ts:63-85, 112-120`；callers 遍布 `packages/core/src/*-service.ts` 与 `apps/core-daemon/src/{index.ts:1411, mcp-memory-proposal-workflow.ts:130,225, services/soul-approval-service.ts:79, routes/files.ts:326, routes/e2e-event-triggers.ts:138}`。
- **Root Cause**: notifier 设计上是 commit-tail 的 best-effort fan-out，但实现把它放进 mutation 关键路径，无隔离。
- **Fix Direction**: `notifyAll` 中每 listener 套 `try/catch`，warn-log 后继续 fan-out；`notifyEntry` 必须在所有 EventLog/DB 已 commit 后总是 resolve。
- **Verify**: 新单测：注册一个 throwing listener + 一个 healthy listener，断言 healthy listener 被叫到、`notifyEntry` resolves。
- **Reported by**: architect (F-arch-001), red-team (F-red-004), test-automator (F-test-006), codex (F-codex-005)

#### MR-I02 · MCP `proposeMemoryUpdate` 创建路径非原子（与 #BL-024 同类，但在 create path）
- **What**: `mcp-memory-proposal-workflow.ts:110-130` 先 `eventLogRepo.append(SOUL_PROPOSAL_CREATED)` 再 `proposalRepo.create()` 两次独立 commit；后者失败会留下幽灵 EventLog 行，且不会被 `orphan-radar` 检出（它只查 `MEMORY_DELIVERED`/`MEMORY_USAGE_REPORTED`）。
- **Where**:
  - `apps/core-daemon/src/mcp-memory-proposal-workflow.ts:110-131`
  - `packages/storage/src/repos/proposal-repo.ts:169-194`（无 transaction wrapper）
  - `apps/core-daemon/src/orphan-query.ts:88-92`（不查 proposal 类）
- **Root Cause**: review path 修了原子性，create path 没改。
- **Fix Direction**: `ProposalRepo` 加 `createProposalWithEvents(input, events)` 方法，参考 `updatePendingResolutionWithEvents`，单 transaction 执行 EventLog append + proposals insert；workflow 改用之。
- **Verify**: 单测：注入 `createStatement.run` 抛错，断言 EventLog 行被回滚。
- **Reported by**: architect (F-arch-002)

### Concurrency / failure modes

#### MR-I03 · MCP zod schema 无 max length / max items / max properties — 内存放大型 DoS
- **What**: `NonEmptyStringSchema = z.string().min(1)` 无 `.max()`；`proposed_changes: z.record(z.unknown())` 无深度/大小限制；`used_object_ids` 无 array max。任何本地进程通过 stdio MCP 可发 100MB 字符串/1GB 对象触发 OOM 或炸 DB。
- **Where**:
  - `packages/protocol/src/schema-primitives.ts:3`
  - `packages/protocol/src/soul/mcp-types.ts:13-156`
  - `apps/core-daemon/src/mcp-memory-tool-catalog.ts:67-205`
- **Fix Direction**: 加 `BoundedStringSchema = z.string().min(1).max(N)` 系列（query 4096 / id 64 / reason 16384）；`proposed_changes` 用 `MemoryEntryMutableFieldsSchema` 限定字段；array 加 `.max(M)`；catalog 镜像 `maxLength` / `maxItems` / `maxProperties`（与 MR-I04 DRY 化协同）。
- **Verify**: 单测 `SoulMemorySearchRequestSchema.parse({ query: "x".repeat(1e8) })` 必拒绝；集成测试发 1GB payload daemon 必返回 VALIDATION 且 RSS 不爆。
- **Reported by**: red-team (F-red-003)

#### MR-I04 · MCP 工具 inputSchema 双源漂移（catalog 手写 JSON Schema vs zod runtime schema）
- **What**: `mcp-memory-tool-catalog.ts` 手写 JSON Schema 与 `mcp-types.ts` 的 zod schema 平行，约束不一致：catalog 缺 `signal_kind` 枚举、缺 `confidence ∈ [0,1]`、缺非空、缺枚举受限等。外部 MCP 客户端按 catalog 校验通过的请求会被 runtime 拒，反之亦然。
- **Where**:
  - `apps/core-daemon/src/mcp-memory-tool-catalog.ts:91-192`
  - `packages/protocol/src/soul/mcp-types.ts:23-129`
- **Fix Direction**: 用 `zod-to-json-schema` 从 zod 派生 catalog；catalog 内删除手写常量。
- **Verify**: `alaya tools list --json | jq` 输出含 zod 全部约束；新单测：每工具 zod 派生 JSON Schema 与 catalog 一致。
- **Reported by**: typescript-pro (F-types-001)

#### MR-I05 · `SoulOpenPointerResponse.content` 用 `z.record(z.unknown())` 暴露整个 MemoryEntry
- **What**: handler `mcp-memory-tool-handler.ts:225-229` 把 `MemoryEntry` 整 spread 进 `content`；schema 不约束字段；内部字段（lifecycle_state / created_by / storage_tier / workspace_id 等）漏给外部。
- **Where**: `apps/core-daemon/src/mcp-memory-tool-handler.ts:225-229`；`packages/protocol/src/soul/mcp-types.ts:47-53`
- **Fix Direction**: 在 mcp-types 加 `SoulOpenPointerContentSchema` 显式投影（object_id / object_kind / schema_version / content / domain_tags / evidence_refs）；handler 改显式 projection 而非 spread。
- **Verify**: 测试 `tools call soul.open_pointer` 输出不含 created_by / lifecycle_state。
- **Reported by**: typescript-pro (F-types-003)

#### MR-I06 · Daemon shutdown 不 drain in-flight HTTP/MCP 请求 → DB 在请求中途被关
- **What**: shutdown 顺序 `gardenStop → mcp close → server.close → database.close`；`server.close` 仅等 socket idle，不等 handler 异步链；SIGTERM 后还接受新请求；mid-write SIGTERM 留下半完成的 EventLog。
- **Where**: `apps/core-daemon/src/index.ts:997-1023, 1064-1069, 1489-1507`
- **Fix Direction**: 加 in-flight counter 中间件 + drain 中间件（SIGTERM 后 503 拒新请求 + 等 in-flight 归零，超时再 force close）；`database.close()` 移到 drain 完成后。
- **Verify**: 测试：发慢请求 → SIGTERM → 断言 DB 在请求结束后才关。
- **Reported by**: red-team (F-red-005)

#### MR-I07 · `getNextRevision` 与 append 跨 await，并发产生 SQLITE_CONSTRAINT 不可控失败
- **What**: `getNextRevision` 是 async；await 之间 JS event loop 可调度另一 handler；单 unique 索引兜底但抛 raw `StorageError` 而非业务级 CONFLICT，部分 side effects 已落地。
- **Where**: `packages/core/src/proposal-service.ts:225-228, 471-480`；`packages/storage/src/repos/event-log-repo.ts:257-287, 415-420`
- **Fix Direction**: `eventLogRepo.append` 内部把 `MAX(revision)+1 → INSERT` 包进 `connection.transaction(...)` 内同步 prepared 语句，消除 read-modify-write 在 JS 层的窗口。
- **Verify**: 并发两路 append 同 entity 不应抛 unique；revision N、N+1 各一行。
- **Reported by**: red-team (F-red-006)

### Storage / SQL

#### MR-I08 · SQLite 缺 `journal_mode=WAL` / `busy_timeout` / `synchronous=NORMAL` PRAGMA
- **What**: `initDatabase` 仅设 `foreign_keys = ON`；任何未来多连接场景（备份/导出/test-double）会立即 SQLITE_BUSY。
- **Where**: `packages/storage/src/db.ts:50-57`
- **Fix Direction**: append `journal_mode=WAL` / `busy_timeout=5000` / `synchronous=NORMAL`；`:memory:` 自动忽略。
- **Verify**: 启动后 `database.pragma("journal_mode")` 返回 `wal`；并发 reader 不阻塞 writer。
- **Reported by**: sql-pro (F-sql-002)

#### MR-I09 · `EventPublisher.publishWithMutation` 用应用层 `deleteById` 补偿，不是真事务回滚
- **What**: `append → mutate → 失败时 deleteById` 三步独立 commit；中途崩溃留幽灵行；replay 看到"X 已发生"但 mutate 没持久化。涉及 ~12 个 service 调用点。
- **Where**: `packages/core/src/event-publisher.ts:40-102`；callers 列于 architect/sql 草稿
- **Root Cause**: PDD §2 不允许 packages/core 拿 `SqliteConnection`，做不到真事务包裹。
- **Fix Direction**:
  - 短期：在 `EventPublisherEventLogRepoPort` 加 `appendManyWithMutation(eventInputs, mutate)` 端口方法；`SqliteEventLogRepo` 实现内 `connection.transaction(() => { append... ; mutate(); })`；mutate 必须同步签名。
  - 同步：在 `invariants.md` 显式登记 "EventPublisher 补偿删除是已知 divergence，非真事务" 直到上述端口完成。
- **Verify**: storage-level fault-injection test：mutate 抛错前注入 SIGKILL 模拟，断言 EventLog 留幽灵行（用以固化缺陷范围，再随 fix 转绿）。
- **Reported by**: sql-pro (F-sql-003)

#### MR-I10 · `apps/core-daemon/src/__tests__` 完全没有 HTTP `/proposals/:id/review` 集成测试
- **What**: 在 MR-B01 删除该路由后，本条作为 "新增 routes-proposals.test.ts 断言 404" 的强制项保留。
- **Where**: 缺：`apps/core-daemon/src/__tests__/routes-proposals.test.ts`
- **Fix Direction**: 与 MR-B01 一并；新测试断言 POST `/proposals/:id/review` 返回 404 / METHOD_NOT_ALLOWED；GET 路由（如保留）需有 workspace 校验断言。
- **Verify**: 新文件 vitest 通过。
- **Reported by**: sql-pro (F-sql-004)

### Install / release readiness

#### MR-I11 · `alaya doctor` 把 `mcp.transport=ready` 硬编码，看不出 stdio 子进程能否启动
- **What**: `register.ts:38-41` 注入的 `getMcpHealth` 只看 daemon 内部状态；不 probe attach 写入的 codex/claude 配置中 `command` 是否在 PATH 解析；MR-B05 的链路断裂在 doctor 看是 green。
- **Where**: `apps/core-daemon/src/cli/register.ts:38-41`；`apps/core-daemon/src/cli/doctor.ts:85-104`
- **Fix Direction**: `getMcpHealth` 真探测：(a) 解析 `~/.codex/config.toml` / `~/.claude.json` 中 `mcp_servers.alaya.command` → `which` 解析；(b) 暴露 `command_resolvable: bool` + `command_path: string|null`；不 resolvable 时 fail。
- **Verify**: unset PATH 中 alaya 后，`alaya doctor` 应输出 `mcp.transport=not_ready`。
- **Reported by**: install-release (F-inst-004)

#### MR-I12 · `alaya detach` 静默 miss path 漂移
- **What**: detach 在 `mcpBefore===undefined && slashBefore===undefined` 时静默返回 "nothing to detach"，但 path 检测候选可能漂移（自定义 `ALAYA_CODEX_SLASH_COMMANDS_PATH` 或选错优先级）。
- **Where**: `apps/core-daemon/src/cli/detach.ts:90-97`；`apps/core-daemon/src/profile-mutation.ts:193-229`
- **Fix Direction**: detach 在 "nothing to detach" 分支输出 `searched: [path1, path2, ...]`；JSON 模式同样字段。
- **Verify**: 测试用例：用 env 自定义路径 attach 后再无 env detach，输出含 searched paths。
- **Reported by**: install-release (F-inst-005)

#### MR-I13 · 子包均无 `private: true` / `publishConfig` / `files`，存在被误 publish 风险
- **What**: 所有 workspace package（packages/* 与 apps/{core-daemon,inspector,inspector/web}）都无防发布字段，默认会把 src/ + __tests__/ + tsconfig 全部推上 npm。
- **Where**: `apps/core-daemon/package.json:1-22`；`packages/{core,protocol,soul,storage,engine-gateway}/package.json`；`apps/inspector/package.json`
- **Fix Direction**: v0.1 全部加 `"private": true`；后续真要发布时再换 `publishConfig`+`files`+`engines`。
- **Verify**: `pnpm -r publish --dry-run` 全部回报 `package marked private`。
- **Reported by**: install-release (F-inst-006)

#### MR-I14 · `apps/core-daemon` / `packages/*` 缺 `engines` 字段（root 有但不会被 publish 时继承）
- **What**: `bin/alaya.mjs` 用 top-level await（Node 14.8+），daemon 用 `import.meta.dirname`（Node 20+）。子包不声明 engines，发布到 npm 时 npm 不会从 root 继承。
- **Where**: `apps/core-daemon/package.json`、`packages/*/package.json`
- **Fix Direction**: 子包加 `"engines": { "node": ">=20.19.0" }`，与 root 对齐。
- **Verify**: `node -p "require('./apps/core-daemon/package.json').engines.node"` 输出 `>=20.19.0`。
- **Reported by**: install-release (F-inst-007)

### Test coverage

#### MR-I15 · attach-codex / attach-claude / cli-detach / cli-tools / cli-install / runtime-notifier 失败路径覆盖不足
- **What**: 五条命令封装层均"happy-path-only"；errors 分支与 audit `failed` 行内容均无断言；`runtime-notifier.test.ts` 不钉异常隔离行为；`cli-doctor.test.ts` 完全缺失。
- **Where**:
  - `apps/core-daemon/src/__tests__/{attach-codex,attach-claude,cli-detach,cli-tools,cli-install,runtime-notifier}.test.ts`
  - 缺：`apps/core-daemon/src/__tests__/cli-doctor.test.ts`
- **Fix Direction**:
  1. 各命令测试加：rollback 触发后 trustState 不被推进、audit append 失败导致 trustState 不被推进、conflict 拒绝、symlink rejection 后 audit 内容断言（partial_state、error）。
  2. `cli-tools.test.ts` 加 VALIDATION → DATAERR(65) 与其他 → SOFTWARE(70) 映射断言。
  3. `cli-detach.test.ts` 加 not-attached idempotent + conflict-on-hand-edited-alias 拒绝。
  4. `cli-install.test.ts` 加 audit `failed` 行内容断言（与 MR-B07 配套）；mtime/spy 证明 idempotent 不写盘。
  5. 新建 `cli-doctor.test.ts`：degraded(75)、storage 不可写、empty workspace 拒绝、provider 不配置 fail、null embeddingStatus 视为 pass。
  6. `runtime-notifier.test.ts` 加 isolation 测试（throwing listener 不阻 sibling）+ 异常传给上游与否的契约断言（与 MR-I01 一并）。
- **Verify**: 各文件 vitest 子集通过；总测试数有显著提升。
- **Reported by**: test-automator (F-test-001..006), pr-review (F-pr-005 部分)

#### MR-I16 · `tool-runtime-bootstrap.test.ts` 用 `toBeDefined()` 弱断言 / `final-review-status.test.ts` 是 docs↔docs 同义反复
- **What**: 多处 `toBeDefined()` 不能区分"返回正确接口"与"返回 `{}`"；`final-review-status.test.ts` 把 `readFileSync(report).toContain("Status: CLEAR")` 当 evidence。
- **Where**: `apps/core-daemon/src/__tests__/tool-runtime-bootstrap.test.ts:53,104,583`；`apps/core-daemon/src/__tests__/final-review-status.test.ts:21-73`
- **Fix Direction**:
  1. `toBeDefined()` 替换为 `toMatchObject({ start: expect.any(Function), stop: expect.any(Function) })` 类接口断言。
  2. `final-review-status.test.ts` 重命名为 `final-review-evidence-locks.test.ts` 并补一组真实行为断言（如"concurrent review prevents duplicate events"调一次 storage transaction 验证）。
- **Verify**: 重命名后文件存在，新增行为断言通过。
- **Reported by**: test-automator (F-test-007), pr-review (F-pr-005)

### Documentation

#### MR-I17 · README + CLAUDE.md 隐藏 5+ 真实 CLI 子命令（inspect/detach/mcp stdio/backup/export/import）
- **What**: 两个顶层 op 文档只列 6 条子命令，但 register.ts 实际注册 11 条；inspect / detach / mcp / backup / export / import 全部不可见，且仍写 "after Phase 4 lands"（Phase 4/5 都已 done）。
- **Where**:
  - `README.md:111-119`、`CLAUDE.md:31-33,144-151`
  - 真实：`apps/core-daemon/src/cli/register.ts:35-66`
- **Fix Direction**: 删除 "Phase 4 lands" 门控；CLI 块列出全部 11 条；CLI 块前置 `pnpm install && pnpm build` prerequisite（与 MR-B05/B06 配套）。
- **Verify**: `git grep "Phase 4 lands\|After Phase 4" README.md CLAUDE.md` 无命中。
- **Reported by**: documentation (F-doc-001, F-doc-003)

#### MR-I18 · invariants §21 已于 2026-04-29 narrowing 允许 Memory Inspector，但 README + CLAUDE 仍用绝对 "no GUI / no TUI" 措辞
- **What**: invariants §21 narrowed 后允许 memory-tooling 表面（Memory Inspector）；但顶层文档仍说"It is not a chat surface, not a GUI, and not a workspace"；与 `alaya inspect` 真实存在的 SPA loopback 矛盾。
- **Where**:
  - `README.md:14-18, 137-138`、`CLAUDE.md:23-29`
  - 真实：`docs/handbook/invariants.md:81-92`、`docs/handbook/architecture.md:77-101`
- **Fix Direction**: README + CLAUDE 用 "no agent-frontend GUI and no conversation TUI; the only Alaya-side UI is the loopback Memory Inspector for memory tooling" 措辞；与 MR-B-#BL-023 收口（详见 backlog 节）。
- **Verify**: `git grep "no GUI\|no agent-frontend GUI" README.md CLAUDE.md docs/handbook/invariants.md` 文案一致。
- **Reported by**: documentation (F-doc-002)

#### MR-I19 · `#BL-017` close-condition 数字错误（cited 例 `phase-c.ts >800` 实为 786 行；真正 >800 的文件未列）
- **What**: backlog #BL-017 (b) 列 `phase-c.ts (>800)`，实际 786 行；真正越线的是 `memory-entry-repo.ts(1210)` / `recall-service.ts(1157)` / `garden-data-ports.ts(1050)` / `serial-delegation-recovery.ts(827)` / `green-service.ts(790)`。
- **Where**: `docs/handbook/backlog.md:88-105`；行数证据：见 docs.md 草稿
- **Fix Direction**: 改写 #BL-017 (b)，列实际越线文件；phase-named 文件列入 (a) 重命名而非 (b) 拆分。
- **Verify**: `wc -l` 验证；`grep -n ">800" docs/handbook/backlog.md` 显示新 scope。
- **Reported by**: documentation (F-doc-005)

#### MR-I20 · `runtime-status.md` `mixed:` 标签不在 readiness vocabulary；CLI 行 readiness 自相矛盾
- **What**: readiness 词表 6 个：`not-started/schema-ready/implementation-ready/live-event-ready/mcp-consumable/cli-consumable`；`runtime-status.md:71` 用了 "mixed:" 自定义；同时 `code-map.md:79` 仍说 CLI 整体 `implementation-ready`，但 `runtime-status.md` 用 release E2E proof = `cli-consumable`。
- **Where**: `docs/handbook/runtime-status.md:7-15, 71`；`docs/handbook/code-map.md:79`
- **Fix Direction**: 拆成两行：`CLI commands (install/attach/status/doctor/tools list/tools call) → cli-consumable`；`CLI commands (inspect/detach/backup/export/import) → implementation-ready`；同步 code-map.md。
- **Verify**: `grep -n "mixed" docs/handbook/runtime-status.md` 无 cell-label 命中。
- **Reported by**: documentation (F-doc-007)

#### MR-I21 · README "Status" 段说 "v0.1 is in active port"，但 v0.1.0 已发布
- **What**: README:87-94 写 "v0.1 is in active port"；真实是 Gate-5/v0.1.0 passed 2026-05-02。
- **Where**: `README.md:87-94`；真实：`docs/handbook/runtime-status.md:26`
- **Fix Direction**: 改写为 "v0.1.0 released (Gate-5 passed 2026-05-02). v0.1.1 is post-release Phase 6 marketing benchmark wave (not a v0.1.0 blocker)."
- **Verify**: `git grep "active port\|Gate-5 passed" README.md` 显示 Gate-5 句。
- **Reported by**: documentation (F-doc-009)

---

## Nice-to-have findings (11)

| # | What | Where | Reported by |
|---|---|---|---|
| MR-N01 | `index.ts` 1511 行 god module（Phase 4-5 wiring 未拆） | `apps/core-daemon/src/index.ts` | architect (F-arch-005) |
| MR-N02 | `orphan-query.ts` 在 wiring 层写跨表 SQL，应归 storage | `apps/core-daemon/src/orphan-query.ts:1-103` | architect (F-arch-006) |
| MR-N03 | HTTP middleware 不分类 StorageError，把 NOT_FOUND 当 500 | `apps/core-daemon/src/middleware/error-handler.ts:14-67` | architect (F-arch-007) |
| MR-N04 | `gardenRuntime.backgroundManager.stop({ timeoutMs: null })` 等 forever | `apps/core-daemon/src/index.ts:1004` | red-team (F-red-007) |
| MR-N05 | `install --non-interactive <json>` 路径无 containment（db_path/key_file_path） | `apps/core-daemon/src/cli/install.ts:177-189, 246, 269` | red-team (F-red-008) |
| MR-N06 | 缺 schema_version 上限校验（降级回滚静默运行） | `packages/storage/src/db.ts:81-128` | sql (F-sql-005) |
| MR-N07 | `getNextRevision` 在 review 内重复扫表（O(N) 全读） | `packages/core/src/proposal-service.ts:471-480` | sql (F-sql-006) |
| MR-N08 | `pnpm-workspace.yaml` 含 `apps/inspector/web` 但未确认 `private:true` | `pnpm-workspace.yaml`、`apps/inspector/web/` | install-release (F-inst-008) |
| MR-N09 | 子包 type 字段 `JsonObjectSchema.properties` 用 `object` 过宽 | `apps/core-daemon/src/mcp-memory-tool-catalog.ts:14-19` | typescript-pro (F-types-005) |
| MR-N10 | `bridge.ts:82-83` 内部容器用 `<any>` | `apps/core-daemon/src/cli/bridge.ts:82-83` | typescript-pro (F-types-008) |
| MR-N11 | `code-map.md:39` 漏列 `backup/export/import/mcp` 命令 | `docs/handbook/code-map.md:39` | documentation (F-doc-004) |

Nice-to-have 在收敛标准下不阻塞 Round 2 通过；列入 fix-plan 的 "可选与 Important 一同顺手做" 列。

---

## Backlog Resolution（强制项 — 用户偏好"不允许 backlog 长期存在"）

### `#BL-024` HTTP proposal review needs a shared transaction boundary
- **状态**: Open（post-Gate-5）
- **决议**: **直接关闭，路径 = 删除 HTTP `POST /proposals/:id/review` 路由**（v0.1.0 release surface 是 MCP+CLI，HTTP 不在内）
- **执行**: 由 MR-B01 fix-task 完成；fix commit 后改 `docs/handbook/backlog.md` 中 `#BL-024` 状态为 `Resolved (route removed; v0.1.0 review surface = MCP only)`
- **风险**: Inspector 如未来需要 HTTP review，需走完整 atomic 化（见 sql.md 草稿附录的 A 方案）

### `#BL-017` Post-port hygiene sweep
- **状态**: Open（post-Gate-5）
- **决议**: **关闭并启动一次性清理 wave**：本轮不延期，直接在 fix-loop 中开始；按 docs.md 草稿附录 A 的 4 卡分解执行
  - P-postv01-rename-events（domain 命名替换 phase-*）
  - P-postv01-split-oversized（4 个 >800 行文件拆分）
  - P-postv01-port-residue（ts-prune 死代码）
  - P-postv01-codemap-refresh（code-map.md 同步）
  外加 stop-gap：立即创建 `docs/handbook/port-mapping/phase-to-domain.md` 命名映射文件（1h），不依赖完整 wave 即给 reviewer 稳定查询
- **执行**: stop-gap 文件由 fix-task DOC 立即落地；4 卡 wave 不在本 review 范围内执行（>10h 工作量），但**必须在 backlog 进 Resolved 前给出明确 schedule** 而非 indefinite 推后；schedule 写进 backlog
- **风险**: 4 卡 wave 落地需独立 review-loop；本 review 仅闭口 backlog 票据并启动其纲领

### `#BL-023` Marketing surface positioning risk
- **状态**: Open（产品风险观察）
- **决议**: **转化为 invariant §21a，从 backlog 删除**（不再是 backlog 票，而是 hard rule）
- **执行**: 由 fix-task DOC 完成：
  1. `docs/handbook/invariants.md` §21 后追加 §21a：" Public-facing copy must describe Alaya as a memory plane for CLI agents (Codex/Claude Code/similar) and must not invite non-engineering users to install/operate Alaya. Surfaces reaching non-engineering audiences (e.g., xiaohongshu) require either a separate consumer-facing product or a charter amendment to §21 before publication."
  2. README + Phase 6 leaderboard 文案加 audience 声明。
  3. backlog.md 删除 `#BL-023` 条目（用 invariant cite 代替）。
- **风险**: 用户如未来想把 xiaohongshu 当主流量，需先改 §21；§21a 阻止隐式越界

---

## Cause Class Aggregation（防复发）

5 个 cause class 在本轮各自出现 ≥2 次；按 MR-B10 决议要全部抽象为 invariant：

| Cause Class | 关联 finding | 提议的 invariant |
|---|---|---|
| **Default-no-scope/isolation** | MR-B02, MR-B03, MR-B-上一轮 3 条已修 Blocking | `invariants.md §"Default Scope Invariant"`（见 MR-B10） |
| **Symptom-fix at handler boundary** | MR-B02 (open_pointer 修在 MCP 而非 service)，上一轮 41d6dad 同问题 | `invariants.md §"Fix at Source"`：跨表面共享的 service 方法被发现安全/范围漏洞时，必须在 service 层修，handler 层修 = Blocking by default |
| **Async-await read-modify-write race** | MR-I07，MR-B11 cleanup 后 storage CAS 是唯一一道防线 | `invariants.md §"Single-Source Concurrency"`：所有 read-modify-write 必须 SQLite transaction 内完成；进程内锁不可作为并发正确性保证 |
| **Test asserts intent not production** | MR-B04 (proposal-service.test mock)，MR-B11 (governance test false-green)，MR-I16 (final-review-status docs↔docs) | `review-protocol.md §"Tests must run against production code paths or precise spies; mocks that diverge from production interface are Blocking"` |
| **Doc-drift gates by phase milestones** | MR-I17, MR-I20, MR-I21 | `review-protocol.md §"Phase milestone language must be removed at each gate close; running a 'Phase 6 lands' phrase past Gate-6 is Blocking"` |

---

## Round 2 调度建议

收敛尚远；建议 Round 2 按 fix-plan 完成全部 Blocking + Important 后：

- **Re-review 维度（增量 + 主要依赖）**：red-team / sql-pro / install-release / pr-review / typescript-pro / documentation 必跑（每条 Blocking 都跨这 6 个角度）；test-automator 跑（验证新增测试断言强度）；plan-challenger 跑（验证 cause-class invariant 是否被 Phase 5 的修复路径吸收）；codex 跑（external sanity）
- **跳过维度（依赖未变）**：architect（除非 routes 改动引发依赖方向偏移）
- **Round 2 必含 fresh end-to-end verification gate**（按 plan §End-to-end gate 跑全 8 条命令，stdout 摘录附录）
- **Round 5 上限保险栓**：若 Round 5 仍未收敛，停下来跟用户确认是否调整收敛标准

---

## End-to-end Verification Gate（Round 1 baseline，未跑）

本轮 review 是只读阶段；端到端实测在 fix-loop 完成后的 VERIFY 阶段执行。命令清单（plan §End-to-end）：

```bash
rtk pnpm install
rtk pnpm build
rtk pnpm test
rtk pnpm exec alaya doctor
rtk pnpm exec alaya install
rtk pnpm exec alaya attach codex
rtk pnpm exec alaya status
rtk pnpm exec alaya tools list
rtk pnpm exec alaya tools call soul.recall '{"query":"hello"}' --json
```

按 MR-B05 + MR-B06 当前状态预测：`pnpm exec alaya …` 系列必失败（Command not found），需先完成 fix-task `bin-registration` 才有意义。

---

## 报告外路径

- 派工台账（不进 git）：`.do-it/p5-system-review/round-1/fix-plan.md`
- 各 reviewer 草稿（不进 git）：`.do-it/p5-system-review/round-1/{architect,redteam,sql,install-release,pr-review,tests,plan-challenge,docs,types,codex}.md`

合并报告（本文件）是 git 中**唯一一份** Round 1 review 产出。
