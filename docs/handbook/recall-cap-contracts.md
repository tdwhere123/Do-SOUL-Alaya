# Recall Cap Coordinates

Hard/Soft bottleneck algebra for [conditional-field recall](recall.md), governing
admitted derivations—never source truth or universal relevance scores.

## Values and Composition

- **Hard** is Boolean identity: admitted Hard derivations take grade `1000`;
  absence is `unreachable`, not Hard `0`. Any explicitly Hard-labelled value
  other than `1000` is invalid.
- **Soft** carries a declared cap-contract coordinate
  (`assoc.bottleneck.milligrade.v1`). Grades are comparable only within the same
  coordinate; reachable Soft `0` is a founded proof distinct from absence.
- **Omitted contract** forms an isolated legacy numeric coordinate rather than
  Hard identity; explicit Hard lifts into it just as into any Soft coordinate.
- Within a compatible coordinate, serial and conjunctive (`AND`) composition take
  `min`, and disjunction (`OR`) takes `max`. Hard acts as polymorphic identity
  for `AND`/serial steps and top (`1000`) for independent `OR` alternatives.
- Distinct Soft contracts do not convert implicitly; their conjunction
  establishes no common scalar, though independent alternatives remain retained
  (`incomparable` public scalar).

| Founded derivations | Numeric result |
|---|---|
| Hard followed by / `AND` Soft `gamma` | Soft `gamma` |
| Same-contract Soft `gamma` `AND` Soft `delta` | `min(gamma, delta)` |
| Same-contract Soft `gamma` `OR` Soft `delta` | `max(gamma, delta)` |
| Independent Hard `OR` Soft `gamma` | `1000` in `gamma`'s coordinate |
| Soft `gamma` and independent Soft `delta` (different contracts) | No common scalar (`incomparable`) |
| Independent Hard plus two incompatible Soft alternatives | Hard `1000`; both Soft histories retained |

## Producers, Bounds, and Recovery

- `stored_cosine_admission` supplies an optional measurement-qualified route,
  never a global lexical filter. An applicable lexical Hard seed remains
  independently eligible when measurement is absent or below threshold;
  measurement-dependent predicates still require actual measurement evidence.
- Numeric preparation and proof grounding share metered coordinate expansion
  (`cap-contract.ts`, `contract-coordinates.ts`): each lifted row preserves its
  source/transition evidence identity, product-key indexing for role membership,
  and coordinate-indexed alternatives. Withdrawal recomputes from remaining
  founded derivations.
- Possible and Guaranteed bounds (`low_milligrades`, `guaranteed_milligrades`)
  and accepting explanations are read in the selected coordinate; missing lower
  proof omits lower bounds (distinct from genuine guaranteed `0`), and
  `incomparable` values emit no numeric scalar/bounds. Associative ordering
  requires a declared shared cap contract; native-query order remains
  access-ordinal based.
- Expansion cursors survive work/memory interruptions over immutable retained
  states: refused staging neither consumes unspent work nor runs the solver,
  same-budget non-progress retries terminate explicitly, and larger-memory
  retries recover complete membership and proofs.

## Authority

- Semantic owner: `packages/core/src/recall/conditional-field/cap-contract.ts`;
  shared expansion: `engine/contract-coordinates.ts`.
- Verification covers finite algebra tables, provider-free SQLite compilation
  chains, and full-vs-incremental continuation equivalence (continuation checks
  do not replace an independent mathematical oracle).
