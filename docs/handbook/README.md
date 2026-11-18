# Handbook

`docs/handbook/` owns cross-package invariants, epistemic and governance boundaries, and public contracts only. Exact wire schemas and versions live in `@do-soul/alaya-protocol`; formal field algebra and proofs live in the conditional-field design drafts and core engine modules.

| File | Owns |
|---|---|
| [`invariants.md`](invariants.md) | Rules that always win |
| [`architecture.md`](architecture.md) | Package boundaries, surfaces, three-tier relation model, write model, governance routes |
| [`runtime-transactions.md`](runtime-transactions.md) | Transaction owners, receipt/audit readiness, retry and crash recovery |
| [`recall.md`](recall.md) | Live Recall contract, Conditional Associative Field, delivery and recovery |
| [`recall-cap-contracts.md`](recall-cap-contracts.md) | Hard/Soft coordinate algebra, bounds and interruption semantics |
| [`glossary.md`](glossary.md) | Stable SOUL / Alaya vocabulary |

## When to edit

| Change | Update |
|---|---|
| Dependency, scope, concurrency, or governance invariant | `invariants.md` |
| Surface, package boundary, storage classification, or governance route | `architecture.md` |
| Commit, audit, notification, retry, or recovery ownership | `runtime-transactions.md` |
| Recall query, field transfer, delivery, or read-time qualification | `recall.md` or `recall-cap-contracts.md` |
| Stable domain term | `glossary.md` |

For semantic-memory work start with [fallible interpretation and task use](recall.md#fallible-interpretation-and-task-use). Track ordinary engineering debt in PR descriptions and benchmark policy in the [benchmark reproduction policy](../bench-history/README.md).
