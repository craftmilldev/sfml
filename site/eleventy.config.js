import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import matter from "gray-matter";
import MarkdownIt from "markdown-it";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const envPath = path.join(repoRoot, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);
const contentDir = path.join(__dirname, "content");
const md = new MarkdownIt({ html: false });
// SPEC.md is the repo's own document, not site copy — rendered with the
// same `html: true` markdown-it default Eleventy's own `renderFile`
// shortcode used, since it relies on being able to embed raw HTML.
const specMd = new MarkdownIt({ html: true });

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export default function (eleventyConfig) {
  const posthogProjectToken = process.env.POSTHOG_PROJECT_TOKEN;
  const posthogHost = process.env.POSTHOG_HOST;

  if ((!posthogProjectToken || !posthogHost) && process.env.NODE_ENV !== "production") {
    const missingVariable = posthogProjectToken
      ? "POSTHOG_HOST"
      : "POSTHOG_PROJECT_TOKEN";
    throw new Error(
      `${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`,
    );
  }

  eleventyConfig.addGlobalData("posthog", () => {
    if (!posthogProjectToken || !posthogHost) {
      return null;
    }

    return {
      scriptSrc: `${posthogHost.replace(".i.posthog.com", "-assets.i.posthog.com")}/static/array.js`,
      config: JSON.stringify({
        projectToken: posthogProjectToken,
        apiHost: posthogHost,
      }),
    };
  });

  eleventyConfig.addPassthroughCopy("src/styles.css");
  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addWatchTarget("content/home");
  eleventyConfig.addWatchTarget("../.sfml/factory.sfml");
  eleventyConfig.addWatchTarget("../.sfml/factory.mmd");

  // Renders a copy file from src/content/ (Markdown with optional
  // `eyebrow` front matter) so page prose can be edited without touching
  // the templates.
  eleventyConfig.addShortcode("copy", (relativePath) => {
    const raw = readFileSync(path.join(contentDir, relativePath), "utf8");
    const { data, content } = matter(raw);
    const eyebrow = data.eyebrow
      ? `<div class="eyebrow">${escapeHtml(data.eyebrow)}</div>\n`
      : "";
    return eyebrow + md.render(content);
  });

  // Includes a repository file verbatim and HTML-escaped for display in a
  // <pre>/<code> block.
  eleventyConfig.addShortcode("sourceFile", (relativePath) => {
    const raw = readFileSync(path.join(repoRoot, relativePath), "utf8");
    return escapeHtml(raw).trimEnd();
  });

  // Renders the repo root's SPEC.md live at build time, so the spec page
  // always reflects the current spec — it is never copied into site/.
  eleventyConfig.addShortcode("specDoc", () => {
    const raw = readFileSync(path.join(repoRoot, "SPEC.md"), "utf8");
    return specMd.render(raw);
  });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
    },
  };
}
