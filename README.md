# SFML — Software Factory Markup Language

A file format for describing a _software factory_: a durable, resumable, mostly-autonomous pipeline that turns an intent into a reviewed artifact.

The bet is that the factory graph will be defined in code and having a shared format for that will be good for the industry. A declarative graph can be diffed in a PR, validated before it runs, dry-run without spending tokens, and moved between runtimes.

| Document           | What it is                                                     |
| ------------------ | -------------------------------------------------------------- |
| [PRD.md](PRD.md)   | What SFML must do and what has been decided.    |
| [SPEC.md](SPEC.md) | The specification. |
| [conformance/](conformance/README.md) | The conformance suite (Annex B) and its file formats. |
| [conformance/mock-harness.md](conformance/mock-harness.md) | The `mock` harness contract: async API, sessions, events, and pricing. |

## Status

Pre-draft. Nothing here is stable.

## License

MIT — see [LICENSE](LICENSE).

Specification text is expected to move to the
[Community Specification License 1.0](https://github.com/CommunitySpecification/1.0) if this project gain traction.
