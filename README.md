# SFML — Software Factory Markup Language

A file format for describing a _software factory_: a durable, resumable, mostly-autonomous pipeline that turns an intent into a reviewed artifact.

The bet is that the factory graph will be defined in code and having a shared format for that will be good for the industry. A declarative graph can be diffed in a PR, validated before it runs, dry-run without spending tokens, and moved between runtimes.

| Document           | What it is                                                     |
| ------------------ | -------------------------------------------------------------- |
| [SPEC.md](SPEC.md) | The specification. |
| [sfml.schema.json](sfml.schema.json) | JSON Schema (2020-12) for a factory document's surface syntax (SPEC Annex A). |
| [conformance/](conformance/README.md) | The conformance suite (Annex B) and its file formats. |
| [conformance/mock-harness.md](conformance/mock-harness.md) | The `mock` harness: the transcript format runner tests play back, sessions, and pricing. |
| [site/](site/README.md) | The promo/docs site (`sfml.craftmill.dev`): home page and rendered spec. |

## Validating a factory

`sfml.schema.json` catches structural mistakes; the graph checks of SPEC clause 8 still need a
Linter. To check a factory file against the schema:

```sh
npm install
node tools/validate-schema.mjs path/to/factory.sfml
```

`npm run validate:schema` runs the schema against the conformance suite's `conformance/parser/`
fixtures.

## Tests

```sh
npm install && npm install --prefix example && npm install --prefix site
npm test
```

`npm test` validates the schema fixtures and the conformance suite, then runs the example's
harness tests, then builds `site/` and checks its output. It also runs the `tools/` tests,
which check that `.sfml/factory.mmd` (a Mermaid rendering of `.sfml/factory.sfml`, made by
`tools/sfml-to-mermaid.mjs`) is up to date. After editing the factory, run
`npm run render:mermaid`. CI runs `npm test` on every push to `main` and on every pull request.

The repo's own factory lives in `.sfml/` (`factory.sfml`, `factory.mmd`, `prompts/`); run state
in `.sfml/runs/` and plan files (`.sfml/plan*.md`) are git-ignored.

## Status

Pre-draft. Nothing here is stable.

## License

MIT — see [LICENSE](LICENSE).

Specification text is expected to move to the
[Community Specification License 1.0](https://github.com/CommunitySpecification/1.0) if this project gain traction.
