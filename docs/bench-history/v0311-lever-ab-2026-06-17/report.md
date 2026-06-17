# v0.3.11 recall-lever A/B — 2026-06-17

Controlled A/B isolating each candidate recall lever. NOT a release-grade entry
(limit-100, `local_heuristics` seeding) — it is a lever-attribution experiment, kept
out of the `public/` release chain on purpose. Raw per-config `*.kpi.json` +
`*.diagnostics.json` sit beside this file.

## Conditions (identical across all 6 configs)

- Dataset: LongMemEval-S, `--limit 100`, `evaluated_count = 100`.
- Code: a single frozen commit **144b94a**, run from an isolated git worktree so a
  concurrent Codex session editing `main` could not contaminate the comparison.
  Every config's `kpi.json.alaya_commit == 144b94a` (verified).
- Seeding: extraction cache hit 100% (`cache_hits` only, `llm_calls=0`, model
  gpt-5.4-nano, coverage=1); daemon reconciliation forced to `local_heuristics`
  (`ALAYA_GARDEN_PROVIDER_KIND=local_heuristics`) so seeding is offline, fast, and
  identical across configs — the recall-side deltas stay attributable.
- Answer + judge: gpt-5.4-nano (operator choice; weak reader surfaces recall effect).
- Embedding-on configs: local ONNX `Xenova/paraphrase-multilingual-MiniLM-L12-v2`.

## Configs

| label | flags | embedding |
|-------|-------|-----------|
| A-base-off     | (none)                                    | off |
| B-fix1b-off    | `ALAYA_BENCH_SESSION_SURFACES=1`          | off |
| G-retune-off   | `ALAYA_RECALL_FUSION_RETUNE_V1=1`         | off |
| C-embed        | (none)                                    | local_onnx |
| E-retune-embed | `ALAYA_RECALL_FUSION_RETUNE_V1=1`         | local_onnx |
| F-all-embed    | `ALAYA_BENCH_SESSION_SURFACES=1` + `RETUNE_V1=1` | local_onnx |

## Results

| cfg            | R@1 | R@5 | R@10 | QA%  | ss-user | multi | o0@5 | o1@5 | o1wall | lexDsp |
|----------------|-----|-----|------|------|---------|-------|------|------|--------|--------|
| A base off     | 59  | 91  | 94   | 60.0 | 52/70   | 8/30  | 85   | 63   | 101    | 1449   |
| B fix1b off    | 59  | 87  | 92   | 59.0 | 54/70   | 5/30  | 80   | 44   | 103    | 1544   |
| G retune off   | 36  | 76  | 79   | 49.0 | 48/70   | 1/30  | 69   | 34   | 159    |  705   |
| C embedding    | 68  | 91  | 92   | 65.0 | 58/70   | 7/30  | 86   | 73   |  81    | 1400   |
| E retune+emb   | 58  | 88  | 92   | 60.0 | 54/70   | 6/30  | 84   | 72   |  75    | 1401   |
| F all-on       | 61  | 87  | 90   | 64.0 | 57/70   | 7/30  | 82   | 62   |  73    | 1446   |

(o0@5 / o1@5 = best / 2nd+ gold delivered in top-5; o1wall = 2nd+ gold at rank >50 or
absent; lexDsp = golds displaced by a lexical_topic_neighbor.)

## Verdict

- **Embedding stream (C) is the only lever that takes effect.** vs baseline A:
  R@1 +9, QA +5, ss-user +6, 2nd-gold@5 +10, pool-wall −20. The three-wall E-fixes
  (injection cap 2→10, HOT+WARM tiers, local_onnx default-on) work. Keep.
- **Fusion retune (`ALAYA_RECALL_FUSION_RETUNE_V1`) regresses.** Embed-off (G) is
  catastrophic (R@1 −23, QA −11); embed-on (E) erases the embedding win
  (QA 65→60). The mean-rank lexical composite loses RRF multi-lane additivity — a
  mechanism flaw, not a constant to tune. Remove.
- **Session-coverage rerank (Fix-1b) is marginal/negative at the default band
  (0.10).** Embed-off (B) drops R@5 −4 and 2nd-gold −19; embed-on (F) sits below
  embedding-alone (C). Best single config is C, not F (all-on). Remove or band-tune.
- multi-session QA stays ~7-8/30 across all configs = reader/aggregation ceiling, not
  recall; the embedding win is concentrated in single-session-user.

## Reproduce

Worktree frozen at 144b94a; driver + analysis under
`.do-it/bench-runs/pc/` (gitignored). Per-config command shape:
`rtk node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval --variant s
--limit 100 <embedding flags> --qa --data-dir docs/bench-history/data/longmemeval
--extraction-cache-root docs/bench-history/datasets/longmemeval-extraction-cache`
with `ALAYA_GARDEN_PROVIDER_KIND=local_heuristics`,
`ALAYA_LOCAL_EMBEDDING_CACHE_DIR=$HOME/.cache/do-soul-alaya/models`, and the QA
proxy preload (Node global fetch → Clash). Full narrative:
`.do-it/findings/v0311-recall-lever-campaign.md`.
