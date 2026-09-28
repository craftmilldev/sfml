---
eyebrow: How to use it
---

SFML ships with an <a href="https://github.com/craftmilldev/sfml/tree/main/example" data-posthog-event="github_repository_visited" data-posthog-link-location="example_implementation">example implementation</a> you can use to lint and run a factory. Clone the repository, then install and build the CLI:

```sh
git clone https://github.com/craftmilldev/sfml.git
cd sfml
npm install --prefix example
npm run build --prefix example
```

From the repository root, lint the included factory, then run it with a GitHub ticket URL. Replace the sample URL with the issue or PR you want to process:

```sh
node example/dist/cli/sfml.js lint .sfml/factory.sfml
node example/dist/cli/sfml.js run .sfml/factory.sfml \
  --param ticket_url=https://github.com/craftmilldev/sfml/issues/13 \
  --state .sfml/runs/first-run.json
```

`lint` checks the factory without running it. `run` uses the Claude Agent SDK and saves progress to the state file, so you can resume if the factory pauses. See the <a href="https://github.com/craftmilldev/sfml/tree/main/example#cli" data-posthog-event="github_repository_visited" data-posthog-link-location="example_runner">example runner CLI guide</a> for the `resume` command and other options.

The CLI is a reference implementation, not a polished developer tool. You can build your own SFML Runner using the conformance tests in this repository. If you do, we welcome a PR linking to it.
