# Archived: Recall Routing Projections (pre-UGAF handbook)

**Not current truth. Do not implement from this file.**

This is the `docs/handbook/architecture.md` §Recall Routing Projections
text as it stood before the 2026-08-14 docs-governance pass. It mixed
a still-valid ontology constraint (`PathRelation` is a derived
projection, never durable truth — invariant §12) with prose that a
reader could take as "flood transfer and SliceKey query-time matching
are connected."

They are not connected on HEAD `10da1318`. Live vs target:

[`docs/handbook/recall.md`](../../handbook/recall.md)

What remains binding is invariant §12 / §12a–c, not the wording below.

---

## Recall Routing Projections (verbatim, superseded)

`PathRelation` is the derived, governed current/as-of conditional-routing
projection. It is rebuilt from accepted `RelationAssertion` records and
their appended EventLog resolutions; it is not a durable relation claim
or historical record. Flood transfer is a query-time decision to carry
potential along one directed edge under the current routing conditions.
The object's `fused_score` is the aggregate projection produced after
those edge decisions; it is not the flood or a new durable fact.

SliceKey is a workspace-scoped, versioned, rebuildable routing view over
existing projections. Its seed taxonomy is extensible and keeps typed
provenance: event time stays a time interval or bucket, canonical entities
and object anchors stay typed identities, spatial values stay spatial, and
`facet_tags` contribute semantic facets rather than acting as a universal
container. Query-time compatibility is the intersection of query, source,
and target keys. A query with no valid key follows the neutral existing path;
a keyed query with no three-way match may reject only the experimental edge
decision, never rewrite the underlying evidence or `RelationAssertion`.

Single-edge transfer is the required baseline. Any bounded two-edge traversal
must be earned by miss evidence, remain deterministic and budgeted, and pass
the same governance and release gates; it is not implied by the existence of
projected paths.
