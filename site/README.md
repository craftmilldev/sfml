# SFML site (sfml.craftmill.dev)

The promo/docs site for SFML: a home page explaining what SFML is and how to use it, and
`SPEC.md` rendered as HTML at `/spec/`.

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
shortcode (`eleventy.config.js`). The factory and Mermaid diagram are read directly from
`.sfml/factory.sfml` and `.sfml/factory.mmd` at the repo root through the `sourceFile`
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

## Analytics

The site sends PostHog events through `@craftmilldev/analytics`, Craftmill's shared package, and the
shared proxy at `https://a.craftmill.dev/api/ingest`. Every event carries `product = sfml` and
`app = web`. `build-analytics.mjs` bundles `src/analytics.js` into `_site/analytics.js`, and
`base.njk` loads it only when `POSTHOG_PROJECT_TOKEN` is set at build time (in `.env` or the
environment). `POSTHOG_PROXY_HOST` overrides the proxy URL. The proxy must list the site's origin in
its `ALLOWED_ORIGINS`.

The package is private on GitHub Packages, so `npm ci` in `site/` needs a token with `read:packages`
in `NODE_AUTH_TOKEN` (`site/.npmrc` points the `@craftmilldev` scope at the registry):

- Locally: `export NODE_AUTH_TOKEN=$(gh auth token)`.
- CI: the workflow passes `secrets.GITHUB_TOKEN`; the package must grant this repo access. Pull
  requests from forks get no secrets, so their install fails.
- The deploy: set `NODE_AUTH_TOKEN` (a token with `read:packages`) as a build environment variable.
