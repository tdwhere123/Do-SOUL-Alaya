# LongMemEval-S Question-Type Stratification — 2026-07-10

## Dataset Truth

- Dataset owner file: main checkout ignored data cache at
  `docs/bench-history/data/longmemeval/longmemeval_s.json`
- Dataset SHA-256: `d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`
- Rows: 500; `question_id` is unique/non-empty; contract category is `question_type`.
- Abstention subtype: 30 IDs ending `_abs`.

| question_type | 500Q count | stratified 100Q quota |
| --- | ---: | ---: |
| multi-session | 133 | 27 |
| temporal-reasoning | 133 | 26 |
| knowledge-update | 78 | 16 |
| single-session-user | 70 | 14 |
| single-session-assistant | 56 | 11 |
| single-session-preference | 30 | 6 |

The existing first-100 prefix is not representative: it contains 70
`single-session-user`, 30 `multi-session`, and zero questions from the other
four types.

## Selection Contract

Use a versioned manifest bound to dataset SHA, variant, algorithm version,
target count, ordered question IDs, joint `(question_type, abstention-status)`
quotas, and a selected-ID digest. Allocate with Hamilton proportional quotas and
bytewise tie-breaks; rank within a stratum by SHA-256 of dataset SHA, algorithm
version, stratum, and question ID; preserve dataset order after membership is
chosen. The 100Q set contains exactly six abstention questions.

## Evidence Policy

- Control and treatment must use the same manifest and report question-ID paired gained/lost/net counts.
- Report overall any@5 plus `hits/N` for every question type.
- Small categories, especially preference `N=6`, are diagnostic slices rather than independent hard release floors.
- Existing valid 500Q artifacts can be split by joining their per-scenario
  question IDs to this dataset; no object-ID rematerialization or rerun is needed.
- Full 500Q remains the final post-review release gate, not a pre-implementation baseline.
