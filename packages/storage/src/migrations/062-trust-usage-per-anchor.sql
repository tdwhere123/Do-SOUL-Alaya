ALTER TABLE trust_usage_proof
ADD COLUMN per_anchor_usage_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(per_anchor_usage_json));
