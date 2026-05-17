# Bench Report — public / longmemeval-oracle

- Run at: 2026-05-14T11:25:28.713Z
- Sample size: 500 (evaluated 500/500)
- Harness mode: mcp_propose_review
- Alaya commit: 3d4dbef (0.3.6)
- Embedding: none
- Chat: none
- Dataset: longmemeval_oracle (size=500)

## Scoring contract

Read this before quoting any KPI below as evidence of Alaya recall quality.

- **Scoring rule.** Hits are scored by `object_id` set-membership
  against a sidecar populated when each haystack turn is seeded —
  not by string substring overlap. A recall pointer is a hit iff its
  `object_id` maps in the sidecar to a turn flagged `has_answer=true`
  whose session_id is in the question's `answer_session_ids`.
- **Oracle vs S: coarser retrieval, not no-retrieval.** On the
  cleaned Oracle dataset (HuggingFace `xiaowu0162/longmemeval-cleaned`,
  500/500 questions) `set(haystack_session_ids) == set(answer_session_ids)`
  holds across the corpus, so the runner's
  `answerSessionSet.has(meta.session_id)` filter is a no-op for the
  *session* predicate. The `has_answer=true` predicate is still a
  real filter — Oracle R@K measures whether top-K recall surfaces
  the actual answer-bearing turn within a small (~5-15 turn)
  haystack of answer-session turns. It is retrieval, but coarser:
  it cannot distinguish *wrong-session* misses from *wrong-turn*
  misses (because there are no distractor sessions to be the
  wrong session). The `longmemeval-s` split (with ~98% distractor
  session ratio per question) is the finer retrieval benchmark.

## Verdict

Worst verdict: **WARN** ⚠

## Δ vs previous

| KPI | previous | current | delta | verdict |
|---|---|---|---|---|
| r_at_5 | 1.0000 | 0.8000 | -0.2000 | ⚠ WARN |
| r_at_10 | 1.0000 | 0.9040 | -0.0960 | ⚠ WARN |
| token_saved_ratio_vs_full_prompt | 0.0000 | 0.0000 | 0 | ✓ OK |
| latency_ms_p95 | 89.0000 | 21.0000 | -68.0000 | ✓ OK |
| tier_distribution.hot_share | 0.0000 | 0.0000 | 0 | ✓ OK |

## Absolute KPIs

- R@1: 45.20%
- R@5: 80.00%
- R@10: 90.40%
- Latency p50: 8 ms
- Latency p95: 21 ms
- Token saved vs full-prompt baseline: 0.00%
- Tier distribution: hot=0 warm=500 cold=0
- Degradation reasons: none=489 warm_cascade=0 cold_cascade=11

## Per-scenario rows

| id | version | hit_at_5 | tier |
|---|---|---|---|
| gpt4_2655b836 | 1 | ✓ | warm |
| gpt4_2487a7cb | 1 | ✓ | warm |
| gpt4_76048e76 | 1 | ✓ | warm |
| gpt4_2312f94c | 1 | ✓ | warm |
| 0bb5a684 | 1 | ✓ | warm |
| 08f4fc43 | 1 | ✓ | warm |
| 2c63a862 | 1 | ✗ | warm |
| gpt4_385a5000 | 1 | ✓ | warm |
| 2a1811e2 | 1 | ✓ | warm |
| bbf86515 | 1 | ✓ | warm |
| gpt4_5dcc0aab | 1 | ✓ | warm |
| gpt4_0b2f1d21 | 1 | ✗ | warm |
| f0853d11 | 1 | ✓ | warm |
| gpt4_6ed717ea | 1 | ✓ | warm |
| gpt4_70e84552 | 1 | ✓ | warm |
| a3838d2b | 1 | ✓ | warm |
| gpt4_93159ced | 1 | ✓ | warm |
| gpt4_2d58bcd6 | 1 | ✓ | warm |
| gpt4_65aabe59 | 1 | ✓ | warm |
| 982b5123 | 1 | ✓ | warm |
| b9cfe692 | 1 | ✓ | warm |
| gpt4_4edbafa2 | 1 | ✓ | warm |
| c8090214 | 1 | ✓ | warm |
| gpt4_483dd43c | 1 | ✓ | warm |
| e4e14d04 | 1 | ✓ | warm |
| c9f37c46 | 1 | ✓ | warm |
| gpt4_2c50253f | 1 | ✓ | warm |
| dcfa8644 | 1 | ✓ | warm |
| gpt4_b4a80587 | 1 | ✓ | warm |
| gpt4_9a159967 | 1 | ✗ | warm |
| cc6d1ec1 | 1 | ✓ | warm |
| gpt4_8c8961ae | 1 | ✗ | warm |
| gpt4_d9af6064 | 1 | ✓ | warm |
| gpt4_7de946e7 | 1 | ✓ | warm |
| d01c6aa8 | 1 | ✗ | warm |
| 993da5e2 | 1 | ✓ | warm |
| a3045048 | 1 | ✓ | warm |
| gpt4_d31cdae3 | 1 | ✓ | warm |
| gpt4_cd90e484 | 1 | ✓ | warm |
| gpt4_88806d6e | 1 | ✓ | warm |
| gpt4_4cd9eba1 | 1 | ✓ | warm |
| gpt4_93f6379c | 1 | ✓ | warm |
| b29f3365 | 1 | ✗ | warm |
| gpt4_2f56ae70 | 1 | ✓ | warm |
| 6613b389 | 1 | ✓ | warm |
| gpt4_78cf46a3 | 1 | ✗ | warm |
| gpt4_0a05b494 | 1 | ✓ | warm |
| gpt4_1a1dc16d | 1 | ✓ | warm |
| gpt4_2f584639 | 1 | ✓ | warm |
| gpt4_213fd887 | 1 | ✓ | warm |
| gpt4_5438fa52 | 1 | ✗ | warm |
| gpt4_c27434e8 | 1 | ✓ | warm |
| gpt4_fe651585 | 1 | ✓ | warm |
| 8c18457d | 1 | ✓ | warm |
| gpt4_70e84552_abs | 1 | ✓ | warm |
| gpt4_93159ced_abs | 1 | ✗ | warm |
| 982b5123_abs | 1 | ✓ | warm |
| c8090214_abs | 1 | ✓ | warm |
| gpt4_c27434e8_abs | 1 | ✓ | warm |
| gpt4_fe651585_abs | 1 | ✓ | warm |
| 0a995998 | 1 | ✓ | warm |
| 6d550036 | 1 | ✓ | warm |
| gpt4_59c863d7 | 1 | ✓ | warm |
| b5ef892d | 1 | ✓ | warm |
| e831120c | 1 | ✓ | warm |
| 3a704032 | 1 | ✓ | warm |
| gpt4_d84a3211 | 1 | ✓ | warm |
| aae3761f | 1 | ✓ | warm |
| gpt4_f2262a51 | 1 | ✗ | warm |
| dd2973ad | 1 | ✓ | warm |
| c4a1ceb8 | 1 | ✗ | warm |
| gpt4_a56e767c | 1 | ✓ | warm |
| 6cb6f249 | 1 | ✓ | warm |
| 46a3abf7 | 1 | ✓ | warm |
| 36b9f61e | 1 | ✗ | warm |
| 28dc39ac | 1 | ✓ | warm |
| gpt4_2f8be40d | 1 | ✓ | warm |
| 2e6d26dc | 1 | ✓ | warm |
| gpt4_15e38248 | 1 | ✓ | warm |
| 88432d0a | 1 | ✗ | warm |
| 80ec1f4f | 1 | ✗ | warm |
| d23cf73b | 1 | ✓ | warm |
| gpt4_7fce9456 | 1 | ✓ | warm |
| d682f1a2 | 1 | ✓ | warm |
| 7024f17c | 1 | ✓ | warm |
| gpt4_5501fe77 | 1 | ✓ | warm |
| gpt4_2ba83207 | 1 | ✓ | warm |
| 2318644b | 1 | ✓ | warm |
| 2ce6a0f2 | 1 | ✓ | warm |
| gpt4_d12ceb0e | 1 | ✓ | warm |
| 00ca467f | 1 | ✓ | warm |
| b3c15d39 | 1 | ✓ | warm |
| gpt4_31ff4165 | 1 | ✓ | warm |
| eeda8a6d | 1 | ✓ | warm |
| 2788b940 | 1 | ✗ | warm |
| 60bf93ed | 1 | ✓ | warm |
| 9d25d4e0 | 1 | ✗ | warm |
| 129d1232 | 1 | ✓ | warm |
| 60472f9c | 1 | ✓ | warm |
| gpt4_194be4b3 | 1 | ✗ | warm |
| a9f6b44c | 1 | ✓ | warm |
| d851d5ba | 1 | ✗ | warm |
| 5a7937c8 | 1 | ✓ | warm |
| gpt4_ab202e7f | 1 | ✗ | warm |
| gpt4_e05b82a6 | 1 | ✓ | warm |
| gpt4_731e37d7 | 1 | ✓ | warm |
| edced276 | 1 | ✓ | warm |
| 10d9b85a | 1 | ✓ | warm |
| e3038f8c | 1 | ✓ | warm |
| 2b8f3739 | 1 | ✓ | warm |
| 1a8a66a6 | 1 | ✗ | warm |
| c2ac3c61 | 1 | ✓ | warm |
| bf659f65 | 1 | ✓ | warm |
| gpt4_372c3eed | 1 | ✓ | warm |
| gpt4_2f91af09 | 1 | ✓ | warm |
| 81507db6 | 1 | ✓ | warm |
| 88432d0a_abs | 1 | ✗ | warm |
| 80ec1f4f_abs | 1 | ✗ | warm |
| eeda8a6d_abs | 1 | ✗ | warm |
| 60bf93ed_abs | 1 | ✗ | warm |
| edced276_abs | 1 | ✗ | warm |
| gpt4_372c3eed_abs | 1 | ✗ | warm |
| 6a1eabeb | 1 | ✓ | warm |
| 6aeb4375 | 1 | ✓ | warm |
| 830ce83f | 1 | ✓ | warm |
| 852ce960 | 1 | ✓ | warm |
| 945e3d21 | 1 | ✓ | warm |
| d7c942c3 | 1 | ✓ | warm |
| 71315a70 | 1 | ✓ | warm |
| 89941a93 | 1 | ✗ | warm |
| ce6d2d27 | 1 | ✓ | warm |
| 9ea5eabc | 1 | ✓ | warm |
| 07741c44 | 1 | ✗ | warm |
| a1eacc2a | 1 | ✓ | warm |
| 184da446 | 1 | ✓ | warm |
| 031748ae | 1 | ✓ | warm |
| 4d6b87c8 | 1 | ✓ | warm |
| 0f05491a | 1 | ✓ | warm |
| 08e075c7 | 1 | ✓ | warm |
| f9e8c073 | 1 | ✓ | warm |
| 41698283 | 1 | ✗ | warm |
| 2698e78f | 1 | ✓ | warm |
| b6019101 | 1 | ✓ | warm |
| 45dc21b6 | 1 | ✓ | warm |
| 5a4f22c0 | 1 | ✓ | warm |
| 6071bd76 | 1 | ✓ | warm |
| e493bb7c | 1 | ✓ | warm |
| 618f13b2 | 1 | ✓ | warm |
| 72e3ee87 | 1 | ✓ | warm |
| c4ea545c | 1 | ✗ | warm |
| 01493427 | 1 | ✓ | warm |
| 6a27ffc2 | 1 | ✓ | warm |
| 2133c1b5 | 1 | ✓ | warm |
| 18bc8abd | 1 | ✓ | warm |
| db467c8c | 1 | ✓ | warm |
| 7a87bd0c | 1 | ✓ | warm |
| e61a7584 | 1 | ✓ | warm |
| 1cea1afa | 1 | ✗ | warm |
| ed4ddc30 | 1 | ✓ | warm |
| 8fb83627 | 1 | ✓ | warm |
| b01defab | 1 | ✓ | warm |
| 22d2cb42 | 1 | ✓ | warm |
| 0e4e4c46 | 1 | ✓ | warm |
| 4b24c848 | 1 | ✓ | warm |
| 7e974930 | 1 | ✓ | warm |
| 603deb26 | 1 | ✓ | warm |
| 59524333 | 1 | ✓ | warm |
| 5831f84d | 1 | ✓ | warm |
| eace081b | 1 | ✓ | warm |
| affe2881 | 1 | ✓ | warm |
| 50635ada | 1 | ✗ | warm |
| e66b632c | 1 | ✓ | warm |
| 0ddfec37 | 1 | ✓ | warm |
| f685340e | 1 | ✓ | warm |
| cc5ded98 | 1 | ✗ | warm |
| dfde3500 | 1 | ✓ | warm |
| 69fee5aa | 1 | ✓ | warm |
| 7401057b | 1 | ✓ | warm |
| cf22b7bf | 1 | ✓ | warm |
| a2f3aa27 | 1 | ✓ | warm |
| c7dc5443 | 1 | ✓ | warm |
| 06db6396 | 1 | ✓ | warm |
| 3ba21379 | 1 | ✗ | warm |
| 9bbe84a2 | 1 | ✗ | warm |
| 10e09553 | 1 | ✓ | warm |
| dad224aa | 1 | ✓ | warm |
| ba61f0b9 | 1 | ✓ | warm |
| 42ec0761 | 1 | ✓ | warm |
| 5c40ec5b | 1 | ✓ | warm |
| c6853660 | 1 | ✓ | warm |
| 26bdc477 | 1 | ✓ | warm |
| 0977f2af | 1 | ✗ | warm |
| 6aeb4375_abs | 1 | ✗ | warm |
| 031748ae_abs | 1 | ✗ | warm |
| 2698e78f_abs | 1 | ✗ | warm |
| 2133c1b5_abs | 1 | ✗ | warm |
| 0ddfec37_abs | 1 | ✗ | warm |
| f685340e_abs | 1 | ✗ | warm |
| 89941a94 | 1 | ✓ | warm |
| 07741c45 | 1 | ✓ | warm |
| 8a2466db | 1 | ✓ | warm |
| 06878be2 | 1 | ✓ | warm |
| 75832dbd | 1 | ✓ | warm |
| 0edc2aef | 1 | ✗ | warm |
| 35a27287 | 1 | ✗ | warm |
| 32260d93 | 1 | ✓ | warm |
| 195a1a1b | 1 | ✓ | warm |
| afdc33df | 1 | ✗ | warm |
| caf03d32 | 1 | ✓ | warm |
| 54026fce | 1 | ✓ | warm |
| 06f04340 | 1 | ✓ | warm |
| 6b7dfb22 | 1 | ✓ | warm |
| 1a1907b4 | 1 | ✓ | warm |
| 09d032c9 | 1 | ✓ | warm |
| 38146c39 | 1 | ✓ | warm |
| d24813b1 | 1 | ✓ | warm |
| 57f827a0 | 1 | ✓ | warm |
| 95228167 | 1 | ✓ | warm |
| 505af2f5 | 1 | ✓ | warm |
| 75f70248 | 1 | ✓ | warm |
| d6233ab6 | 1 | ✗ | warm |
| 1da05512 | 1 | ✓ | warm |
| fca70973 | 1 | ✓ | warm |
| b6025781 | 1 | ✓ | warm |
| a89d7624 | 1 | ✓ | warm |
| b0479f84 | 1 | ✓ | warm |
| 1d4e3b97 | 1 | ✗ | warm |
| 07b6f563 | 1 | ✓ | warm |
| 1c0ddc50 | 1 | ✓ | warm |
| 0a34ad58 | 1 | ✗ | warm |
| 7161e7e2 | 1 | ✓ | warm |
| c4f10528 | 1 | ✓ | warm |
| 89527b6b | 1 | ✓ | warm |
| e9327a54 | 1 | ✓ | warm |
| 4c36ccef | 1 | ✓ | warm |
| 6ae235be | 1 | ✓ | warm |
| 7e00a6cb | 1 | ✓ | warm |
| 1903aded | 1 | ✓ | warm |
| ceb54acb | 1 | ✓ | warm |
| f523d9fe | 1 | ✓ | warm |
| 0e5e2d1a | 1 | ✓ | warm |
| fea54f57 | 1 | ✓ | warm |
| cc539528 | 1 | ✓ | warm |
| dc439ea3 | 1 | ✗ | warm |
| 18dcd5a5 | 1 | ✓ | warm |
| 488d3006 | 1 | ✓ | warm |
| 58470ed2 | 1 | ✓ | warm |
| 8cf51dda | 1 | ✓ | warm |
| 1d4da289 | 1 | ✓ | warm |
| 8464fc84 | 1 | ✓ | warm |
| 8aef76bc | 1 | ✓ | warm |
| 71a3fd6b | 1 | ✓ | warm |
| 2bf43736 | 1 | ✓ | warm |
| 70b3e69b | 1 | ✗ | warm |
| 8752c811 | 1 | ✓ | warm |
| 3249768e | 1 | ✓ | warm |
| 1b9b7252 | 1 | ✓ | warm |
| 1568498a | 1 | ✗ | warm |
| 6222b6eb | 1 | ✓ | warm |
| e8a79c70 | 1 | ✓ | warm |
| d596882b | 1 | ✓ | warm |
| e3fc4d6e | 1 | ✓ | warm |
| 51b23612 | 1 | ✓ | warm |
| 3e321797 | 1 | ✓ | warm |
| e982271f | 1 | ✓ | warm |
| 352ab8bd | 1 | ✓ | warm |
| fca762bc | 1 | ✓ | warm |
| 7a8d0b71 | 1 | ✓ | warm |
| a40e080f | 1 | ✓ | warm |
| 8b9d4367 | 1 | ✓ | warm |
| 5809eb10 | 1 | ✓ | warm |
| 41275add | 1 | ✓ | warm |
| 4388e9dd | 1 | ✓ | warm |
| 4baee567 | 1 | ✗ | warm |
| 561fabcd | 1 | ✗ | warm |
| b759caee | 1 | ✓ | warm |
| ac031881 | 1 | ✓ | warm |
| 28bcfaac | 1 | ✓ | warm |
| 16c90bf4 | 1 | ✓ | warm |
| c8f1aeed | 1 | ✓ | warm |
| eaca4986 | 1 | ✓ | warm |
| c7cf7dfd | 1 | ✓ | warm |
| e48988bc | 1 | ✓ | warm |
| 1de5cff2 | 1 | ✓ | warm |
| 65240037 | 1 | ✗ | warm |
| 778164c6 | 1 | ✓ | warm |
| e47becba | 1 | ✓ | warm |
| 118b2229 | 1 | ✓ | warm |
| 51a45a95 | 1 | ✓ | warm |
| 58bf7951 | 1 | ✓ | warm |
| 1e043500 | 1 | ✓ | warm |
| c5e8278d | 1 | ✓ | warm |
| 6ade9755 | 1 | ✗ | warm |
| 6f9b354f | 1 | ✓ | warm |
| 58ef2f1c | 1 | ✓ | warm |
| f8c5f88b | 1 | ✓ | warm |
| 5d3d2817 | 1 | ✓ | warm |
| 7527f7e2 | 1 | ✓ | warm |
| c960da58 | 1 | ✓ | warm |
| 3b6f954b | 1 | ✓ | warm |
| 726462e0 | 1 | ✓ | warm |
| 94f70d80 | 1 | ✓ | warm |
| 66f24dbb | 1 | ✓ | warm |
| ad7109d1 | 1 | ✓ | warm |
| af8d2e46 | 1 | ✓ | warm |
| dccbc061 | 1 | ✓ | warm |
| c8c3f81d | 1 | ✓ | warm |
| 8ebdbe50 | 1 | ✓ | warm |
| 6b168ec8 | 1 | ✓ | warm |
| 75499fd8 | 1 | ✗ | warm |
| 21436231 | 1 | ✓ | warm |
| 95bcc1c8 | 1 | ✓ | warm |
| 0862e8bf | 1 | ✓ | warm |
| 853b0a1d | 1 | ✓ | warm |
| a06e4cfe | 1 | ✓ | warm |
| 37d43f65 | 1 | ✓ | warm |
| b86304ba | 1 | ✓ | warm |
| d52b4f67 | 1 | ✓ | warm |
| 25e5aa4f | 1 | ✓ | warm |
| caf9ead2 | 1 | ✓ | warm |
| 8550ddae | 1 | ✓ | warm |
| 60d45044 | 1 | ✓ | warm |
| 3f1e9474 | 1 | ✗ | warm |
| 86b68151 | 1 | ✓ | warm |
| 577d4d32 | 1 | ✓ | warm |
| ec81a493 | 1 | ✓ | warm |
| 15745da0 | 1 | ✓ | warm |
| e01b8e2f | 1 | ✓ | warm |
| bc8a6e93 | 1 | ✓ | warm |
| ccb36322 | 1 | ✓ | warm |
| 001be529 | 1 | ✓ | warm |
| b320f3f8 | 1 | ✓ | warm |
| 19b5f2b3 | 1 | ✓ | warm |
| 4fd1909e | 1 | ✓ | warm |
| 545bd2b5 | 1 | ✓ | warm |
| 8a137a7f | 1 | ✓ | warm |
| 76d63226 | 1 | ✓ | warm |
| 86f00804 | 1 | ✓ | warm |
| 8e9d538c | 1 | ✓ | warm |
| 311778f1 | 1 | ✓ | warm |
| c19f7a0b | 1 | ✓ | warm |
| 4100d0a0 | 1 | ✓ | warm |
| 29f2956b | 1 | ✓ | warm |
| 1faac195 | 1 | ✓ | warm |
| faba32e5 | 1 | ✓ | warm |
| f4f1d8a4 | 1 | ✓ | warm |
| c14c00dd | 1 | ✓ | warm |
| 36580ce8 | 1 | ✓ | warm |
| 3d86fd0a | 1 | ✗ | warm |
| a82c026e | 1 | ✓ | warm |
| 0862e8bf_abs | 1 | ✗ | warm |
| 15745da0_abs | 1 | ✗ | warm |
| bc8a6e93_abs | 1 | ✗ | warm |
| 19b5f2b3_abs | 1 | ✗ | warm |
| 29f2956b_abs | 1 | ✗ | warm |
| f4f1d8a4_abs | 1 | ✗ | warm |
| gpt4_59149c77 | 1 | ✓ | warm |
| gpt4_f49edff3 | 1 | ✓ | warm |
| 71017276 | 1 | ✓ | warm |
| b46e15ed | 1 | ✓ | warm |
| gpt4_fa19884c | 1 | ✓ | warm |
| 0bc8ad92 | 1 | ✓ | warm |
| af082822 | 1 | ✓ | warm |
| gpt4_4929293a | 1 | ✓ | warm |
| gpt4_b5700ca9 | 1 | ✓ | warm |
| 9a707b81 | 1 | ✓ | warm |
| gpt4_1d4ab0c9 | 1 | ✓ | warm |
| gpt4_e072b769 | 1 | ✗ | warm |
| 0db4c65d | 1 | ✓ | warm |
| gpt4_1d80365e | 1 | ✓ | warm |
| gpt4_7f6b06db | 1 | ✗ | warm |
| gpt4_6dc9b45b | 1 | ✓ | warm |
| gpt4_8279ba02 | 1 | ✓ | warm |
| gpt4_18c2b244 | 1 | ✓ | warm |
| gpt4_a1b77f9c | 1 | ✓ | warm |
| gpt4_1916e0ea | 1 | ✓ | warm |
| gpt4_7a0daae1 | 1 | ✓ | warm |
| gpt4_468eb063 | 1 | ✗ | warm |
| gpt4_7abb270c | 1 | ✓ | warm |
| gpt4_1e4a8aeb | 1 | ✓ | warm |
| gpt4_4fc4f797 | 1 | ✓ | warm |
| 4dfccbf7 | 1 | ✓ | warm |
| gpt4_61e13b3c | 1 | ✓ | warm |
| gpt4_45189cb4 | 1 | ✓ | warm |
| 2ebe6c90 | 1 | ✓ | warm |
| gpt4_e061b84f | 1 | ✓ | warm |
| 370a8ff4 | 1 | ✓ | warm |
| gpt4_d6585ce8 | 1 | ✓ | warm |
| gpt4_4ef30696 | 1 | ✓ | warm |
| gpt4_ec93e27f | 1 | ✓ | warm |
| 6e984301 | 1 | ✓ | warm |
| 8077ef71 | 1 | ✓ | warm |
| gpt4_f420262c | 1 | ✓ | warm |
| gpt4_8e165409 | 1 | ✓ | warm |
| gpt4_74aed68e | 1 | ✓ | warm |
| bcbe585f | 1 | ✓ | warm |
| gpt4_21adecb5 | 1 | ✓ | warm |
| 5e1b23de | 1 | ✓ | warm |
| gpt4_98f46fc6 | 1 | ✗ | warm |
| gpt4_af6db32f | 1 | ✓ | warm |
| eac54adc | 1 | ✓ | warm |
| gpt4_7ddcf75f | 1 | ✓ | warm |
| gpt4_a2d1d1f6 | 1 | ✓ | warm |
| gpt4_85da3956 | 1 | ✗ | warm |
| gpt4_b0863698 | 1 | ✓ | warm |
| gpt4_68e94287 | 1 | ✓ | warm |
| gpt4_e414231e | 1 | ✓ | warm |
| gpt4_7ca326fa | 1 | ✓ | warm |
| gpt4_7bc6cf22 | 1 | ✓ | warm |
| 2ebe6c92 | 1 | ✓ | warm |
| gpt4_e061b84g | 1 | ✗ | warm |
| 71017277 | 1 | ✓ | warm |
| b46e15ee | 1 | ✓ | warm |
| gpt4_d6585ce9 | 1 | ✓ | warm |
| gpt4_1e4a8aec | 1 | ✗ | warm |
| gpt4_f420262d | 1 | ✓ | warm |
| gpt4_59149c78 | 1 | ✗ | warm |
| gpt4_e414231f | 1 | ✗ | warm |
| gpt4_4929293b | 1 | ✗ | warm |
| gpt4_468eb064 | 1 | ✓ | warm |
| gpt4_fa19884d | 1 | ✗ | warm |
| 9a707b82 | 1 | ✓ | warm |
| eac54add | 1 | ✗ | warm |
| 4dfccbf8 | 1 | ✗ | warm |
| 0bc8ad93 | 1 | ✓ | warm |
| 6e984302 | 1 | ✗ | warm |
| gpt4_8279ba03 | 1 | ✗ | warm |
| gpt4_b5700ca0 | 1 | ✓ | warm |
| gpt4_68e94288 | 1 | ✗ | warm |
| d3ab962e | 1 | ✓ | warm |
| 2311e44b | 1 | ✗ | warm |
| cc06de0d | 1 | ✓ | warm |
| a11281a2 | 1 | ✓ | warm |
| 4f54b7c9 | 1 | ✓ | warm |
| 85fa3a3f | 1 | ✗ | warm |
| 9aaed6a3 | 1 | ✗ | warm |
| 1f2b8d4f | 1 | ✓ | warm |
| e6041065 | 1 | ✓ | warm |
| 51c32626 | 1 | ✓ | warm |
| d905b33f | 1 | ✓ | warm |
| 7405e8b1 | 1 | ✗ | warm |
| f35224e0 | 1 | ✓ | warm |
| 6456829e | 1 | ✓ | warm |
| a4996e51 | 1 | ✗ | warm |
| 3c1045c8 | 1 | ✓ | warm |
| 60036106 | 1 | ✓ | warm |
| 681a1674 | 1 | ✓ | warm |
| e25c3b8d | 1 | ✗ | warm |
| 4adc0475 | 1 | ✓ | warm |
| 4bc144e2 | 1 | ✗ | warm |
| ef66a6e5 | 1 | ✓ | warm |
| 5025383b | 1 | ✓ | warm |
| a1cc6108 | 1 | ✓ | warm |
| 9ee3ecd6 | 1 | ✓ | warm |
| 3fdac837 | 1 | ✗ | warm |
| 91b15a6e | 1 | ✗ | warm |
| 27016adc | 1 | ✓ | warm |
| 720133ac | 1 | ✗ | warm |
| 77eafa52 | 1 | ✗ | warm |
| 8979f9ec | 1 | ✓ | warm |
| 0100672e | 1 | ✓ | warm |
| a96c20ee | 1 | ✓ | warm |
| 92a0aa75 | 1 | ✓ | warm |
| 3fe836c9 | 1 | ✓ | warm |
| 1c549ce4 | 1 | ✗ | warm |
| 6c49646a | 1 | ✓ | warm |
| 1192316e | 1 | ✓ | warm |
| 0ea62687 | 1 | ✓ | warm |
| 67e0d0f2 | 1 | ✗ | warm |
| bb7c3b45 | 1 | ✓ | warm |
| ba358f49 | 1 | ✓ | warm |
| 61f8c8f8 | 1 | ✓ | warm |
| 60159905 | 1 | ✓ | warm |
| ef9cf60a | 1 | ✗ | warm |
| 73d42213 | 1 | ✓ | warm |
| bc149d6b | 1 | ✓ | warm |
| 099778bb | 1 | ✓ | warm |
| 09ba9854 | 1 | ✗ | warm |
| d6062bb9 | 1 | ✓ | warm |
| 157a136e | 1 | ✓ | warm |
| c18a7dc8 | 1 | ✓ | warm |
| a3332713 | 1 | ✓ | warm |
| 55241a1f | 1 | ✓ | warm |
| a08a253f | 1 | ✓ | warm |
| f0e564bc | 1 | ✓ | warm |
| 078150f1 | 1 | ✓ | warm |
| 8cf4d046 | 1 | ✓ | warm |
| a346bb18 | 1 | ✓ | warm |
| 37f165cf | 1 | ✓ | warm |
| 8e91e7d9 | 1 | ✓ | warm |
| 87f22b4a | 1 | ✗ | warm |
| e56a43b9 | 1 | ✓ | warm |
| efc3f7c2 | 1 | ✓ | warm |
| 21d02d0d | 1 | ✓ | warm |
| 2311e44b_abs | 1 | ✗ | warm |
| 6456829e_abs | 1 | ✓ | warm |
| e5ba910e_abs | 1 | ✓ | warm |
| a96c20ee_abs | 1 | ✗ | warm |
| ba358f49_abs | 1 | ✗ | warm |
| 09ba9854_abs | 1 | ✗ | warm |
