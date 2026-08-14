# Handbook

| File | Owns |
|---|---|
| [`invariants.md`](invariants.md) | Rules that always win |
| [`architecture.md`](architecture.md) | Package shape, surfaces, write model, governance routes |
| [`recall.md`](recall.md) | Recall algorithm: UGAF target vs live degenerate projection |
| [`runtime-snapshot.md`](runtime-snapshot.md) | Current release posture and readiness claims |
| [`backlog.md`](backlog.md) | Open `#BL-NNN` issues that are **not** the recall field |
| [`glossary.md`](glossary.md) | Stable SOUL / Alaya vocabulary |

## When to edit

| You changed | Edit |
|---|---|
| An invariant or dependency rule | `invariants.md` |
| A surface, package boundary, or governance route | `architecture.md` |
| Recall ranking, fusion, flood, embedding, or path transfer | `recall.md` |
| A release gate, version, or readiness witness | `runtime-snapshot.md` |
| An issue opened, deferred, or closed | `backlog.md` |
| A stable term | `glossary.md` |

Keep each file under ~15 KB. Code locations for recall are cited in
`recall.md`; otherwise use `rg` or CodeGraph.
