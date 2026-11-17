# Recall cap coordinates

This is the Hard/Soft algebra used by the [conditional-field recall contract](recall.md).
It governs admitted derivations, not source truth or universal relevance scores.

## Values and composition

- **Hard** is Boolean identity: an admitted Hard seed or transfer has grade 1000.
  Absence of a derivation is unreachable, not Hard 0. An explicitly Hard-labelled
  numeric value other than 1000 is invalid.
- **Soft** has a declared cap-contract coordinate. Grades are comparable only
  within that coordinate. A reachable Soft 0 is a proof, distinct from absence.
- An omitted contract remains an isolated legacy numeric coordinate. It does not
  assert Hard identity; explicit Hard can lift into it just as into a Soft coordinate.
- Serial and conjunctive composition use minimum within one compatible coordinate;
  disjunction uses maximum. Hard is the polymorphic identity for serial/AND
  composition and top for an independently founded alternative within a coordinate.
- Different Soft contracts do not convert implicitly. Their conjunction cannot
  establish a common numeric output. Independent alternatives remain retained,
  even when public scalar projection must report `incomparable`.

| Founded derivations | Numeric result |
| --- | --- |
| Hard followed by Soft gamma | Soft gamma |
| Soft gamma followed by Hard | Soft gamma |
| Same-contract Soft gamma AND Soft delta | Minimum of gamma and delta |
| Same-contract Soft gamma OR Soft delta | Maximum of gamma and delta |
| Independent Hard OR Soft gamma | 1000 in gamma's coordinate |
| Soft gamma and independent Soft delta, different contracts | No common scalar |
| Independent Hard plus two incompatible Soft alternatives | Hard 1000; both Soft histories retained |

The last row does not compare the Soft alternatives. Removing its independent
Hard proof reveals the remaining incomparability.

## Producers and proofs

`stored_cosine_admission` supplies an optional measurement-qualified admission
route. It is not a global lexical filter. An applicable lexical Hard seed can
independently establish eligibility when measurement is absent or below threshold.
A predicate requiring measurement still requires its actual measurement evidence.
A resulting 1000 is a derivation-policy grade, not a claim that cosine equals one.

Production relation matching currently emits admitted Hard transfers. Tests with
synthetic Soft transfers establish the finite-input algebra, not the existence of
an additional production relation producer.

Numeric preparation and proof grounding use the same metered Hard-row/coordinate
expansion. Each lifted equation keeps its original seed or transition evidence
identity. Separate contract/product seed rows and independent proof leaves survive;
lifting never manufactures a measurement observation. AND grouping and nested
premise assignments retain their coordinate instead of borrowing the first premise's
metadata. Withdrawal recomputes from remaining founded derivations.

## Bounds, delivery, and recovery

Possible and Guaranteed values are read in the selected coordinate. A lower proof
in another Soft coordinate is not a lower proof for a selected Hard output.
Missing or invalidated lower proof omits `low_milligrades` and delivered
`guaranteed_milligrades`; a genuine guaranteed zero retains both numeric zeros.
Incomparable public values have no scalar or numeric bounds.

Accepting explanations use the selected coordinate's roots. Associative ordering
requires a declared shared cap contract, permitting genuine Hard identity within
that contract but not undeclared or unrelated numeric scales. Native-query order
remains based on access ordinals rather than these grades.

Expansion cursors survive bounded work and memory interruptions. Old retained
states are immutable; subsequent additions and larger-budget retries resume from
funded work. Observation with no bytes left after finalization reservation reports
memory exhaustion instead of offering an indefinitely unchanged continuation.

## Implementation and verification

The semantic owner is `packages/core/src/recall/conditional-field/cap-contract.ts`;
`engine/contract-coordinates.ts` owns shared expansion, while graph preparation,
grounding, bounds and accepting projection adapt that authority.

Focused evidence is in `contract-coordinate-semantics.test.ts`, `band-progress.test.ts`,
`cross-contract-explanation.test.ts`, and `residual-incremental-integration.test.ts`.
The compiled-chain tests traverse real SQLite observation with explicit strict
provider-free guards. Finite algebra expectations are independently stated tables;
full-versus-incremental preparation comparisons are continuation equivalence checks,
not an independent mathematical oracle.
