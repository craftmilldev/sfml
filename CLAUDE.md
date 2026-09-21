# Working in this repository

This repo holds the SFML (Software Factory Markup Language) specification: a file format for
describing a durable, resumable agent pipeline. See [`PRD.md`](./PRD.md) for the frozen v0.1 scope
and the reasoning behind it, and [`README.md`](./README.md) for the layout.

## The one rule that matters

**`schema/draft/schema.ts` is the source of truth.** These files are generated from it and must
never be edited by hand:

- `schema/draft/schema.json`
- `docs/specification/draft/schema.mdx`

The loop is: **edit `schema.ts` → `npm run generate` → commit the generated files in the same
commit.** If you find yourself editing generated output to fix something, the fix belongs in
`schema.ts` or in `scripts/`.

## Before handing work back

```bash
npm run prep    # check:schema:ts, generate, format, check:docs
npm run check   # exactly what CI runs
```

`npm run check` fails when generated files are out of date with `schema.ts`, so a green `check` is
the signal that the tree is committable.

## Conventions

- **JSDoc every exported type and every property.** The JSDoc is the specification text for that
  field — it becomes both the JSON Schema `description` and the published reference page. Write it
  for a reader who has not read the PRD.
- **Field names are `snake_case`**, matching the on-disk factory format (`result_schema`,
  `prompt_vars`, `max_iterations`). Type names are `PascalCase`.
- **JSON Schema constraints go in tags**, not prose: `@TJS-type integer`, `@minimum`. They are
  declared in `typedoc.config.mjs` so TypeDoc strips them from the rendered page instead of warning
  about them.
- **`typescript` is pinned to 6.x** because TypeDoc 0.28 does not accept 7.x. Do not bump it past 6
  without checking `typedoc`'s peer range first.
- Specification prose uses RFC 2119 keywords in all capitals, and only there. See
  `docs/specification/draft/terminology.mdx`.

## Changing the format

Substantive changes go through `proposals/`: copy `TEMPLATE.md`, fill in every section, open a PR. A
validation rule without a decision procedure a linter can run is a comment, and should be written as
one.

Do not port MCP's content, license text, or SEP process into this repo. The tooling shape is
borrowed; the specification is its own.
