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

## The workflow

**Edit `schema/draft/schema.ts` → run `npm run generate` → commit the generated files alongside
it.**

`schema/draft/schema.json` and `docs/specification/draft/schema.mdx` are generated. Editing them by
hand is always wrong: the next `npm run generate` discards the edit, and `npm run check` fails in CI
until it does.

[`CONTRIBUTING.md`](./CONTRIBUTING.md) has the setup steps, the full command reference, and what to
do when a generated file conflicts. Substantive changes to the format go through a proposal —
[`proposals/README.md`](./proposals/README.md).

## Status

Draft, and not yet stable. The v0.1 scope is frozen in [`PRD.md`](./PRD.md); this repository is
where that scope becomes normative RFC 2119 text with a JSON Schema beside it.

## License

[MIT](./LICENSE).
