# AGENTS.md

Canonical agent instructions for this repository. `CLAUDE.md` adds Plan Mode
only.

## File rules

- Repository markdown in this file is English-only.
- Read and write source as UTF-8 without BOM.
- Do not read files larger than 30 KB in full; use targeted reads or `rg`.

## Repository

Do-SOUL Alaya is a **local-first memory plane for CLI agents**
(`@do-soul/alaya-*`) — MCP and CLI only, no GUI, no conversation TUI.
Memory Inspector is loopback tooling, not an agent surface. Public copy uses
"memory plane" (invariant §21a).

- Memory objects are ontology; surfaces, scopes, paths, and projections route
  or filter them — they are not truth.
- Evidence and governance are explicit; control-plane outputs must not silently
  become durable memory.
- Signal ingestion is dual-track: explicit candidate emission and post-turn
  Garden heuristic extraction.

Required before code changes: [`docs/handbook/invariants.md`](docs/handbook/invariants.md).
Use the [handbook index](docs/handbook/README.md) to find the relevant domain
contract. Historical plans and worklogs are execution records, not current
architecture authority.

## Working scope

- Preserve the user's goal, settled decisions, and authorization. Review and
  discussion requests authorize inspection and reporting, not implementation.
- Start with the relevant live path and expand inspection or changes only as
  needed to resolve the cause and its affected consumers. Preserve unrelated
  working-tree changes. Do not turn a local fix into repository-wide cleanup.
- State material assumptions. Resolve questions from current code and contracts
  where possible; ask when an unresolved choice changes the intended behavior
  or authorization. Continue work already authorized without repeated approval.

## Code quality

- **One semantic authority:** each policy, schema, identity, canonicalization,
  digest material, state-transition rule, and side-effect contract must have one
  authoritative definition and a clear owner. Locate that owner before adding
  or changing a rule; trace the actual entry, producers, and affected consumers.
- **Reuse semantics:** consumers must call, derive from, or adapt the authority
  without redefining its rules. Different-looking code can duplicate a rule;
  similar-looking code can serve different contracts. Sharing a hash function
  does not unify independently defined digest inputs or canonicalization.
- **No bypasses:** callers must use the entry that owns the applicable
  authorization, validation, containment, transition, transaction, or audit.
  Lower-level primitives belong behind that owner. Fix shared defects there
  and check other reachable paths for bypasses, including alternate surfaces.
- **Explicit states:** preserve distinctions that affect authorization, retry,
  caching, recovery, or result meaning in types and boundary protocols. Failure,
  unknown, unbound, valid-empty, partial, and ready are not interchangeable.
  Define the meanings of `null`, `undefined`, and `[]`; adapters must preserve
  them. Do not cache parse or transport failures as successful absence.
- **Owned effects and recovery:** separate computation from effects while
  preserving the domain's transaction, persistence, audit, and notification
  order. Use the applicable write contract in `invariants.md` and
  `architecture.md`; EventPublisher and receipt-first audit paths have distinct
  ownership. For stateful changes, account for relevant partial commits,
  concurrency, retries, cancellation, and the owner of recovery.
- **Complete the replacement:** update affected consumers and remove superseded
  implementations, entry points, exports, and obsolete tests within scope.
  Required compatibility adapters must use the same authority and have a named
  consumer and removal condition; do not retain a competing implementation.

## Naming and comments

- Name production and test files, directories, symbols, fixtures, and test
  suites/cases for their domain responsibility, behavior, or failure condition.
  A name must be understandable without reading the plan that created it.
- Do not introduce plan titles, task/card/checkpoint IDs, wave labels,
  experiment IDs, ticket IDs, or review-finding numbers into names or comments.
  Keep task provenance in plans, worklogs, PR descriptions, or commit messages.
  For example, use `worker-close-reopen.test.ts` instead of
  `review-r3-fix-27.test.ts`. Actual protocol versions and externally required
  identifiers remain part of their contracts; renaming them requires the
  corresponding compatibility or migration work.
- Comments explain non-obvious reasons, invariants, ordering, or constraints.
  Regression test names describe the triggering condition and expected behavior.
  Apply naming fixes within the task's scope; avoid unrelated rename campaigns.

## Structure and size budgets

- **One reason to change** per module, class, and function.
- **Deep modules, not micro-files:** split only at a domain, phase, side-effect,
  or reuse boundary. Do not create one-use pass-through wrappers, single-call
  helpers, or tiny barrels merely to satisfy a line count.
- **Size budgets:**
  - Source files: target **under 500** lines. At **500+**, review cohesion and
    name the reason to keep or split it. At **800+**, split before adding behavior.
  - Functions: target **under 50** lines. At **80+**, review phase and branch
    cohesion. At **120+**, split before extending code that mixes decisions or
    effects. A cohesive declarative table or schema is not improved by arbitrary
    extraction.
  - The live `ci:repository-structure` check is authoritative: 500–799 lines
    require review, while handwritten source at 800+ lines fails. Generated,
    declarative, and test-support exceptions must remain explicitly classified.
- **Layout:** flat is fine when names and ownership remain predictable. At
  roughly **10–12** sibling modules, review the directory; create a subfolder
  only for a real domain or phase boundary, not to reduce a file count. Do not
  create new `utils`, `helpers`, `misc`, or `common` ownership directories.
- **Exports:** package-root barrels expose intended public consumers only.
  Avoid internal barrel chains that hide ownership or cycles. Temporary
  re-exports require a named consumer and removal gate.

## Verification and delivery

- For code changes, `pnpm build` and targeted Vitest must pass before claiming
  completion. Run relevant existing type, contract, and structure checks for
  affected boundaries. For documentation-only changes, inspect the diff and
  validate affected links and content; runtime build/tests are not required.
- When changing behavior across socket, SQLite, worker, stdio, filesystem, or
  shutdown boundaries, run at least one check through the actual affected
  boundary with an observable result. Cover the changed success/failure or
  recovery behavior; mock-only tests do not establish boundary correctness.
- Use expectations independent of the implementation being checked. Reuse
  existing tests and fixtures where suitable. Test count and coverage are not
  evidence that the requested behavior works. Report what was checked and
  any material gaps; rerun after relevant changes, not without a reason.
- Local verification is the default. Remote push, PR creation, and CI follow
  the user's authorized scope; finishing a worktree alone does not require
  remote CI. Once authorized, follow the current candidate's CI result and
  fix failures caused by the change. Distinguish local checks from remote CI
  and bind CI claims to the checked commit. Merge and release require their
  own authorization, which remains valid once given within its scope.

## Architecture

`@do-soul/alaya-protocol` → leaf types; `@do-soul/alaya-core` → truth
boundary; `apps/core-daemon` wires; Garden is fire-and-forget.
EventPublisher-owned transitions are EventLog-first; receipt-first audit paths
follow their own contract. Audit precedes notification. Detail:
[`docs/handbook/architecture.md`](docs/handbook/architecture.md).

Recall live runtime is the conditional-field route. Do not implement from
flood / SliceKey / four-strategies prose. Owner: `docs/handbook/recall.md`.

## Commands

CLI quickstart: `README.md`.

```bash
pnpm install
pnpm build
pnpm test
pnpm exec vitest run --project @do-soul/alaya-<package>

pnpm --dir apps/core-daemon dev
pnpm exec alaya doctor
pnpm exec alaya install
pnpm exec alaya attach codex
pnpm exec alaya status
pnpm exec alaya tools list
pnpm exec alaya tools call --json
```

`pnpm alaya` wraps the root script. Use `pnpm link --global` for PATH
outside the monorepo.

## Cursor Cloud

Cloud agents do code review and landing only; benchmark runs stay on local
hosts (see `docs/bench-history/README.md`).

- **Node 24:** `.cursor/environment.json` installs Node 24 via nvm before
  `pnpm install` and `pnpm build`. Do not lower repo `engines` to match a
  stale pod.
- **CodeGraph:** if `.codegraph/` is missing, skip CodeGraph and use normal
  search/read.

## Generated paths

Do not treat as source truth: `dist/`, `var/`, `data/`, `node_modules/`.

## Benchmark artifacts

Policy: `docs/bench-history/README.md`.

- Experiments → gitignored `.do-it/bench-runs/`; never commit.
- Full-dataset baselines → `docs/bench-history/` via `latest-*.json` only.

## CodeGraph

Local code-intelligence graph (MCP + CLI). Each **git worktree needs its own
index** — do not borrow the main checkout's `.codegraph/`.

- **On every new worktree:** from that worktree root run `codegraph init -i`
  before relying on `codegraph_explore` / `codegraph explore`.
- After init, the MCP server auto-syncs edits in that tree; if a response
  flags pending sync, `Read` the named files directly.
- If `.codegraph/` is missing, skip CodeGraph and use normal search/read.
