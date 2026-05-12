# Host Autonomy Fixtures

This directory is reserved for real Codex or Claude Code host-autonomy
recordings for `v0.3.0-slice-4`.

No synthetic transcript may satisfy `#BL-038`. A valid fixture must be a
directory named `<host>-<version>/` and must contain:

- `metadata.json`: host name, exact CLI version, capture timestamp,
  workspace/config paths, prompt, and capture operator.
- `operator-instructions.md`: the attach-written instructions presented to the
  host.
- `transcript.jsonl`: recorded MCP stdio transcript from the host session.
- `event-log.jsonl`: preserved `soul.recall.delivered` and
  `soul.context_usage.reported` EventLog rows for the same delivery.
- `seed/` or `seed.md`: either the pre-seeded daemon state or exact commands to
  recreate it in an isolated config directory.

Minimum proof for a fixture:

- fresh install and fresh attach in an isolated config directory;
- real MCP stdio session driven by Codex or Claude Code, not an SDK or test
  harness;
- at least one non-empty `soul.recall.delivered` row;
- at least one matching `soul.context_usage.reported` row with
  `usage_state == "used"`;
- transcript metadata sufficient to replay the daemon contract offline.
