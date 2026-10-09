/**
 * packages/mcp — empty scaffold (issue #17: repo workspace split).
 *
 * No MCP SDK dependency yet; the SDK/protocol version is a research-ticket
 * decision (map #12, #14) deliberately kept out of this purely mechanical
 * restructuring ticket. Tool implementations land in #19 (git recorder),
 * #20 (read/write tools), #21 (enrichment tools) — all currently blocked on
 * this ticket plus #18.
 *
 * The workspace:* link to @semantic-grounding/substrate is exercised by
 * tests/workspace-link.spec.ts, not from this file, so this barrel stays
 * genuinely empty until there is real tool surface to export.
 */
export {}
