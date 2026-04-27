# Source Map

Runtime rule: adapters call `src/runtime`; they do not talk to storage directly.

- `contracts/`: exported data contracts and validation.
- `storage/`: SQLite schema and repository operations.
- `runtime/`: public API implementation and memory semantics.
- `server/`: HTTP routes and inspector serving.
- `cli/`: local command surface.
- `mcp/`: stdio JSON-RPC adapter.
- `inspector/`: static graph-first inspector assets.
- `bench/`: deterministic benchmark harness.
- `__tests__/`: contract, storage, runtime, adapter, standalone, inspector, and benchmark tests.
