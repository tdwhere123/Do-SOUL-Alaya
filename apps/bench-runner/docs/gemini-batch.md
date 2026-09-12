# Gemini extraction

Gemini Batch is a transport for the existing `extraction-fill` pipeline.
It uses the shared source request, parser, raw cache and extraction authority.
The `lazy_field` sealed offline replay route remains separate. Batch outputs
are proposals; cache coverage does not establish formation quality, projection
readiness or benchmark accuracy.

## Cost planning

The initial candidate is Gemini 2.5 Flash-Lite with thinking disabled. Official
prices checked on 2026-09-12 were USD 0.05 per million input tokens and USD 0.20
per million output tokens for Batch, half the corresponding interactive rates.
These are planning observations, not a frozen execution price or quality claim.

Before bulk work, select named interactive probes and a small stratified Batch
canary from source-only characteristics such as assertion count, request size,
language and repeated turns. Check source grounding, completion, actual usage
and downstream projection/delivery. Repair only explicit failed units. Preserve
the request-to-occurrence mapping when deduplicating repeated source content;
request cache keys do not replace semantic-unit identities. Compare observed
cost per admitted unit, including failed attempts, before choosing larger
windows. Keep query preparation in a separate budget.

## Preparation

Use a fresh isolated cache root under `.do-it/bench-runs/`, with an explicitly
selected raw dataset window and pinned metadata. Preserve historical roots.
Set `OFFICIAL_API_GARDEN_PROVIDER_URL` to
`https://generativelanguage.googleapis.com`, `OFFICIAL_API_GARDEN_MODEL` to
`gemini-2.5-flash-lite` or `gemini-2.5-flash`, and
`ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE` to `gemini-2.5-nonthinking-v1`.
`ALAYA_OFFICIAL_GARDEN_SECRET_REF` names the existing secret resolver reference;
never put secret bytes in a receipt, command argument or run log.

Use the existing `authorize-extraction` command to bind source scope, prices,
input-token upper bound and output cap to the root. Its native output field is
`--extraction-output-token-field maxOutputTokens`. Ordinary target-selection
and source-window rules still apply. Obtain exact options from:

```bash
node apps/bench-runner/bin/alaya-bench-runner.mjs --help
```

The Batch limits JSON must contain all of these fields:

| Field | Meaning |
| --- | --- |
| `maxJobs` | Maximum cumulative submitted jobs in the root |
| `maxRequestsPerJob` | Request lines per job |
| `maxFileBytes` | Input JSONL ceiling, at most 64 MiB locally |
| `maxInputTokensPerJob` | Conservative input-token upper bound per job |
| `maxEnqueuedTokens` | Root-wide tokens reserved by in-flight jobs |
| `maxOutputTokens` | Exact authority output cap, including thinking |
| `maxUsd` | Root-wide observed spend plus unresolved reservations |
| `inputUsdPerMillion` | Current Batch input price, matching authority |
| `outputUsdPerMillion` | Current Batch output price, matching authority |
| `deadlineMs` | Maximum observation lifetime after submission |
| `requestTimeoutMs` | Per-HTTP-call deadline |
| `maxPolls` | Durable poll limit per job |

The file does not grant additional spending. Freeze its values with the source
inventory and execution windows. Input bounds use UTF-8 wire bytes plus framing,
not a chars/4 estimate. Missing usage and uncertain remote acceptance retain
their conservative reservation.

## Operations

Append the following options to the same ordinary `extraction-fill` source,
cache-root and authority arguments on every invocation:

```text
--batch-operation prepare --batch-limits <limits.json>
--batch-operation submit  --batch-limits <limits.json>
--batch-operation status  --batch-limits <limits.json>
--batch-operation resume  --batch-limits <limits.json>
--batch-operation import  --batch-limits <limits.json>
--batch-operation cancel  --batch-limits <limits.json>
```

`prepare` seals only missing work without HTTP. `submit` uploads and creates
eligible prepared jobs. `status` performs bounded status observations. `resume`
observes known jobs and imports available output; it never dispatches new jobs.
`import` reuses retained output when available, downloading only output not yet
retained. `cancel` requests cancellation; acceptance is not evidence of zero
cost or terminal cancellation.

Creation is non-idempotent. If a response is lost, retain the unknown job and
reconcile an independently identified remote job using both
`--batch-local-job <id>` and `--batch-remote-job <batches/id>`. Remote metadata
must bind the model, input file and display name. Missing evidence stays
unknown; never delete state and blindly resubmit.

Use an explicit new `--batch-window <name>` to prepare the selected missing
inventory after its previous jobs have settled. For repairs, restrict the
authority and source selection to failed units; the window name alone does not
select failed work. The old plans, provider raw
responses and costs remain in the same root. Windows cannot reset cumulative
spend or overlap unresolved work. Changing model/profile/prices/output cap
requires a separately governed generation.

Interactive Gemini work uses the same GenerateContent codec, explicit native
cap and a one-attempt `retryMode: disabled` policy. Use it only for named probes
or repairs in the execution manifest. There is no automatic interactive bulk
fallback. Query preparation has its own manifest and budget.

## Verification and interpretation

Successful job status alone cannot complete the cache. Every selected result
must have an exact request/source binding and successful completion witness;
foreign, duplicate, missing, malformed, truncated and assertion-bearing empty
responses remain failed, pending or quarantined. Local imports do not count as
new provider requests. Original occurrence bindings survive request deduplication.

Provider-free regression coverage includes actual CLI import and cache replay,
loopback upload/create/poll/download/cancel, unknown creation, interrupted
import, per-root retry budgets, source occurrence conservation and native
interactive failure accounting. Real model quality and account quota still
require a bounded, source-sampled canary before bulk preparation.

Protocol references: [Batch guide](https://ai.google.dev/gemini-api/docs/batch-api),
[REST reference](https://ai.google.dev/api/batch-api),
[GenerateContent thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking),
[pricing](https://ai.google.dev/gemini-api/docs/pricing) and
[quotas](https://ai.google.dev/gemini-api/docs/rate-limits).
Rates and limits must be retrieved again for each paid execution contract.
