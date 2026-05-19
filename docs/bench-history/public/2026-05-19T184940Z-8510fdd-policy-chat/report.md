# Bench Report — public / longmemeval-s

- Run at: 2026-05-19T18:49:40.151Z
- Sample size: 500 (evaluated 500/500, label=full)
- Harness mode: mcp_propose_review
- Alaya commit: 8510fdd (0.3.9)
- Recall pipeline: fusion-rrf-v1
- Embedding: none
- Chat: none
- Policy shape: chat
- Dataset: longmemeval_s (size=500)
- Seed policy: label_independent_all_fact (label-independent)

## Scoring contract

Read this before quoting any KPI below as evidence of Alaya recall quality.

- **Scoring rule.** Hits are scored by `object_id` set-membership
  against a sidecar populated when each haystack turn is seeded —
  not by string substring overlap. A recall pointer is a hit iff its
  `object_id` maps in the sidecar to a turn flagged `has_answer=true`
  whose session_id is in the question's `answer_session_ids`.
- **LongMemEval-S retrieval evaluation.** S includes distractor
  sessions whose session_id is NOT in `answer_session_ids`, so the
  filter is a real predicate (not a no-op). R@K on this split means
  *given the question, how often does the top-K recall surface a
  `has_answer=true` turn from an answer session, when distractor
  sessions are present in the haystack*. This is the honest
  retrieval number; quote it directly.

## Verdict

Worst verdict: **FAIL** ✗

Release hard gates:
- ✗ longmemeval_s_500_embedding_off_r_at_5 LongMemEval-S 500 embedding-off R@5: 64.80% < target 65.00%
- ✓ longmemeval_s_non_monotonic_rate non_monotonic_rate: 0.00% <= target 10.00%
- ✓ longmemeval_s_budget_dropped_max_entries budget_dropped_entries: 0 <= target 8
- ✓ longmemeval_s_candidate_absent candidate_absent: 4 <= target 6
- ✓ longmemeval_s_evidence_stream_gold_delivery evidence stream gold delivery: 100.00% >= target 15.00%
- ✓ recall_p95_embedding_off recall p95 embedding-off: 180ms <= target 200ms
  - The delta verdict is only a regression check against the previous archive entry; failed release hard gates block the archive even when no previous baseline exists.

## Δ vs previous

| KPI | previous | current | delta | verdict |
|---|---|---|---|---|
| r_at_5 | 0.6420 | 0.6480 | +0.0060 | ✓ OK |
| r_at_10 | 0.7760 | 0.7800 | +0.0040 | ✓ OK |
| token_saved_ratio_vs_full_prompt | 0.0000 | 0.0000 | 0 | ✓ OK |
| latency_ms_p95 | 165.0000 | 180.0000 | +15.0000 | ✓ OK |

## Absolute KPIs

- R@1: 30.20% (95% CI ±4.01pp, [26.34%, 34.36%])
- R@5: 64.80% (95% CI ±4.17pp, [60.52%, 68.86%])
- R@10: 78.00% (95% CI ±3.62pp, [74.16%, 81.41%])
- Latency p50: 117 ms
- Latency p95: 180 ms
- Token saved vs full-prompt baseline: 0.00%
- Tier distribution: hot=500 warm=0 cold=0
- Degradation reasons: none=500 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Seed truncation: turns=20 answer_bearing=0 chars_clipped=188651
- Quality metrics: non_monotonic=0.00% (0/500) budget_drop_loss=0 budget_dropped_entries=0 candidate_absent=4 no_gold=21 evidence_gold=100.00% path_top10=0.00%

## Per-scenario rows

| id | version | hit_at_5 | tier |
|---|---|---|---|
| e47becba | 1 | ✓ | hot |
| 118b2229 | 1 | ✓ | hot |
| 51a45a95 | 1 | ✓ | hot |
| 58bf7951 | 1 | ✗ | hot |
| 1e043500 | 1 | ✓ | hot |
| c5e8278d | 1 | ✓ | hot |
| 6ade9755 | 1 | ✗ | hot |
| 6f9b354f | 1 | ✓ | hot |
| 58ef2f1c | 1 | ✓ | hot |
| f8c5f88b | 1 | ✓ | hot |
| 5d3d2817 | 1 | ✓ | hot |
| 7527f7e2 | 1 | ✗ | hot |
| c960da58 | 1 | ✓ | hot |
| 3b6f954b | 1 | ✓ | hot |
| 726462e0 | 1 | ✓ | hot |
| 94f70d80 | 1 | ✗ | hot |
| 66f24dbb | 1 | ✓ | hot |
| ad7109d1 | 1 | ✓ | hot |
| af8d2e46 | 1 | ✓ | hot |
| dccbc061 | 1 | ✓ | hot |
| c8c3f81d | 1 | ✓ | hot |
| 8ebdbe50 | 1 | ✓ | hot |
| 6b168ec8 | 1 | ✓ | hot |
| 75499fd8 | 1 | ✗ | hot |
| 21436231 | 1 | ✓ | hot |
| 95bcc1c8 | 1 | ✗ | hot |
| 0862e8bf | 1 | ✓ | hot |
| 853b0a1d | 1 | ✓ | hot |
| a06e4cfe | 1 | ✓ | hot |
| 37d43f65 | 1 | ✓ | hot |
| b86304ba | 1 | ✗ | hot |
| d52b4f67 | 1 | ✓ | hot |
| 25e5aa4f | 1 | ✗ | hot |
| caf9ead2 | 1 | ✓ | hot |
| 8550ddae | 1 | ✓ | hot |
| 60d45044 | 1 | ✓ | hot |
| 3f1e9474 | 1 | ✓ | hot |
| 86b68151 | 1 | ✓ | hot |
| 577d4d32 | 1 | ✓ | hot |
| ec81a493 | 1 | ✓ | hot |
| 15745da0 | 1 | ✓ | hot |
| e01b8e2f | 1 | ✓ | hot |
| bc8a6e93 | 1 | ✓ | hot |
| ccb36322 | 1 | ✗ | hot |
| 001be529 | 1 | ✓ | hot |
| b320f3f8 | 1 | ✓ | hot |
| 19b5f2b3 | 1 | ✓ | hot |
| 4fd1909e | 1 | ✓ | hot |
| 545bd2b5 | 1 | ✓ | hot |
| 8a137a7f | 1 | ✓ | hot |
| 76d63226 | 1 | ✓ | hot |
| 86f00804 | 1 | ✓ | hot |
| 8e9d538c | 1 | ✓ | hot |
| 311778f1 | 1 | ✓ | hot |
| c19f7a0b | 1 | ✓ | hot |
| 4100d0a0 | 1 | ✓ | hot |
| 29f2956b | 1 | ✓ | hot |
| 1faac195 | 1 | ✓ | hot |
| faba32e5 | 1 | ✗ | hot |
| f4f1d8a4 | 1 | ✓ | hot |
| c14c00dd | 1 | ✓ | hot |
| 36580ce8 | 1 | ✓ | hot |
| 3d86fd0a | 1 | ✓ | hot |
| a82c026e | 1 | ✓ | hot |
| 0862e8bf_abs | 1 | ✗ | hot |
| 15745da0_abs | 1 | ✗ | hot |
| bc8a6e93_abs | 1 | ✗ | hot |
| 19b5f2b3_abs | 1 | ✗ | hot |
| 29f2956b_abs | 1 | ✗ | hot |
| f4f1d8a4_abs | 1 | ✗ | hot |
| 0a995998 | 1 | ✓ | hot |
| 6d550036 | 1 | ✗ | hot |
| gpt4_59c863d7 | 1 | ✓ | hot |
| b5ef892d | 1 | ✓ | hot |
| e831120c | 1 | ✓ | hot |
| 3a704032 | 1 | ✓ | hot |
| gpt4_d84a3211 | 1 | ✗ | hot |
| aae3761f | 1 | ✓ | hot |
| gpt4_f2262a51 | 1 | ✗ | hot |
| dd2973ad | 1 | ✓ | hot |
| c4a1ceb8 | 1 | ✓ | hot |
| gpt4_a56e767c | 1 | ✗ | hot |
| 6cb6f249 | 1 | ✗ | hot |
| 46a3abf7 | 1 | ✗ | hot |
| 36b9f61e | 1 | ✓ | hot |
| 28dc39ac | 1 | ✓ | hot |
| gpt4_2f8be40d | 1 | ✗ | hot |
| 2e6d26dc | 1 | ✓ | hot |
| gpt4_15e38248 | 1 | ✗ | hot |
| 88432d0a | 1 | ✗ | hot |
| 80ec1f4f | 1 | ✗ | hot |
| d23cf73b | 1 | ✓ | hot |
| gpt4_7fce9456 | 1 | ✗ | hot |
| d682f1a2 | 1 | ✓ | hot |
| 7024f17c | 1 | ✓ | hot |
| gpt4_5501fe77 | 1 | ✗ | hot |
| gpt4_2ba83207 | 1 | ✓ | hot |
| 2318644b | 1 | ✓ | hot |
| 2ce6a0f2 | 1 | ✗ | hot |
| gpt4_d12ceb0e | 1 | ✓ | hot |
| 00ca467f | 1 | ✗ | hot |
| b3c15d39 | 1 | ✗ | hot |
| gpt4_31ff4165 | 1 | ✗ | hot |
| eeda8a6d | 1 | ✗ | hot |
| 2788b940 | 1 | ✗ | hot |
| 60bf93ed | 1 | ✓ | hot |
| 9d25d4e0 | 1 | ✗ | hot |
| 129d1232 | 1 | ✓ | hot |
| 60472f9c | 1 | ✗ | hot |
| gpt4_194be4b3 | 1 | ✗ | hot |
| a9f6b44c | 1 | ✗ | hot |
| d851d5ba | 1 | ✓ | hot |
| 5a7937c8 | 1 | ✓ | hot |
| gpt4_ab202e7f | 1 | ✓ | hot |
| gpt4_e05b82a6 | 1 | ✗ | hot |
| gpt4_731e37d7 | 1 | ✗ | hot |
| edced276 | 1 | ✓ | hot |
| 10d9b85a | 1 | ✗ | hot |
| e3038f8c | 1 | ✗ | hot |
| 2b8f3739 | 1 | ✗ | hot |
| 1a8a66a6 | 1 | ✓ | hot |
| c2ac3c61 | 1 | ✓ | hot |
| bf659f65 | 1 | ✓ | hot |
| gpt4_372c3eed | 1 | ✗ | hot |
| gpt4_2f91af09 | 1 | ✗ | hot |
| 81507db6 | 1 | ✓ | hot |
| 88432d0a_abs | 1 | ✗ | hot |
| 80ec1f4f_abs | 1 | ✗ | hot |
| eeda8a6d_abs | 1 | ✗ | hot |
| 60bf93ed_abs | 1 | ✗ | hot |
| edced276_abs | 1 | ✗ | hot |
| gpt4_372c3eed_abs | 1 | ✗ | hot |
| 8a2466db | 1 | ✓ | hot |
| 06878be2 | 1 | ✗ | hot |
| 75832dbd | 1 | ✓ | hot |
| 0edc2aef | 1 | ✗ | hot |
| 35a27287 | 1 | ✗ | hot |
| 32260d93 | 1 | ✗ | hot |
| 195a1a1b | 1 | ✗ | hot |
| afdc33df | 1 | ✗ | hot |
| caf03d32 | 1 | ✓ | hot |
| 54026fce | 1 | ✓ | hot |
| 06f04340 | 1 | ✗ | hot |
| 6b7dfb22 | 1 | ✗ | hot |
| 1a1907b4 | 1 | ✗ | hot |
| 09d032c9 | 1 | ✗ | hot |
| 38146c39 | 1 | ✗ | hot |
| d24813b1 | 1 | ✗ | hot |
| 57f827a0 | 1 | ✗ | hot |
| 95228167 | 1 | ✗ | hot |
| 505af2f5 | 1 | ✗ | hot |
| 75f70248 | 1 | ✓ | hot |
| d6233ab6 | 1 | ✗ | hot |
| 1da05512 | 1 | ✗ | hot |
| fca70973 | 1 | ✓ | hot |
| b6025781 | 1 | ✓ | hot |
| a89d7624 | 1 | ✗ | hot |
| b0479f84 | 1 | ✓ | hot |
| 1d4e3b97 | 1 | ✗ | hot |
| 07b6f563 | 1 | ✓ | hot |
| 1c0ddc50 | 1 | ✗ | hot |
| 0a34ad58 | 1 | ✗ | hot |
| d3ab962e | 1 | ✓ | hot |
| 2311e44b | 1 | ✓ | hot |
| cc06de0d | 1 | ✗ | hot |
| a11281a2 | 1 | ✓ | hot |
| 4f54b7c9 | 1 | ✓ | hot |
| 85fa3a3f | 1 | ✗ | hot |
| 9aaed6a3 | 1 | ✓ | hot |
| 1f2b8d4f | 1 | ✓ | hot |
| e6041065 | 1 | ✓ | hot |
| 51c32626 | 1 | ✓ | hot |
| d905b33f | 1 | ✓ | hot |
| 7405e8b1 | 1 | ✓ | hot |
| f35224e0 | 1 | ✓ | hot |
| 6456829e | 1 | ✓ | hot |
| a4996e51 | 1 | ✓ | hot |
| 3c1045c8 | 1 | ✓ | hot |
| 60036106 | 1 | ✓ | hot |
| 681a1674 | 1 | ✓ | hot |
| e25c3b8d | 1 | ✓ | hot |
| 4adc0475 | 1 | ✓ | hot |
| 4bc144e2 | 1 | ✗ | hot |
| ef66a6e5 | 1 | ✗ | hot |
| 5025383b | 1 | ✓ | hot |
| a1cc6108 | 1 | ✓ | hot |
| 9ee3ecd6 | 1 | ✓ | hot |
| 3fdac837 | 1 | ✗ | hot |
| 91b15a6e | 1 | ✗ | hot |
| 27016adc | 1 | ✓ | hot |
| 720133ac | 1 | ✓ | hot |
| 77eafa52 | 1 | ✗ | hot |
| 8979f9ec | 1 | ✓ | hot |
| 0100672e | 1 | ✓ | hot |
| a96c20ee | 1 | ✓ | hot |
| 92a0aa75 | 1 | ✗ | hot |
| 3fe836c9 | 1 | ✓ | hot |
| 1c549ce4 | 1 | ✓ | hot |
| 6c49646a | 1 | ✓ | hot |
| 1192316e | 1 | ✓ | hot |
| 0ea62687 | 1 | ✓ | hot |
| 67e0d0f2 | 1 | ✗ | hot |
| bb7c3b45 | 1 | ✓ | hot |
| ba358f49 | 1 | ✓ | hot |
| 61f8c8f8 | 1 | ✗ | hot |
| 60159905 | 1 | ✓ | hot |
| ef9cf60a | 1 | ✗ | hot |
| 73d42213 | 1 | ✗ | hot |
| bc149d6b | 1 | ✓ | hot |
| 099778bb | 1 | ✗ | hot |
| 09ba9854 | 1 | ✓ | hot |
| d6062bb9 | 1 | ✗ | hot |
| 157a136e | 1 | ✓ | hot |
| c18a7dc8 | 1 | ✗ | hot |
| a3332713 | 1 | ✓ | hot |
| 55241a1f | 1 | ✓ | hot |
| a08a253f | 1 | ✓ | hot |
| f0e564bc | 1 | ✓ | hot |
| 078150f1 | 1 | ✓ | hot |
| 8cf4d046 | 1 | ✓ | hot |
| a346bb18 | 1 | ✓ | hot |
| 37f165cf | 1 | ✓ | hot |
| 8e91e7d9 | 1 | ✗ | hot |
| 87f22b4a | 1 | ✓ | hot |
| e56a43b9 | 1 | ✓ | hot |
| efc3f7c2 | 1 | ✗ | hot |
| 21d02d0d | 1 | ✓ | hot |
| 2311e44b_abs | 1 | ✗ | hot |
| 6456829e_abs | 1 | ✓ | hot |
| e5ba910e_abs | 1 | ✓ | hot |
| a96c20ee_abs | 1 | ✗ | hot |
| ba358f49_abs | 1 | ✗ | hot |
| 09ba9854_abs | 1 | ✓ | hot |
| gpt4_59149c77 | 1 | ✓ | hot |
| gpt4_f49edff3 | 1 | ✓ | hot |
| 71017276 | 1 | ✓ | hot |
| b46e15ed | 1 | ✓ | hot |
| gpt4_fa19884c | 1 | ✓ | hot |
| 0bc8ad92 | 1 | ✓ | hot |
| af082822 | 1 | ✗ | hot |
| gpt4_4929293a | 1 | ✓ | hot |
| gpt4_b5700ca9 | 1 | ✓ | hot |
| 9a707b81 | 1 | ✓ | hot |
| gpt4_1d4ab0c9 | 1 | ✓ | hot |
| gpt4_e072b769 | 1 | ✗ | hot |
| 0db4c65d | 1 | ✓ | hot |
| gpt4_1d80365e | 1 | ✓ | hot |
| gpt4_7f6b06db | 1 | ✗ | hot |
| gpt4_6dc9b45b | 1 | ✗ | hot |
| gpt4_8279ba02 | 1 | ✗ | hot |
| gpt4_18c2b244 | 1 | ✓ | hot |
| gpt4_a1b77f9c | 1 | ✓ | hot |
| gpt4_1916e0ea | 1 | ✓ | hot |
| gpt4_7a0daae1 | 1 | ✓ | hot |
| gpt4_468eb063 | 1 | ✗ | hot |
| gpt4_7abb270c | 1 | ✓ | hot |
| gpt4_1e4a8aeb | 1 | ✓ | hot |
| gpt4_4fc4f797 | 1 | ✓ | hot |
| 4dfccbf7 | 1 | ✓ | hot |
| gpt4_61e13b3c | 1 | ✓ | hot |
| gpt4_45189cb4 | 1 | ✓ | hot |
| 2ebe6c90 | 1 | ✓ | hot |
| gpt4_e061b84f | 1 | ✗ | hot |
| 370a8ff4 | 1 | ✓ | hot |
| gpt4_d6585ce8 | 1 | ✗ | hot |
| gpt4_4ef30696 | 1 | ✓ | hot |
| gpt4_ec93e27f | 1 | ✗ | hot |
| 6e984301 | 1 | ✓ | hot |
| 8077ef71 | 1 | ✓ | hot |
| gpt4_f420262c | 1 | ✓ | hot |
| gpt4_8e165409 | 1 | ✓ | hot |
| gpt4_74aed68e | 1 | ✓ | hot |
| bcbe585f | 1 | ✓ | hot |
| gpt4_21adecb5 | 1 | ✓ | hot |
| 5e1b23de | 1 | ✓ | hot |
| gpt4_98f46fc6 | 1 | ✗ | hot |
| gpt4_af6db32f | 1 | ✓ | hot |
| eac54adc | 1 | ✓ | hot |
| gpt4_7ddcf75f | 1 | ✓ | hot |
| gpt4_a2d1d1f6 | 1 | ✓ | hot |
| gpt4_85da3956 | 1 | ✓ | hot |
| gpt4_b0863698 | 1 | ✓ | hot |
| gpt4_68e94287 | 1 | ✓ | hot |
| gpt4_e414231e | 1 | ✓ | hot |
| gpt4_7ca326fa | 1 | ✓ | hot |
| gpt4_7bc6cf22 | 1 | ✓ | hot |
| 2ebe6c92 | 1 | ✗ | hot |
| gpt4_e061b84g | 1 | ✗ | hot |
| 71017277 | 1 | ✗ | hot |
| b46e15ee | 1 | ✓ | hot |
| gpt4_d6585ce9 | 1 | ✗ | hot |
| gpt4_1e4a8aec | 1 | ✗ | hot |
| gpt4_f420262d | 1 | ✗ | hot |
| gpt4_59149c78 | 1 | ✗ | hot |
| gpt4_e414231f | 1 | ✓ | hot |
| gpt4_4929293b | 1 | ✗ | hot |
| gpt4_468eb064 | 1 | ✓ | hot |
| gpt4_fa19884d | 1 | ✗ | hot |
| 9a707b82 | 1 | ✗ | hot |
| eac54add | 1 | ✗ | hot |
| 4dfccbf8 | 1 | ✗ | hot |
| 0bc8ad93 | 1 | ✗ | hot |
| 6e984302 | 1 | ✗ | hot |
| gpt4_8279ba03 | 1 | ✗ | hot |
| gpt4_b5700ca0 | 1 | ✗ | hot |
| gpt4_68e94288 | 1 | ✗ | hot |
| gpt4_2655b836 | 1 | ✓ | hot |
| gpt4_2487a7cb | 1 | ✗ | hot |
| gpt4_76048e76 | 1 | ✓ | hot |
| gpt4_2312f94c | 1 | ✓ | hot |
| 0bb5a684 | 1 | ✓ | hot |
| 08f4fc43 | 1 | ✓ | hot |
| 2c63a862 | 1 | ✗ | hot |
| gpt4_385a5000 | 1 | ✓ | hot |
| 2a1811e2 | 1 | ✗ | hot |
| bbf86515 | 1 | ✗ | hot |
| gpt4_5dcc0aab | 1 | ✗ | hot |
| gpt4_0b2f1d21 | 1 | ✗ | hot |
| f0853d11 | 1 | ✓ | hot |
| gpt4_6ed717ea | 1 | ✓ | hot |
| gpt4_70e84552 | 1 | ✓ | hot |
| a3838d2b | 1 | ✓ | hot |
| gpt4_93159ced | 1 | ✓ | hot |
| gpt4_2d58bcd6 | 1 | ✓ | hot |
| gpt4_65aabe59 | 1 | ✗ | hot |
| 982b5123 | 1 | ✓ | hot |
| b9cfe692 | 1 | ✓ | hot |
| gpt4_4edbafa2 | 1 | ✓ | hot |
| c8090214 | 1 | ✓ | hot |
| gpt4_483dd43c | 1 | ✓ | hot |
| e4e14d04 | 1 | ✓ | hot |
| c9f37c46 | 1 | ✓ | hot |
| gpt4_2c50253f | 1 | ✓ | hot |
| dcfa8644 | 1 | ✓ | hot |
| gpt4_b4a80587 | 1 | ✓ | hot |
| gpt4_9a159967 | 1 | ✓ | hot |
| cc6d1ec1 | 1 | ✓ | hot |
| gpt4_8c8961ae | 1 | ✗ | hot |
| gpt4_d9af6064 | 1 | ✓ | hot |
| gpt4_7de946e7 | 1 | ✓ | hot |
| d01c6aa8 | 1 | ✓ | hot |
| 993da5e2 | 1 | ✓ | hot |
| a3045048 | 1 | ✓ | hot |
| gpt4_d31cdae3 | 1 | ✓ | hot |
| gpt4_cd90e484 | 1 | ✓ | hot |
| gpt4_88806d6e | 1 | ✓ | hot |
| gpt4_4cd9eba1 | 1 | ✓ | hot |
| gpt4_93f6379c | 1 | ✓ | hot |
| b29f3365 | 1 | ✓ | hot |
| gpt4_2f56ae70 | 1 | ✗ | hot |
| 6613b389 | 1 | ✓ | hot |
| gpt4_78cf46a3 | 1 | ✓ | hot |
| gpt4_0a05b494 | 1 | ✓ | hot |
| gpt4_1a1dc16d | 1 | ✓ | hot |
| gpt4_2f584639 | 1 | ✗ | hot |
| gpt4_213fd887 | 1 | ✓ | hot |
| gpt4_5438fa52 | 1 | ✓ | hot |
| gpt4_c27434e8 | 1 | ✓ | hot |
| gpt4_fe651585 | 1 | ✓ | hot |
| 8c18457d | 1 | ✓ | hot |
| gpt4_70e84552_abs | 1 | ✓ | hot |
| gpt4_93159ced_abs | 1 | ✗ | hot |
| 982b5123_abs | 1 | ✗ | hot |
| c8090214_abs | 1 | ✗ | hot |
| gpt4_c27434e8_abs | 1 | ✓ | hot |
| gpt4_fe651585_abs | 1 | ✗ | hot |
| 6a1eabeb | 1 | ✓ | hot |
| 6aeb4375 | 1 | ✓ | hot |
| 830ce83f | 1 | ✗ | hot |
| 852ce960 | 1 | ✓ | hot |
| 945e3d21 | 1 | ✓ | hot |
| d7c942c3 | 1 | ✓ | hot |
| 71315a70 | 1 | ✓ | hot |
| 89941a93 | 1 | ✓ | hot |
| ce6d2d27 | 1 | ✓ | hot |
| 9ea5eabc | 1 | ✓ | hot |
| 07741c44 | 1 | ✓ | hot |
| a1eacc2a | 1 | ✓ | hot |
| 184da446 | 1 | ✓ | hot |
| 031748ae | 1 | ✓ | hot |
| 4d6b87c8 | 1 | ✓ | hot |
| 0f05491a | 1 | ✗ | hot |
| 08e075c7 | 1 | ✓ | hot |
| f9e8c073 | 1 | ✓ | hot |
| 41698283 | 1 | ✓ | hot |
| 2698e78f | 1 | ✓ | hot |
| b6019101 | 1 | ✓ | hot |
| 45dc21b6 | 1 | ✓ | hot |
| 5a4f22c0 | 1 | ✓ | hot |
| 6071bd76 | 1 | ✓ | hot |
| e493bb7c | 1 | ✓ | hot |
| 618f13b2 | 1 | ✓ | hot |
| 72e3ee87 | 1 | ✓ | hot |
| c4ea545c | 1 | ✗ | hot |
| 01493427 | 1 | ✓ | hot |
| 6a27ffc2 | 1 | ✓ | hot |
| 2133c1b5 | 1 | ✓ | hot |
| 18bc8abd | 1 | ✓ | hot |
| db467c8c | 1 | ✓ | hot |
| 7a87bd0c | 1 | ✓ | hot |
| e61a7584 | 1 | ✓ | hot |
| 1cea1afa | 1 | ✗ | hot |
| ed4ddc30 | 1 | ✓ | hot |
| 8fb83627 | 1 | ✓ | hot |
| b01defab | 1 | ✓ | hot |
| 22d2cb42 | 1 | ✗ | hot |
| 0e4e4c46 | 1 | ✓ | hot |
| 4b24c848 | 1 | ✓ | hot |
| 7e974930 | 1 | ✓ | hot |
| 603deb26 | 1 | ✓ | hot |
| 59524333 | 1 | ✓ | hot |
| 5831f84d | 1 | ✓ | hot |
| eace081b | 1 | ✓ | hot |
| affe2881 | 1 | ✓ | hot |
| 50635ada | 1 | ✓ | hot |
| e66b632c | 1 | ✓ | hot |
| 0ddfec37 | 1 | ✓ | hot |
| f685340e | 1 | ✗ | hot |
| cc5ded98 | 1 | ✓ | hot |
| dfde3500 | 1 | ✓ | hot |
| 69fee5aa | 1 | ✓ | hot |
| 7401057b | 1 | ✓ | hot |
| cf22b7bf | 1 | ✗ | hot |
| a2f3aa27 | 1 | ✓ | hot |
| c7dc5443 | 1 | ✓ | hot |
| 06db6396 | 1 | ✓ | hot |
| 3ba21379 | 1 | ✗ | hot |
| 9bbe84a2 | 1 | ✓ | hot |
| 10e09553 | 1 | ✗ | hot |
| dad224aa | 1 | ✗ | hot |
| ba61f0b9 | 1 | ✓ | hot |
| 42ec0761 | 1 | ✓ | hot |
| 5c40ec5b | 1 | ✓ | hot |
| c6853660 | 1 | ✓ | hot |
| 26bdc477 | 1 | ✓ | hot |
| 0977f2af | 1 | ✗ | hot |
| 6aeb4375_abs | 1 | ✗ | hot |
| 031748ae_abs | 1 | ✗ | hot |
| 2698e78f_abs | 1 | ✗ | hot |
| 2133c1b5_abs | 1 | ✗ | hot |
| 0ddfec37_abs | 1 | ✗ | hot |
| f685340e_abs | 1 | ✗ | hot |
| 89941a94 | 1 | ✓ | hot |
| 07741c45 | 1 | ✓ | hot |
| 7161e7e2 | 1 | ✓ | hot |
| c4f10528 | 1 | ✗ | hot |
| 89527b6b | 1 | ✗ | hot |
| e9327a54 | 1 | ✓ | hot |
| 4c36ccef | 1 | ✓ | hot |
| 6ae235be | 1 | ✓ | hot |
| 7e00a6cb | 1 | ✓ | hot |
| 1903aded | 1 | ✗ | hot |
| ceb54acb | 1 | ✓ | hot |
| f523d9fe | 1 | ✗ | hot |
| 0e5e2d1a | 1 | ✓ | hot |
| fea54f57 | 1 | ✗ | hot |
| cc539528 | 1 | ✗ | hot |
| dc439ea3 | 1 | ✗ | hot |
| 18dcd5a5 | 1 | ✓ | hot |
| 488d3006 | 1 | ✓ | hot |
| 58470ed2 | 1 | ✓ | hot |
| 8cf51dda | 1 | ✓ | hot |
| 1d4da289 | 1 | ✓ | hot |
| 8464fc84 | 1 | ✗ | hot |
| 8aef76bc | 1 | ✗ | hot |
| 71a3fd6b | 1 | ✓ | hot |
| 2bf43736 | 1 | ✓ | hot |
| 70b3e69b | 1 | ✗ | hot |
| 8752c811 | 1 | ✗ | hot |
| 3249768e | 1 | ✗ | hot |
| 1b9b7252 | 1 | ✓ | hot |
| 1568498a | 1 | ✗ | hot |
| 6222b6eb | 1 | ✓ | hot |
| e8a79c70 | 1 | ✗ | hot |
| d596882b | 1 | ✗ | hot |
| e3fc4d6e | 1 | ✗ | hot |
| 51b23612 | 1 | ✓ | hot |
| 3e321797 | 1 | ✗ | hot |
| e982271f | 1 | ✗ | hot |
| 352ab8bd | 1 | ✓ | hot |
| fca762bc | 1 | ✓ | hot |
| 7a8d0b71 | 1 | ✓ | hot |
| a40e080f | 1 | ✓ | hot |
| 8b9d4367 | 1 | ✓ | hot |
| 5809eb10 | 1 | ✗ | hot |
| 41275add | 1 | ✓ | hot |
| 4388e9dd | 1 | ✓ | hot |
| 4baee567 | 1 | ✗ | hot |
| 561fabcd | 1 | ✗ | hot |
| b759caee | 1 | ✓ | hot |
| ac031881 | 1 | ✓ | hot |
| 28bcfaac | 1 | ✓ | hot |
| 16c90bf4 | 1 | ✓ | hot |
| c8f1aeed | 1 | ✓ | hot |
| eaca4986 | 1 | ✗ | hot |
| c7cf7dfd | 1 | ✗ | hot |
| e48988bc | 1 | ✓ | hot |
| 1de5cff2 | 1 | ✗ | hot |
| 65240037 | 1 | ✗ | hot |
| 778164c6 | 1 | ✗ | hot |
