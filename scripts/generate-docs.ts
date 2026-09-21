#!/usr/bin/env tsx

/**
 * Generates `docs/specification/<version>/schema.mdx` from
 * `schema/<version>/schema.ts` using TypeDoc.
 *
 * With `--check`, regenerates into a temporary directory and fails if what is
 * committed differs, so a PR that edits schema.ts without regenerating cannot
 * merge.
 */

import { exec } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** Every schema version in the repo. New versions are added here. */
const ALL_SCHEMAS = ["draft"];

const CHECK_MODE = process.argv.includes("--check");

/** Mintlify frontmatter for the generated reference page. */
function frontmatter(version: string): string {
    return [
        "---",
        "title: Schema Reference",
        `description: Generated reference for the SFML ${version} schema.`,
        "---",
        "",
        `{/* Generated from schema/${version}/schema.ts by npm run generate. Do not edit. */}`,
        ""
    ].join("\n");
}

async function render(version: string): Promise<string> {
    const out = mkdtempSync(join(tmpdir(), "sfml-typedoc-"));
    try {
        await execAsync(`npx typedoc --entryPoints "${join("schema", version, "schema.ts")}" --out "${out}"`, {
            maxBuffer: 32 * 1024 * 1024
        });

        // TypeDoc titles the page after the package; the frontmatter already does that.
        const body = readFileSync(join(out, "README.md"), "utf-8").replace(/^#\s+.*\n+/, "");
        return (frontmatter(version) + "\n" + body).trimEnd() + "\n";
    } finally {
        rmSync(out, { recursive: true, force: true });
    }
}

async function generateDocs(version: string, check: boolean): Promise<boolean> {
    const target = join("docs", "specification", version, "schema.mdx");
    const expected = await render(version);

    if (check) {
        let existing: string;
        try {
            existing = readFileSync(target, "utf-8");
        } catch {
            console.error(`  ✗ ${target} is missing!`);
            return false;
        }
        if (existing.trim() !== expected.trim()) {
            console.error(`  ✗ ${target} is out of date!`);
            return false;
        }
        console.log(`  ✓ ${target} is up to date`);
        return true;
    }

    writeFileSync(target, expected, "utf-8");
    console.log(`  ✓ Generated ${target}`);
    return true;
}

async function main(): Promise<void> {
    console.log(CHECK_MODE ? "Checking schema reference pages...\n" : "Generating schema reference pages...\n");

    const results: boolean[] = [];
    for (const version of ALL_SCHEMAS) {
        results.push(await generateDocs(version, CHECK_MODE));
    }

    console.log();
    if (!results.every(Boolean)) {
        console.error("Error: Some reference pages are out of date. Run: npm run generate");
        process.exit(1);
    }
    console.log(CHECK_MODE ? "All reference pages are up to date!" : "Reference page generation complete!");
}

main().catch(error => {
    console.error("Reference page generation failed:", error);
    process.exit(1);
});
