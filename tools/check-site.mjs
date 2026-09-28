// Guards the built site/_site/ output against silently dropping the ticket's required
// elements (craftmilldev/sfml#22): the home page's links/framing, the spec page's rendered
// tables, and llms.txt being reachable as plain Markdown with no .html extension. A build
// that still succeeds but loses one of these should fail CI instead of shipping quietly.

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
check('index.html links to "/llms.txt"', /href="\/llms\.txt"/.test(index));
check(
  "index.html identifies the example implementation",
  /example implementation/i.test(index),
);

const spec = read("spec/index.html");
check("spec/index.html contains rendered <table> markup", /<table/i.test(spec));

// existsSync above already confirms no .html suffix is needed to reach it (the path literally
// asks for "llms.txt"); this just confirms the served bytes are Markdown, not an HTML wrapper.
const llmsTxt = read("llms.txt");
check("llms.txt is plain Markdown, not HTML", !/<html/i.test(llmsTxt) && llmsTxt.trimStart().startsWith("#"));

if (failures.length) {
  console.error("site content check failed:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log("site content check passed");
