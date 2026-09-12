# Gemini extraction

Gemini Batch is a transport for the existing `extraction-fill` pipeline.
It uses the shared source request, parser, raw cache and extraction authority.
The `lazy_field` sealed offline replay route remains separate. Batch outputs
are proposals; cache coverage does not establish formation quality, projection
readiness or benchmark accuracy.

## Cost planning

Official text prices checked on 2026-09-12, in USD per million tokens:

| Model | Explicit profile | Batch input / output | Interactive input / output |
| --- | --- | --- | --- |
| Gemini 2.5 Flash-Lite | `gemini-2.5-nonthinking-v1` | 0.05 / 0.20 | 0.10 / 0.40 |
| Gemini 3.1 Flash-Lite | `gemini-3.1-minimal-v1` | 0.125 / 0.75 | 0.25 / 1.50 |

The 2.5 profile sends `thinkingBudget: 0`; the 3.1 profile sends
`thinkingLevel: "minimal"`, which does not guarantee that thinking is disabled.
The optional `gemini-3.1-low-v1` profile selects `thinkingLevel: "low"` on the
same model; minimal remains the default. These profiles have distinct cache
identities and require matching extraction authority. Switching profiles does
not relabel existing raw results. The [Gemini 3 guide](https://ai.google.dev/gemini-api/docs/gemini-3)
lists both levels; neither is a fixed thinking-token allowance.
Output charges and `maxOutputTokens` include thinking tokens. Both supported
Flash-Lite models allow at most 65,536 output tokens. Prices are planning
observations, not a frozen execution price or quality claim. See official
[pricing](https://ai.google.dev/gemini-api/docs/pricing),
[thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking), and
[3.1 model limits](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite).

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
`https://generativelanguage.googleapis.com`; native `/v1beta` and configured
`/v1beta/openai` suffixes also normalize to the same native API origin for both
interactive and Batch requests, retaining key authentication.
Set `OFFICIAL_API_GARDEN_MODEL` and `ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE`
to the exact model/profile pair in the table. Gemini 2.5 Flash also uses the
2.5 nonthinking profile. Model/profile changes create distinct request identities.
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

Bound each window with `--batch-request-limit N`. A new window takes the first
N missing request keys in deterministic key order within the existing authority
scope. For example, use 32 for an initial canary and explicitly named windows
of 512 for subsequent missing work. This avoids constructing one oversized
local plan and preserves the full dataset inventory. Keep the same window name
and request limit on prepare/submit/resume/import; replay uses its original
sealed selection, even after some shards are admitted. Completing a bounded
window does not complete the full cache while selected source requests remain
missing. A later window cannot overlap prior work until local accounting and
import outcomes have closed.

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

### Rolling a bounded scope as an ordinary process

`extraction-fill --batch-campaign /absolute/campaign.json` schedules named
windows through the existing fill entry. Its manifest references the frozen
Batch limits and extraction authority; it does not authorize additional spend:

```json
{
  "version": 1,
  "name": "bulk",
  "limitsPath": "/absolute/batch-limits.json",
  "requestLimit": 400,
  "pollIntervalMs": 600000,
  "fill": {
    "variant": "longmemeval_s",
    "offset": 0,
    "limit": 100,
    "cacheRoot": "/absolute/cache",
    "dataDir": "/absolute/data",
    "authorityReceiptPath": "/absolute/bulk-authority.json",
    "targetSelectionReceiptPath": "/absolute/bulk-target.json",
    "predecessorAuthorityReceiptPath": "/absolute/canary-authority.json"
  }
}
```

All paths must be absolute. The last predecessor reference is required only
for an existing same-root continuation. The limits must allow at most 400
requests per job and 8 million input/enqueued tokens. Each window must prepare
at most one job. `maxJobs` remains the existing cumulative root job ceiling,
so it must cover the authorized campaign, including previous accepted jobs.

For a supervised or shell-background process, invoke Node explicitly with
`--use-env-proxy` before the existing `bin/alaya-bench-runner.mjs` path. This
avoids the CLI proxy bootstrap spawning another process, so the recorded PID
belongs to the controller. Redirect stdout/stderr to the operator's run log.
The controller emits its next check time and persists scheduling state under
`cacheRoot/.batch-campaign/state.json`. Restarting the same command resumes the
same window and never blindly repeats an ambiguous job creation. A completed
restart revalidates shared cache coverage without new extraction.

Unknown submissions, missing usage, failed/quarantined results, exhausted
owner limits and fill errors stop the campaign. Restart does not clear a stop
or open a retry window; inspect the existing job/authority artifacts and use
the ordinary operator recovery route. Manifest/authority/limits changes are
rejected. Neither scheduler state nor a successful remote job substitutes for
the shared full-scope completion check.
Completion here means the extraction cache is complete. The controller does
not certify downstream semantic graphs, field formation or Recall readiness;
the operator must settle those quality gates before authorizing campaign start.

After a code revision changes, an existing ordinary 100Q authority cannot
simply be reused. Use the existing explicit `select-extraction-target`
same-root continuation with the previous target and authority, then
`authorize-extraction` with the new target and previous authority. Its owner
requires settled predecessor accounting, preserves compatible cached shards
and forks the existing ledger; the controller does not copy or rewrite either.

Successful job status alone cannot complete the cache. Every selected result
must have an exact request/source binding and successful completion witness;
foreign, duplicate, missing, malformed and truncated responses remain failed,
pending or quarantined. A complete, valid `signals: []` response records that
extraction produced no candidates; a grounded subset may omit transient source
instructions. Neither outcome proves exhaustive memory or field formation.
Valid empty responses preserve provider completion and usage and do not trigger
an automatic paid recheck. Local imports do not count as
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

Native source extraction uses a response JSON schema derived from the shared
graph and source-locator shapes. Query and protocol probe envelopes do not
inherit that schema. It constrains generation syntax and supported structural
keywords, not source truth or semantic completeness; normal parsing, grounding
and formation checks still apply. Optional projections remain independent.
Freeze input limits from the complete encoded wire, including the schema;
an earlier prompt-only byte bound may no longer cover a request.

## Cache reuse while algorithms change

Keep provider output and validated extraction shards separate from generated
SQLite snapshots, field projections and evaluation artifacts. Raw shard keys
bind model, request profile, system prompt and serialized source request.
Parser and grounding compatibility must be validated against the exact code
candidate before replay; the cache manifest does not pin their versions.
Increasing the selected question window does not itself change a shared
source request's key, but the larger inventory needs its own valid authority.

Changes limited to Recall evaluation or projection rules can rebuild derived
artifacts from retained sources and compatible extraction without provider
calls. Use the cache-only consumer and verify zero calls during that rebuild.
Changing the extraction model, prompt, request partition, source identity or
required proposal schema can invalidate reuse; retain old raw responses for
inspection, but do not label them compatible or silently reinterpret a sealed
manifest. Run a bounded subset first when those contracts may still change.

The fact-frame normalizer v2 preserves supported source modal qualifiers.
Its operator identity changes the extraction replay formation digest, without
changing raw extraction shard keys. Re-form derived generations from compatible
raw extraction before using this behavior. A historical capture that omitted a
required modal fails Core replay; the existing projection rebuild reports the
invalid owner and rolls back the entire working-copy transaction. It does not
silently repair that capture or continue with partial projections.
Existing SQLite certificates are not retrospectively revoked: Storage verifies
their sealed Protocol evidence without rerunning the Core normalizer. This
change governs new formation and Core replay, not semantic migration of old
databases, and does not establish whole-source completeness or resolve other
unsupported constructions.
