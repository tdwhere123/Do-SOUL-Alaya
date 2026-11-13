-- Pending metadata is scrubbed alongside bodies. The immutable digest supports exact replay after closure/erase.
ALTER TABLE host_session_messages ADD COLUMN semantic_dependencies_json TEXT;
ALTER TABLE host_session_messages ADD COLUMN semantic_dependencies_digest TEXT;
