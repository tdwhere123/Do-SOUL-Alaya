# Recall Algorithm

This page is the in-repo authority for *how recall is supposed to work*
versus *what the runtime actually does* (invariant §32). It is not a
promotion gate and not a claim that the field has landed.

Package version on the cited freeze: `0.3.11` (`package.json`).
Recall-path citations are committed `10da1318` (the B-arm dump
commit). Later commits on this branch may exist; they are not this
page's source freeze. Runtime counts below are from that dump:

- 19431 candidates / 18344 answerable (6 abstention questions out)
- snapshot sqlite sha256 `7cac6e0d1ebdb89761546c26516a1a6722556f0e4f617145436ff38a51500a6a`
- B KPI sha256 `ed061c008db5603c5f53ef3d3d84c7d20a598774751aee6c5a0a75795827642a`

The dump is **not** `gate passed`. Gitignored local review notes and
execution plans are tracking artifacts, not handbook truth.

The intended mathematics is the Unified Governed Associative Field
(UGAF) read path, summarized below. Hopfield / Lyapunov / attractor
language is a **design lens**, not a proved runtime physics. Do not
quote it as an Alaya theorem.

## Target (UGAF)

Intended recall is one continuous governed associative-memory field,
not a stack of post-processors. Read path:

```text
q, S_t → Q_q → Ω(H_q, C_seal) → A(X_q) → G_L(~X_q) → M(Z_q) → Select_Γ → D_q
```

| Piece | Meaning | Must not |
| --- | --- | --- |
| \(S_t\) | Durable plane | Surfaces or ranks become truth |
| \(H_q\) | Typed candidate field, monotone expand | A rank list; a mid-pipeline top-\(B\) authority |
| \(C_q^{seal}\) | Per-channel depth, unseen bound, path-frontier flag | A digest that claims completeness with no bound |
| \(A_i(q)\) | Attributed multi-channel activation | A global energy scalar that erases channels |
| \(G_L\) | Bounded typed path transfer | A second ranker; unbounded flood |
| \(\operatorname{Select}_\Gamma\) | One monotone submodular walk; order **is** admission | A second ranker after the set exists |
| \(D_q\) | Unique pack, \(\lvert D_q\rvert \le B\) | Further reorder after the budget cut |

Before \(\operatorname{Select}_\Gamma\), operators may add information,
bind evidence, transfer activation, mark governance, or build views.
They may not silently drop members or reset order. The only destructive
compression is the final governed budget cut (UGAF I3, I4).

Do not add a fusion stream, promoter, or head-drop cap to "fix"
coverage. That is the failure mode UGAF §1.1 already named.

## Live system (degenerate projection)

Verified live read order after Wave 2 composition (order-only after the
coarse union until the token/`max_entries` cut):

```text
prepare: capture effective_as_of once, pin one projection generation
coarse union (lexical/FTS, trigram, graph/path/entity, global,
             synthesis, embedding inject)
  → observation table
  → family-max RRF inside a family, sum across families = fused_score
  → flood as bounded refinement on that base
  → deep-head probabilistic OR (lightweight_deep_head_prob_or_v1)
  → Select_Gamma (greedy ΔGamma / token; eligibility first)
  → token / dimension / entry constraints during admission
  → max_entries  (only destructive cut)
```

`family_grouped_composition_v2` has **no** remaining source hit under
`packages/` / `apps/` at committed `10da1318`.

| Target piece | Live stand-in | What the stand-in actually is |
| --- | --- | --- |
| \(\Omega\) monotone field | Coarse union | A packet. Graph/path/synthesis/facet streams contributed 0 ranks on the B dump. Embedding first-admitted 9/19431 candidates. |
| \(C_q^{seal}\) | `field_refinement_stop_certificate` | `activation_mode` is the literal `"shadow"` (`packages/core/src/recall/field/refinement/field-refinement-stop-certificate.ts:44,152`). Receipt, not a sealing condition on \(\Omega\). |
| Direct activation \(b_i\) | Family-max RRF `fused_score` | Live. `familyMaxContributionsById` (`packages/core/src/recall/delivery/fusion-delivery-families.ts:59-76`); default stream weights (`packages/core/src/recall/delivery/fusion-delivery-streams.ts:19-25`). On the B dump `flood_potential.final_score === R_obj` on 19431/19431. |
| Typed path transfer \(G_L\) | Flood + `path_expansion` / `graph_expansion` | Path never counts as fuel: `resolvePathAxis` without inflow returns `inactive:pass_through`, `countsAsFuel: false` (`packages/core/src/recall/scoring/integrated-flood-scoring.ts:67-76,105-111`). B dump: `path_status = inactive:pass_through` and `fuel_verified = false` on 19431/19431. |
| Slice / fiber restrict \(\Pi_q\) | `resolveSliceAxis()` | Constant stub `{ value: 1, status: "inactive:pass_through", countsAsFuel: true }` (`packages/core/src/recall/scoring/integrated-flood-scoring.ts:63-65`). Gate open, feature absent. |
| Evidence flood axis | `resolveEvidenceAxis` | **Not** uniformly dead. B dump: `evidence_status` `active` 16277 / `inactive:pass_through` 3154. Fuel still fails because path withholds. |
| Evidence multiplier | `ALAYA_RECALL_CONF_EVIDENCE_BETA` | Defaults to **0** (`packages/core/src/recall/scoring/conformant-fusion-scoring.ts:62-64`). B dump: `e_direct_status = inactive:beta_disabled` 19431/19431. Do not retune beta against a dead transfer. |
| Open-semantic channel | Query-factor cache + compatibility | Query side formed 100/100 on the B dump. Candidate side 0 `compatible`. Composition/activation `unavailable` 100/100. |
| Embedding as a seed of \(\Omega\) | `semantic_supplement` + deep-head / fusion overlay | Live as a scorer (`provider_returned` 100/100 on that dump). Almost unused as a discoverer (9/19431 first-admits). Invariant §18 still holds: embedding never decides durable truth. |
| Write-side Keys / facets | Daemon materialization + `memory_object_keys` | Complementary Keys (gist remainder, OSF surfaces, temporal/numeric aliases) mint at memory write and join keyword discovery. Closed-vocab facet-tag write, `facet_overlap`, and query-side `FACET_VOCABULARY` slice keys / demand atoms are deleted (no memory-side partner). Protocol `facet_tags` / `FACET_VOCABULARY` remain schema-only. Read-side `ALAYA_RECALL_PROJECTIONS` remains scoring floors, default ON. |
| \(\operatorname{Select}_\Gamma\) | `createSelectGammaPort` greedy \(\Delta\Gamma / \mathrm{token}\) | Admission order is the delivery order. Consensus remains a packet-plan observation and does not reorder. Live requests bind a real pinned `generation_id` and `condition_digest`. |
| One destructive cut | `max_entries` | Holds. Do not add another. |
| Deep-head composition | `lightweight_deep_head_prob_or_v1` | Live operator id (`packages/core/src/recall/rerank/deep-head-assessment-builder.ts:18`). Score is `probOr(resolvedEvidence, embedding?, fusionBaseline?)` (`:147-156`). |

Net: activation transfer is not connected. The live selector is one
Select_Gamma walk on a family-max RRF candidate field. Query entry
captures one `effective_as_of` and pins one generation; usage is
causal-receipt only and is constructed at the daemon composition
root. Optional formation failure does not delete the root evidence
capsule.

## Env names that will mislead you

These are parsed. They are not product knobs for landing the field.

| Name | Live fact | Cite |
| --- | --- | --- |
| `ALAYA_RECALL_PROJECTIONS` | **Read-side scoring only**, default **ON** unless `0\|false\|off\|no\|disabled` (`packages/core/src/config/recall-runtime-config.ts:16-18,53`). Intent/preference weight floors, not write-side Key supply. |
| `ALAYA_RECALL_CONF_EVIDENCE_BETA` | Default 0; multiplier is identically 1 until path fuel exists. | `conformant-fusion-scoring.ts:62-64` |
| `ALAYA_RECALL_ANSWERS_WITH` | `recallAnswersWithEnabled()` is hardcoded `true` with no closable off-switch (`packages/core/src/config/recall-env-access.ts:66-69`). Exported from `packages/core/src/config/index.ts:28`. No other production consumer at committed `10da1318`. Bench provenance still stamps the name. |
| `ALAYA_RECALL_FINAL_AUTHORITY_MAX_HEAD_DROP` | Parsed into `finalAuthorityMaxHeadDrop` (`recall-runtime-config.ts:13,55-57`) and re-emitted by `recallEnvRaw` (`recall-env-access.ts:47-48`). No production consumer under `packages/core` or `apps/core-daemon` beyond config parse/tests. Still appears in bench provenance. |

Connecting \(G_L\), write-side Keys, open-semantic candidate comparison,
and embedding-as-\(\Omega\)-seed is the work. Do not retune weights,
caps, or cutoffs against the current bench matrix (anti-fitting).

## What to read instead of this page

| Need | File |
| --- | --- |
| Numbered invariants (truth boundary, axes, EventLog) | [`invariants.md`](invariants.md) |
| Packages, surfaces, write model, governance routes | [`architecture.md`](architecture.md) |
| Open engineering issues that are **not** the recall field | [`backlog.md`](backlog.md) |
| Dated full-dataset KPI archives | [`../bench-history/README.md`](../bench-history/README.md) |
