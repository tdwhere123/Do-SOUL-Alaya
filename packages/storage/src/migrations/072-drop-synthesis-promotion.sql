-- v0.3.9 Cat-H.2: SynthesisCapsule promotion lifecycle is retired. The
-- three columns were producer-only with no live trigger; the
-- corresponding service methods (incrementAuthorityRound,
-- updatePromotionState, setCooldownUntil) and the requestPromotion /
-- resolvePromotionDecision wrappers are removed in the same release.
-- Active promotion now travels the soul.resolve typed-resolution path
-- or the Proposal/HITL review path.

DROP INDEX IF EXISTS idx_synthesis_capsules_promotion_state;

ALTER TABLE synthesis_capsules DROP COLUMN authority_round_count;
ALTER TABLE synthesis_capsules DROP COLUMN cooldown_until;
ALTER TABLE synthesis_capsules DROP COLUMN promotion_state;
