# Conventions

- Keep engine modules browser-safe and defensive against partially initialized game state, especially during lobby/spawn phase.
- Expose testable helpers through the module's agreed global API when a file is loaded in a VM sandbox.
- Preserve existing feature ordering in `build.mjs`; source order can affect globals.
- Add focused regression tests beside the affected feature and keep calculations finite/deterministic for sparse game snapshots.
- Use `apply_patch` for line-level edits and preserve unrelated worktree changes.
