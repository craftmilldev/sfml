import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import matter from "gray-matter";
import MarkdownIt from "markdown-it";
import { RenderPlugin } from "@11ty/eleventy";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const contentDir = path.join(__dirname, "content");
const md = new MarkdownIt({ html: false });

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export default function (eleventyConfig) {
  eleventyConfig.addPlugin(RenderPlugin);

  eleventyConfig.addPassthroughCopy("src/styles.css");
  eleventyConfig.addPassthroughCopy("src/assets");

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

  // Includes a source file (code sample, Mermaid diagram, ...) from
  // src/content/ verbatim and HTML-escaped, for display in a <pre>/<code>
  // block.
  eleventyConfig.addShortcode("sourceFile", (relativePath) => {
    const raw = readFileSync(path.join(contentDir, relativePath), "utf8");
    return escapeHtml(raw).trimEnd();
  });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
    },
  };
}
