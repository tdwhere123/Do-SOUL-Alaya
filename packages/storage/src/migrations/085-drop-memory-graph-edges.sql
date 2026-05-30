-- memory_graph_edges is retired. The unified memory graph lives on the
-- path_relations plane; every reader/writer (recall graph_expansion,
-- graph_support, explore_graph, graph-health, librarian, accept->path mint)
-- was repointed to path_relations. This table has no live writer or reader.
-- Its foreign keys point FROM this table TO workspaces/memory_entries, and its
-- indexes are scoped to it, so both vanish with the DROP. No other table
-- references it.

DROP INDEX IF EXISTS idx_memory_graph_edges_source;
DROP INDEX IF EXISTS idx_memory_graph_edges_target;
DROP INDEX IF EXISTS idx_memory_graph_edges_workspace;

DROP TABLE IF EXISTS memory_graph_edges;
