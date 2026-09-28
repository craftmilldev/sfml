# SFML site (sfml.craftmill.dev)

The promo/docs site for SFML: a home page explaining what SFML is and how to use it, `SPEC.md`
rendered as HTML at `/spec/`, and `/llms.txt` for LLMs reading this project.

Built with [Eleventy](https://www.11ty.dev/) 3, matching the look of
[craftmill.dev](https://github.com/craftmilldev/craftmill.dev) (paper/ink colors, Sorts Mill
Goudy + Courier Prime type) without sharing code with that repo.

## Build / run

```sh
npm install --prefix site
npm run build --prefix site   # -> site/_site/
npm run start --prefix site   # local dev server with live reload
```

`site/src/spec.njk` renders the repo root's `SPEC.md` directly at build time (via the `specDoc`
shortcode, `eleventy.config.js`), so the page always reflects the current spec — it is read
live from the repo root and never duplicated into `site/`.

The home page's copy lives in `site/content/home/*.md` (one file per section, with an
`eyebrow` front-matter field for the small label above each heading), not in `index.njk` —
edit those files to change the wording. `index.njk` pulls each one in with the `copy`
shortcode (`eleventy.config.js`). The example factory's YAML and Mermaid diagram source live
alongside them as plain `.sfml`/`.mmd` files and are pulled in verbatim with the `sourceFile`
shortcode. `site/content/` sits outside Eleventy's `src/` input root so none of it gets built
as its own page.

The root `npm test` builds this site (`npm run build:site`) and checks the built output for
the ticket's required content (`npm run check:site`), the same way it runs `example/`'s own
suite via `npm run test:example`.

## Deployment

The site builds to a plain static folder (`site/_site/`) with an auto-detectable framework, so
Vercel can build it with zero extra config — same as craftmill.dev itself (no `vercel.json`).
Wiring up the actual Vercel project and `sfml.craftmill.dev` DNS is a manual infra step, done
outside this repo.
