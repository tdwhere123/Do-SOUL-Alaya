# Handbook

| File | Owns |
|---|---|
| [`invariants.md`](invariants.md) | Rules that always win |
| [`architecture.md`](architecture.md) | Package shape, surfaces, write model, governance routes |
| [`recall.md`](recall.md) | Recall algorithm, fallible interpretation/use boundaries, live path and readiness |
| [`glossary.md`](glossary.md) | Stable SOUL / Alaya vocabulary |

## When to edit

| You changed | Edit |
|---|---|
| An invariant or dependency rule | `invariants.md` |
| A surface, package boundary, or governance route | `architecture.md` |
| Recall conditional-field entry, historical ranking/fusion receipts, embedding, path transfer, or readiness labels | `recall.md` |
| A stable term | `glossary.md` |

Prefer concise files. `architecture.md`, `recall.md`, and
`invariants.md` currently exceed 15 KB because they are the long-form
contracts. Code locations for recall are cited in `recall.md`;
otherwise use `rg` or CodeGraph.

For semantic-memory work, start with
[fallible interpretation and task use](recall.md#fallible-interpretation-and-task-use).
Keep implemented contracts separate from proposed task-loop capabilities.
Historical study gates do not add universal runtime admission requirements.

Ordinary engineering debt belongs in PR descriptions, not a handbook
issue list. Bench KPI degradations belong in
[`docs/bench-history/degradation-backlog.md`](../bench-history/degradation-backlog.md).
