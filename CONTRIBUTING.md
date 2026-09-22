# Contributing to SFML

Thanks for your interest in the SFML specification.

## Setup

Node.js 24 or above, and npm.

```bash
nvm install   # reads .nvmrc
npm install
```

## Commands

| Command                   | What it does                                               |
| ------------------------- | ---------------------------------------------------------- |
| `npm run check:schema:ts` | Typecheck, lint, and format-check the schema and scripts   |
| `npm run generate`        | Regenerate `schema.json` and `schema.mdx`                  |
| `npm run format`          | Format the schema, scripts, and markdown                   |
| `npm run prep`            | Check, generate, and format in one go. Run before pushing. |
| `npm run check`           | What CI runs. Fails if generated files are stale.          |
| `npm run serve:docs`      | Preview the docs site locally                              |

## Schema changes

Schema changes go in `schema/draft/schema.ts`. To validate them:

```bash
npm run check:schema:ts
```

`schema/draft/schema.json` and `docs/specification/draft/schema.mdx` are generated from `schema.ts`;
do not edit them directly. To regenerate:

```bash
npm run generate
```

Commit the regenerated files in the same commit as the `schema.ts` change. `npm run check` — what CI
runs on every pull request — fails if they are out of date.

### Conflicts in generated files

Do not resolve them by hand. Merge `main`, resolve the conflict in `schema.ts`, then regenerate and
commit:

```bash
git merge main
npm run generate
git add .
git commit
```

## Documentation changes

The docs are MDX in `docs/`. Preview them with:

```bash
npm run serve:docs
```

And check them with:

```bash
npm run check:docs
npm run format
```

When adding a page, add it to the navigation in `docs/docs.json` and follow the existing
`kebab-case.mdx` naming.

> [!NOTE] `npm run prep` runs the schema check, regenerates everything, and formats, in one command.
> Run it before pushing.

## Proposing a change to the format

Substantive changes — new fields, new step types, changed semantics — go through a proposal in
`proposals/`. See [`proposals/README.md`](./proposals/README.md).

The shortest summary: explore the problem and check that others share it, build a prototype, then
write the proposal based on what the prototype taught you.

Typos, clarifications, and wording fixes need no proposal.

## Submitting changes

1. Fork the repository and create a branch
2. Run `npm run prep`, then `npm run check`
3. Open a pull request describing what changed and why

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](./LICENSE).
