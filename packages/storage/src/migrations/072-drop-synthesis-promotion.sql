-- invariant: drop synthesis-capsule promotion ladder; soul.resolve.confirm
-- is the activation path from draft claim to active; soul.resolve.defer
-- writes a DeferredObligation that subsumes the cooldown_until field.
-- see also: packages/core/src/resolution-service.ts

DROP INDEX IF EXISTS idx_synthesis_capsules_promotion_state;

ALTER TABLE synthesis_capsules DROP COLUMN promotion_state;
ALTER TABLE synthesis_capsules DROP COLUMN authority_round_count;
ALTER TABLE synthesis_capsules DROP COLUMN cooldown_until;
