# Structured round-source publication

The private benchmark round-source producer is
[`census.ts`](../../apps/bench-runner/src/runs/snapshot/source-records/census.ts) →
[`publish.ts`](../../apps/bench-runner/src/runs/snapshot/source-records/publish.ts).
It imports source records through the real Core admission owner and seals a fresh
SQLite snapshot. It does not copy host facts onto an old source receipt or index.

## Revision and authority

[`round-projection.ts`](../../apps/bench-runner/src/runs/snapshot/source-records/round-projection.ts)
owns the deterministic round revision. Captured structured rounds use
`bench-round-host-v1:<dataset-sha256>`; unknown-host rounds retain the legacy dataset
hash. The prefix versions the additional structured projection, not the original
bytes. The dataset pin already binds the structured source fields; no second
content hash, registry, caller-supplied revision or cryptographic grant is needed.

The existing opaque verified-dataset capability authorizes capture. The same
projection owner passes its version into the host-capture closure, which still
checks exact source ID/version, rendered bytes and occurrence coordinates at Core
admission. Custom metadata roots have no production capture capability and remain
unknown-host. Tests use the existing explicit authored dataset capability, never a
production custom-pin promotion exception.

Rendering, logical round IDs, root speaker, unknown attribution, observation and
validity times remain unchanged. A fresh publication has its own recorded time.
The new revision changes source-record identities and needs fresh index preparation.
The historical dataset-hash revision is the projection predecessor, not a claim
that an old database was replaced in place. A comparison must bind its actual old
inventory/configuration and new publication receipts; replacing an existing database
instead requires the Core predecessor-bound replacement owner.

Retained native snapshot readers remain immutable evidence readers. Their current
version/identity checks are not rewritten to reinterpret old facts. The per-message
source-records family and persona successor are different source IDs/contracts and
retain their existing version rules.

This is a benchmark-private source identity contract. No MCP, EventLog payload or
runtime-config schema changes under invariant25, and no Protocol version change.

## Bounded execution

Publication can receive `sourceLimits: { maxSources, maxContentBytes }`; the complete
native census is checked before daemon startup or source writes. These are explicit
caller allocation limits, not model allowances. `importEffects` uses the same strict
owner as message import: isolated configuration root, disabled SQLite write queue,
omitted embedding startup probe and disabled Garden compute. Embedding remains
disabled, and all source admission/checkpoint/shutdown effects stay with the native
publisher. The caller must separately supervise the process deadline and retain
failure/cleanup evidence; a timeout is not a successful seal or refundable attempt.

`round-source-publication.test.ts` exercises real publisher→Core admission→sealed
SQLite, independent UTF-8 message intervals, legacy-field preservation, unknown-host
custom pins and pre-start source/byte refusal under the strict source-import guard.
It does not invoke inference, provider traffic, natural questions or scoring.
