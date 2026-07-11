# Benchmark PID-Namespace Overlap — 2026-07-10

## Issue

An E2 500Q run survived a turn abort inside its original sandbox while the next
turn incorrectly concluded that no benchmark process remained. S1-S3 source
workers and a later E3 100Q trace run then overlapped that hidden process.

## Evidence Timeline

All times are Asia/Shanghai on 2026-07-10.

| Time | Event |
| --- | --- |
| 07:26 | E2 sequential 500Q started at clean `05d98dfd`, using unique shard/history roots. |
| 07:36 | The polling turn was aborted; the benchmark process group survived. |
| 07:37 | User moved the claim-bearing 500Q after implementation/review and requested long polling windows. |
| 07:37-07:43 | A new turn ran in another `bwrap --unshare-pid` namespace; its process check could not see the old group and falsely recorded the run as stopped near 22/500. |
| 07:43 | `/root/s1_edge_trace` started the planned S1 source slice. |
| 07:59 | `/root/s2_slice_contract` started the S2 contract slice. |
| 08:10 / 08:19 | `/root/s3_slice_selector` and its resume worker completed S3. |
| 08:26-09:26 | Parent launched E3 sequential 100Q. It completed with R@5 0.86 and p95 1247.765 ms while the hidden 500Q still consumed the host. |
| Investigation | Host-visible inspection found the old 500Q at 188/500 and source mtimes beginning after its start. The old benchmark group was terminated without changing source. |
| Freeze | The detached E3 analysis host was identified by its rollout write handle and terminated; no LongMemEval process remains. |

## Root Cause

The first bad state was treating an empty `pgrep` result from a new sandbox PID
namespace as proof that a process created in the previous sandbox had exited.
The missing guard was cross-turn filesystem ownership: neither the benchmark
gate nor source-worker preflight had a truth-plane lease that survives PID
namespace changes.

## Evidence Classification

- `recall-forward-e2-smoke-20260710`: valid; it completed before source writes and alone.
- `recall-forward-e2-baseline-500q-20260710`: invalid/incomplete; observed at 188/500 after source writes began. Never use it for quality or latency claims.
- `recall-forward-e3-trace-100q-20260710`: structurally complete but resource-contaminated. Its latency is invalid. Diagnostics may inform hypotheses only and cannot close E3/S5 or a release gate without a clean serial rerun.
- Existing S1-S3 source changes have known provenance in this parent thread; they are not unexplained user edits.

## Prevention Hook

Before the next long run, add a filesystem lease under the target artifact root
that records checkout, HEAD, command, start time, and state. Benchmark launch
must fail if a live or unresolved lease exists; every source worker must fail if
the lease says `running`. PID checks remain supporting diagnostics only. The
claim-bearing S5/E4 runs remain serial and start only after implementation and
review/fix-loop complete.

Implemented in the main-checkout scratch gate script before the next run. Script
The reviewed gate is split into a main script and lifecycle helper. Its ordered
content-hash bundle SHA is
`b31d243f78f184b1dfbf153a0626279f99482c2675f0df8c77a629378543aed7`.
Signal regression proof covers a child shell plus long-lived grandchild:
reentry fails while cleanup owns the lease, both descendants terminate, and
the lease is released last.
`bash -n` passed; a pre-existing lease failed before cache/build work; a lease
acquired before a forced preflight failure was released by the EXIT trap; and a
question manifest with parallel/sharded settings failed before acquisition.

## Current State

- No LongMemEval or cache-only gate process remains.
- The detached E3 analysis process group is stopped.
- Source changes are preserved exactly as produced; no restore, stash, or overwrite occurred.
