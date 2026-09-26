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

`site/src/spec.njk` renders the repo root's `SPEC.md` directly at build time (via Eleventy's
`renderFile` shortcode), so the page always reflects the current spec — it is not duplicated
into `site/`.

This site's build is independent of the root `npm test` (same pattern as `example/`'s own
`npm test`, invoked separately via `npm run test:example`).

## Deployment

The site builds to a plain static folder (`site/_site/`) with an auto-detectable framework, so
Vercel can build it with zero extra config — same as craftmill.dev itself (no `vercel.json`).
Wiring up the actual Vercel project and `sfml.craftmill.dev` DNS is a manual infra step, done
outside this repo.
