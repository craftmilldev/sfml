// Guards the built site/_site/ output against silently dropping the home page's
// links/framing or the spec page's rendered tables. A build that still succeeds
// but loses one of these should fail CI instead of shipping quietly.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const site = join(root, "site", "_site");

const read = (rel) => {
  const p = join(site, rel);
  if (!existsSync(p)) throw new Error(`missing ${rel} (did you run \`npm run build:site\` first?)`);
  return readFileSync(p, "utf8");
};

const failures = [];
const check = (label, ok) => {
  if (!ok) failures.push(label);
};

const index = read("index.html");
check('index.html links to "/spec/"', /href="\/spec\/?"/.test(index));
check('index.html has no link to "/llms.txt"', !/href="\/llms\.txt"/.test(index));
check(
  "index.html identifies the example implementation",
  /example implementation/i.test(index),
);
for (const [label, location, urlSuffix] of [
  ["example implementation", "example_implementation", ""],
  ["example runner CLI guide", "example_runner", "#cli"],
]) {
  const link = new RegExp(
    `<a\\b(?=[^>]*href="https://github\\.com/craftmilldev/sfml/tree/main/example${urlSuffix}")` +
      `(?=[^>]*data-posthog-event="github_repository_visited")` +
      `(?=[^>]*data-posthog-link-location="${location}")[^>]*>${label}<\\/a>`,
  );
  check(`index.html renders tracked ${label} link`, link.test(index));
}
check("how-to-use section appears before example", index.indexOf('class="hero how-to-use"') < index.indexOf('class="hero example"'));
check("how-to-use section shows CLI install command", /npm install --prefix example/.test(index));
check("how-to-use section shows CLI lint command", /node example\/dist\/cli\/sfml\.js lint \.sfml\/factory\.sfml/.test(index));
check("how-to-use section shows CLI run command", /node example\/dist\/cli\/sfml\.js run \.sfml\/factory\.sfml/.test(index));

const spec = read("spec/index.html");
check("spec/index.html contains rendered <table> markup", /<table/i.test(spec));

check("llms.txt is not generated", !existsSync(join(site, "llms.txt")));

if (failures.length) {
  console.error("site content check failed:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("site content check passed");
