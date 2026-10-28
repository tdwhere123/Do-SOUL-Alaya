# LongMemEval clean confirmation and development cohorts

The official `longmemeval_s` dataset pin is
`d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442`.
The held-out cohort has 100 questions; Dev2 contains the other 288 eligible questions.
The two sets are disjoint and together exhaust the 388 eligible questions.

Eligibility excludes Original100 and the ten previously reused questions recorded in
`root-start-20261026/confirmation-ids.json`. It also excludes any remaining question
whose gold session ID occurs in any haystack belonging to those 110 exposed questions.
Selection uses only question IDs, types, the maintained abstention classifier and
session IDs. It uses no question, answer or source text, model output or ranking.

The held-out joint quotas equal Original100 exactly. For each joint stratum, call
`createStratifiedQuestionManifest` from
`apps/bench-runner/src/runs/selection/question-manifest.ts` on the eligible members,
with the Original100 quota as `targetCount`. Union the selected IDs in official dataset
order. This is a fixed-quota composition of the maintained sampler, rather than a
new Hamilton allocation against the eligible population. Dev2 is its complement.
Both manifests use the maintained manifest schema, ID digest and validation.

The recorded seed is the dataset SHA-256 above. The maintained sampler places that
value directly into its deterministic within-stratum rank preimage; no additional
random-number generator or seed transform is used. Answerability comes from
`apps/bench-runner/src/runs/selection/dataset-cohort.ts` and affects sampling only.

Freeze and commit these ID manifests before selecting any candidate. Held-out use is
one confirmation after candidate selection. Until that run, do not inspect its answers
or haystack, prepare its native index, query it or evaluate it. Preapproved Q formation
may consume only question/date; inspect the resulting held-out Q only for schema and
formation counts, leaving its text unread until confirmation.
