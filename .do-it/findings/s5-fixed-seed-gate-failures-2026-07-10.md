# S5 Fixed-Seed Gate Failures — 2026-07-10

Truth plane: `/home/tdwhere/vibe/Do-SOUL-Alaya/.worktrees/recall-root-cause-levers-2026-07-06`

Run: `s5-fixed-100q-20260710T0957Z`

- Seed completed `100/100`; embedding completion persistence warnings: `0`.
- Snapshot DB SHA-256: `b1943ec6d935ee1eddc13b716b67391454435d9686507766fe64c08f24116a00`.
- Sidecar SHA-256: `4391af19f720af80b14e862e6cbfa72f98b2c115f840eca416bfd299bc7b0246`.
- Question count/digest: `100` / `92745588c5e142b01422fcf8260a26441d2233ff636ea4fc6d0658f290b0f446`.
- Gate bundle SHA-256 recorded by the snapshot: `1d7b40cb961f701033a6b7e3b1c9135d586617e3981c7ac23c8ea4076394d9f2`.
- Failure 1: lifecycle helper line 214 expanded `$snapshot` inside the same `local` declaration under `set -u`, aborting before A/A.
- Failure 2: snapshot attribution was `attributed` but `gate_eligible=false`; cache eligibility compared the dataset content SHA to the opaque cache revision label `unpinned`.
- Disposition: no A/A or B ran. The DB and sidecar are invalid for a repaired gate SHA and were deleted after their hashes and manifest were preserved. The run must restart from a fresh root.

The manifest, driver log, seed log, and failed-run marker remain as compact evidence. This run is not KPI or release evidence.
