# Handbook

| File | Owns |
|---|---|
| [`invariants.md`](invariants.md) | Rules that always win |
| [`architecture.md`](architecture.md) | Package shape, surfaces, write model, governance routes |
| [`runtime-transactions.md`](runtime-transactions.md) | Transaction owners, receipt/audit readiness, retry and crash recovery |
| [`recall.md`](recall.md) | Live Recall query, native source observation, conditional proof, delivery and recovery |
| [`recall-cap-contracts.md`](recall-cap-contracts.md) | Hard/Soft coordinate algebra, proofs, bounds and interruption semantics |
| [`glossary.md`](glossary.md) | Stable SOUL / Alaya vocabulary |

## When to edit

| You changed | Edit |
|---|---|
| An invariant or dependency rule | `invariants.md` |
| A surface, package boundary, or governance route | `architecture.md` |
| Commit, audit, notification, retry or recovery ownership | `runtime-transactions.md`; update governing invariants and architecture when needed |
| Recall query, source discovery, field transfer, delivery or read-time qualification | `recall.md` |
| A stable term | `glossary.md` |

For semantic-memory work start with
[fallible interpretation and task use](recall.md#fallible-interpretation-and-task-use).
The source modules linked there own exact schemas, producer grammar and
algorithms. Archive readability is not execution support; study gates are
not universal runtime admission rules. Keep ordinary engineering debt in
PR descriptions and bench results in local history; see the
[benchmark reproduction policy](../bench-history/README.md).
