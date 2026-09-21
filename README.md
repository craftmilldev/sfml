# SFML

**Software Factory Markup Language** — a file format for describing a software factory: a durable,
resumable, mostly-autonomous pipeline that turns an intent ("implement this issue") into a reviewed
artifact.

The bet: the factory graph is worth separating from the agent runtime. A factory written as a
declarative file can be diffed in a pull request, validated before it runs, dry-run without spending
tokens, and moved between runtimes.

This repository holds the specification, the schema, and the docs site.

| Path                                  | What it is                                                  |
| ------------------------------------- | ----------------------------------------------------------- |
| `schema/draft/schema.ts`              | **Source of truth.** TypeScript definitions with JSDoc.     |
| `schema/draft/schema.json`            | Generated JSON Schema. Do not edit.                         |
| `docs/specification/draft/`           | The specification: overview, terminology, schema reference. |
| `docs/specification/draft/schema.mdx` | Generated reference page. Do not edit.                      |
| `docs/docs.json`                      | Mintlify site configuration and navigation.                 |
| `proposals/`                          | Change proposals and their template.                        |
| `scripts/`                            | The generators behind `npm run generate`.                   |
| `PRD.md`                              | The v0.1 product requirements this spec is drafted from.    |

## Getting started

```bash
nvm install   # Node 24, per .nvmrc
npm install
```

## The workflow

**Edit `schema/draft/schema.ts` → run `npm run generate` → commit the generated files alongside
it.**

`schema/draft/schema.json` and `docs/specification/draft/schema.mdx` are generated. Editing them by
hand is always wrong: the next `npm run generate` discards the edit, and `npm run check` fails in CI
until it does.

```bash
npm run check:schema:ts   # typecheck, lint, and format-check the schema
npm run generate          # regenerate schema.json and schema.mdx
npm run prep              # check, generate, and format in one go
npm run check             # what CI runs; fails if generated files are stale
npm run serve:docs        # preview the docs site locally
```

A pull request that changes `schema.ts` without regenerating fails `check:schema:json` or
`check:schema:md`. Run `npm run prep` before pushing and that does not happen.

### Resolving conflicts in generated files

Do not resolve them by hand. Merge `main`, fix the conflict in `schema.ts`, then regenerate:

```bash
git merge main
npm run generate
git add .
git commit
```

## Changing the specification

Substantive changes go through a proposal: copy `proposals/TEMPLATE.md`, fill in every section, and
open a pull request. See [`proposals/README.md`](./proposals/README.md) for what makes one likely to
land — the short version is that a proposal argues from a prototype, and ships a decision procedure
with every validation rule it adds.

Typos, clarifications, and wording fixes need no proposal. Open the pull request.

## Status

Draft, and not yet stable. The v0.1 scope is frozen in [`PRD.md`](./PRD.md); this repository is
where that scope becomes normative RFC 2119 text with a JSON Schema beside it.

## License

[MIT](./LICENSE).
