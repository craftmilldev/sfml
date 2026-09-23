// Getting a value out of an agent's final text, for harnesses without native structured output.
// This is the fenced-block approach: ask for the result in a ```json block, then parse the last such
// block. When nothing parses, the wrapper reports `no_value`, which the Runner treats as a
// schema_violation (SPEC §10.4).

export type Extraction = { ok: true; value: unknown } | { ok: false; reason: string };

const FENCE = /```(?:json)?[ \t]*\n([\s\S]*?)\n?```/g;

/** Instructions a wrapper can append to the SFML-rendered prompt to ask for a fenced result. */
export function fencedResultInstructions(schema: Record<string, unknown>): string {
  return [
    "",
    "When you are done, reply with your result as a single JSON value in a ```json code block.",
    "It must validate against this JSON Schema:",
    "```json",
    JSON.stringify(schema, null, 2),
    "```",
  ].join("\n");
}

export function extractFencedJson(text: string): Extraction {
  const blocks = [...text.matchAll(FENCE)].map((m) => m[1]!);
  const candidates = blocks.length ? blocks.reverse() : [text.trim()];
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // try the next candidate
    }
  }
  return {
    ok: false,
    reason: blocks.length ? "no fenced block holds valid JSON" : "no fenced JSON block in the agent's reply",
  };
}
