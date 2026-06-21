# v0.3.1 Release Notes

v0.3.1 is a patch release for recall maintainability and verification
discipline. It does not change MCP tool names, MCP request/response
schemas, EventLog payload schemas, runtime config schemas, or storage
migrations.

## Changed

- Extracted recall candidate construction, source-channel shaping,
  selection reasons, additive budget checks, and delivery-budget rebuilds
  into `packages/core/src/recall-candidate-builder.ts`.
- Routed storage keyword search through one private row-search path so
  exact short-token matching, trigram FTS, filtered object-id searches,
  and row merge ranking stay aligned.
- Split MCP `soul.recall` result shaping into
  `apps/core-daemon/src/mcp-memory-recall-result.ts` while preserving the
  handler call order and response shape.
- Registered the host-autonomy witness export script as a package script
  and declared its direct SQLite dependency so the unused-file hygiene
  gate is meaningful.
- Added the v0.3.2 planning track for read/write integrated memory
  quality work without shipping v0.3.2 runtime behavior in this patch.

## Verification

See `reports/v0.3.1-closeout.md` for command evidence and review
findings.
