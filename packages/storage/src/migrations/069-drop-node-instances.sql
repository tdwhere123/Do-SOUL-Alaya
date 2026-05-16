-- v0.3.9 Cat-H.1: NodeInstance abstraction retired. The runtime engine
-- uses a single-instance model and the table had no live writer. The
-- repo, schema export, and zod contract are removed in the same release.

DROP TABLE IF EXISTS node_instances;
