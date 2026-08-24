# Completion checklist

- Run the focused affected test(s) first.
- Run `npm test`.
- Run `node build.mjs`.
- Run targeted Prettier check if source/test files changed.
- Inspect `git diff --check` and `git status --short --branch`.
- For spawn changes, verify the generated userscript still contains the spawn module and the final build marker.
