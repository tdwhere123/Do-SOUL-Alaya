# Post-Port Hygiene Briefs

This directory tracks the dedicated v0.1.x post-port hygiene wave that
executed the `#BL-017` cleanup after Gate-5.

## Scope

The wave is mechanical cleanup only:

- rename misleading `packages/protocol/src/events/phase-*.ts` files,
  exported symbols, parser helpers, protocol tests, and downstream
  imports to domain-aligned names;
- split current production TypeScript files over 800 lines;
- add a reproducible unused-code check through `knip`;
- refresh docs and code-map truth after verification.

No persisted event string value, SQLite schema, MCP contract, CLI
wire contract, or durable EventLog data changes in this wave.

## Cards

| Card | Title | Status | Report |
|---|---|---|---|
| POSTV01-hygiene-wave | Post-v0.1 hygiene wave | implementation-ready | [report](./reports/post-port-hygiene-closeout.md) |
