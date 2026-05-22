ALTER TABLE trust_usage_proof
ADD COLUMN trust_mode TEXT CHECK (trust_mode IN ('manual', 'automatic'));
