#!/usr/bin/env tsx

/**
 * Generates `schema/<version>/schema.json` from `schema/<version>/schema.ts`.
 *
 * With `--check`, regenerates in memory and fails if what is committed differs,
 * so a PR that edits schema.ts without regenerating cannot merge.
 */

import { exec } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/** Every schema version in the repo. New versions are added here. */
const ALL_SCHEMAS = ["draft"];

const CHECK_MODE = process.argv.includes("--check");

/** Rewrites typescript-json-schema's draft-07 output as JSON Schema 2020-12. */
function toJsonSchema202012(content: string): string {
    return content
        .replace(/http:\/\/json-schema\.org\/draft-07\/schema#/g, "https://json-schema.org/draft/2020-12/schema")
        .replace(/"definitions":/g, '"$defs":')
        .replace(/#\/definitions\//g, "#/$defs/");
}

async function render(version: string): Promise<string> {
    const schemaTs = join("schema", version, "schema.ts");
    const { stdout } = await execAsync(
        `npx typescript-json-schema --required --noExtraProps --skipLibCheck "${schemaTs}" "*"`,
        { maxBuffer: 32 * 1024 * 1024 }
    );
    return toJsonSchema202012(stdout).trim() + "\n";
}

async function generateSchema(version: string, check: boolean): Promise<boolean> {
    const schemaJson = join("schema", version, "schema.json");
    const expected = await render(version);

    if (check) {
        let existing: string;
        try {
            existing = readFileSync(schemaJson, "utf-8");
        } catch {
            console.error(`  ✗ ${schemaJson} is missing!`);
            return false;
        }
        if (existing.trim() !== expected.trim()) {
            console.error(`  ✗ Schema ${version} is out of date!`);
            return false;
        }
        console.log(`  ✓ Schema ${version} is up to date`);
        return true;
    }

    writeFileSync(schemaJson, expected, "utf-8");
    console.log(`  ✓ Generated schema for ${version}`);
    return true;
}

async function main(): Promise<void> {
    console.log(CHECK_MODE ? "Checking JSON schemas...\n" : "Generating JSON schemas...\n");

    const results = await Promise.all(ALL_SCHEMAS.map(version => generateSchema(version, CHECK_MODE)));

    console.log();
    if (!results.every(Boolean)) {
        console.error("Error: Some schemas are out of date. Run: npm run generate");
        process.exit(1);
    }
    console.log(CHECK_MODE ? "All schemas are up to date!" : "Schema generation complete!");
}

main().catch(error => {
    console.error("Schema generation failed:", error);
    process.exit(1);
});
