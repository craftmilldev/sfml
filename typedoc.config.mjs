// @ts-check
import { OptionDefaults } from "typedoc";

/** Tags that carry JSON Schema constraints for typescript-json-schema, not prose. */
const SCHEMA_TAGS = ["@TJS-type", "@minimum", "@maximum", "@format", "@pattern", "@maxItems", "@nullable"];

/** @type {Partial<import("typedoc").TypeDocOptions>} */
const config = {
    entryPoints: ["schema/draft/schema.ts"],
    plugin: ["typedoc-plugin-markdown"],
    readme: "none",
    outputFileStrategy: "modules",
    sort: ["source-order"],
    excludeInternal: true,
    disableSources: true,
    blockTags: [...OptionDefaults.blockTags, ...SCHEMA_TAGS],
    excludeTags: SCHEMA_TAGS,
    hideBreadcrumbs: true,
    hidePageHeader: true,
    useCodeBlocks: true,
    expandObjects: true,
    interfacePropertiesFormat: "list",
    typeDeclarationFormat: "list",
    logLevel: "Warn"
};

export default config;
