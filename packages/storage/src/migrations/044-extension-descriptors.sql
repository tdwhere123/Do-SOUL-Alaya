CREATE TABLE extension_descriptors (
  descriptor_id   TEXT PRIMARY KEY,
  descriptor_type TEXT NOT NULL,
  name            TEXT NOT NULL,
  source          TEXT NOT NULL,
  metadata_json   TEXT NOT NULL,
  registered_at   TEXT NOT NULL
);

CREATE INDEX idx_ext_descriptors_type ON extension_descriptors(descriptor_type);
CREATE INDEX idx_ext_descriptors_source ON extension_descriptors(source);
