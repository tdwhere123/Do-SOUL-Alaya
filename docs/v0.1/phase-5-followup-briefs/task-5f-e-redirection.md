# 5F-E — Direction-Bias Redirection and Live Proof

## Backlog

Closes `#BL-029`.

## Allowed Scope

- Add a source-vs-target usage signal for path plasticity.
- Add the path redirection event contract and live consumer.
- Wire recall-side direction-bias handling.
- Prove the full loop live after the integrated path foundation lands.

## Deferred

No additional plasticity features are opened by this card.

## Acceptance

- `direction_bias` can change through a durable path relation mutation.
- Recall respects the new direction bias.
- Final live proof exercises:
  `soul.recall -> soul.report_context_usage -> Garden pass ->
  PathRelation mutation -> later soul.recall`.

## Verification

```bash
rtk pnpm exec vitest run --project @do-soul/alaya-protocol -- runtime-governance path-relation
rtk pnpm exec vitest run --project @do-soul/alaya-core -- path-plasticity recall
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- path-plasticity-integration
```
