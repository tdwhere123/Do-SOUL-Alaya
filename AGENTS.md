# AGENTS.md

Canonical repository instructions. `CLAUDE.md` adds Claude-specific Plan Mode rules.

## File rules

- This file is English-only.
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

## Research

- For uncertain algorithm directions, prefer cheap offline counterfactuals on
  existing frozen evidence before production changes or paid generation. Ask
  which missing information could change the decision; separate source
  availability, instance/binding information, the selection objective and actual
  delivery. A useful observation column is not automatically a useful selector.
- Freeze the inputs, intervention, controls and acceptance before measuring.
  Keep gold out of selectors; confine manual oracle inputs to explicitly
  labelled diagnostic arms, never production features. An oracle bound,
  correlation or root-level replay shortlists a direction; it does not prove
  that the information is producible or that native delivery improves.
- Follow surviving evidence to its causal owner, then verify the affected
  runtime boundary. Do not keep adding ranking rules or protection conditions
  after failed substitutions. This is a research preference, not an extra gate
  for ordinary small fixes.

## Code quality

- **One semantic authority:** locate the owner of each policy, schema, identity,
  canonicalization, digest input, transition and side-effect contract. Trace its
  entry, producers and consumers; consumers reuse or adapt that authority, not
  redefine its rules. Sharing a hash function alone does not unify digest inputs.
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

- Name files, symbols, fixtures and tests for domain responsibility or behavior,
  not plan/card/wave/ticket IDs. Keep task provenance in plans, worklogs or commit
  messages. Protocol versions and externally required identifiers retain their
  compatibility obligations.
- Comments explain non-obvious reasons, invariants and ordering. Regression test
  names describe the trigger and expected behavior. Avoid unrelated renaming.

## Structure and size budgets

- **One reason to change** per module, class, and function.
- **Deep modules, not micro-files:** split only at a domain, phase, side-effect,
  or reuse boundary. Do not create one-use pass-through wrappers, single-call
  helpers, or tiny barrels merely to satisfy a line count.
- **Size budgets:** source files target <500 lines; at 500+ explain cohesion, and
  at 800+ split before adding behavior. Functions target <50 lines; review at 80+,
  and split mixed decisions/effects before extending at 120+. Do not split
  cohesive declarative tables merely for size. `pnpm ci:repository-structure`
  and its [policy](scripts/ci/repository-structure-policy.json) own enforcement
  and explicitly classified exceptions.
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

Package boundaries, Garden lifecycle and write ordering belong to the
[architecture handbook](docs/handbook/architecture.md). EventPublisher transitions
are EventLog-first; receipt-first paths have a different owner. Audit precedes
notification.

The live [recall contract](docs/handbook/recall.md) is the conditional-field route,
not historical flood, SliceKey or four-strategies prose.

## Commands and environment

Use [README.md](README.md#quickstart) for installation/CLI commands and
[package.json](package.json) for scripts, engines and package-manager versions;
do not lower engine requirements to fit a stale environment.
Targeted tests: `pnpm exec vitest run --project @do-soul/alaya-<package>`.
Benchmark runs stay on local hosts; cloud agents are for review and landing.

## Generated paths

Do not treat as source truth: `dist/`, `var/`, `data/`, `node_modules/`.

## Benchmark artifacts

Follow the [storage policy](docs/bench-history/README.md). Never commit generated
results or model caches; preserve complete archives, findings and latest pointers.

- Experiments: `.do-it/bench-runs/`, in existing collections only; follow its
  local `README.md` for retention and protected inputs.
- Generated history/baselines: `.bench-artifacts/history/`; extraction caches:
  `.bench-artifacts/cache/`.
- `docs/bench-history/`: maintained reproduction docs, dataset pins and sampling
  manifests only.

## CodeGraph

Each worktree needs its own index: run `codegraph init -i` there before relying
on CodeGraph; never borrow another tree's `.codegraph/`. If no index exists, use
normal search/read. If a response flags stale or pending sync, read the files
directly.
