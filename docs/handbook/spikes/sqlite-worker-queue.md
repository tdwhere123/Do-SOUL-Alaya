# Spike: SQLite worker-thread write queue (#BL-060)

**Status**: design spike only — no worker thread in tree yet.  
**Backlog**: `#BL-060` in `docs/handbook/backlog.md`.

## Problem

The daemon uses synchronous `better-sqlite3` on the main thread. S7 added a blocking probe, tail-latency test, bench driver (`scripts/bench-sqlite-concurrency.mjs`), and doctor storage-growth advisory. Heavy writes and maintenance still stall the event loop and inflate concurrent recall tail latency.

## Direction

Introduce a **single serial write queue** backed by a dedicated worker thread that owns the SQLite connection for mutations. Main thread enqueues opaque write jobs; reads stay on existing sync paths until a later phase.

Candidate layout:

```
main thread                          worker thread
-----------                          ---------------
repos / services  --enqueue(job)-->  FIFO queue
                                     better-sqlite3 (writes only)
StorageDatabase LRU cache            same filename lease
```

## Invariants (non-negotiable)

1. **EventLog-first ordering** — Within a governance transaction, EventLog append + revision CAS must commit before dependent ontology rows. The queue preserves enqueue order for `event_log_transaction` jobs and never interleaves a dependent `ontology_write` ahead of its EventLog chain.
2. **Transaction CAS** — Optimistic revision checks stay inside the worker-owned transaction; callers await `enqueue()` completion before treating durable truth as settled.
3. **No close on eviction** — `StorageDatabase` LRU eviction (`packages/storage/src/sqlite/db.ts`) must not call `close()` while the write queue holds pending or in-flight work for that filename. `SqliteWriteQueuePort.blocksEviction()` is the guard hook for cache policy.

## Stub in tree

| Artifact | Role |
|----------|------|
| `packages/storage/src/sqlite/write-queue-port.ts` | Typed port + in-memory serial stub (same-thread stand-in) |
| `packages/storage/src/__tests__/sqlite/write-queue-port.test.ts` | Contract: serialized enqueue, eviction guard |

The stub validates ordering and eviction semantics without `worker_threads` wiring.

## Out of scope (this spike)

- Worker bootstrap, message protocol, or moving `StorageDatabase` ownership
- Async driver evaluation (sql.js / sqlite-wasm) — deferred per S7 recommendation
- Changing repo call sites

## Close path for #BL-060

Ship worker-backed implementation (or reviewed async replacement) that keeps the three invariants above and beats the S7 tail-latency witness on concurrent recall workloads.
