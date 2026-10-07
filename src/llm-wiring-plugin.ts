/**
 * Cordis plugin that wires `ctx.llm` into `ctx.schema`'s enrichment seam.
 *
 * When both services are mounted, this plugin creates a TextLlm adapter from
 * `ctx.llm.stream()` + `BlockAssembler` and calls `wireEnrichmentLlm`. After
 * this, `discoverRelations` / `discoverEventRelations` / the on-write hook
 * run the LLM semantic round (G3 two-round strategy).
 *
 * Mount via the bundle patch as a separate row with id `enrichment-llm-wiring`.
 *
 * @module @deepseek-ai/dsh-semantic-layer/src/llm-wiring-plugin
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { wireEnrichmentLlm, type TextLlm, type SemanticGroundingCore } from './index.ts'

/**
 * Cordis `Context` augmentations for the two host seams this plugin touches.
 *
 * Both are declared here rather than in an ambient `.d.ts` because this file
 * has top-level imports, so `declare module` *merges* with the real package
 * instead of shadowing its specifier (an ambient
 * `declare module '@deepseek-ai/cordis'` in a no-import `.d.ts` replaces the
 * package's own types wholesale — the slice 1 gotcha).
 *
 *  - `llm` — provided by `@deepseek-ai/dsh-llm` (shimmed here, real on the
 *    host); this plugin adapts `ctx.llm.stream` into the core's `TextLlm` seam.
 *  - `schema` — the seam the dsh adapter mounts the core under. Declared here
 *    and not in the core because slice 2 ③ made the core host-framework-free:
 *    a core that declared its own `ctx` seam would still be coupled to the
 *    host it no longer imports.
 *
 * This file is the host-facing shell — the one place in `src/` that still names
 * cordis — and is the first candidate to move into the dsh adapter package
 * (slice 4). The core-purity gate in package.json whitelists it for exactly
 * that reason.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: { stream(options: unknown): AsyncIterable<unknown> }
    schema: SemanticGroundingCore
  }
}

export const name = 'enrichment-llm-wiring'
export const inject = ['schema', 'llm']

/** Config */
export interface Config {
  readonly provider?: string
  readonly model?: string
}

export const Config: z<Config> = z.object({
  provider: z.string().default(''),
  model: z.string().default(''),
})

/**
 * Resolve the enrichment LLM provider/model from explicit input, falling back
 * to the deployment env-var contract (`ENRICHMENT_LLM_PROVIDER` /
 * `ENRICHMENT_LLM_MODEL`). Returns `''` for whichever field neither input nor
 * env supplies; `apply` graceful-degrades when either is empty (warn + skip
 * `wireEnrichmentLlm`, so enrichment runs its deterministic round only). An
 * unconfigured enrichment capability must not take down the whole bundle
 * group at boot (CB-1a α; the substrate treats an unwired llmCall as
 * deterministic-only — see `enrichment.ts` / `setLlmCall`).
 *
 * CL8 centralization: this resolver (env-var names) is duplicated locally in
 * `eval-cli/src/main.ts` and `tool-search-data-sources/src/expand-query.ts`.
 * Those sibling resolvers still throw (fail-loud is correct for eval/tooling
 * contexts, which are not boot-critical); this boot-time resolver diverges to
 * graceful-degrade. Reconciling the divergence is deferred to CB-2. The shared
 * contract is the env-var names, not shared code (no new cross-package dep).
 */
function resolveEnrichmentLlmConfig(
  input: { provider?: string | undefined; model?: string | undefined },
): { provider: string; model: string } {
  const provider = input.provider || process.env.ENRICHMENT_LLM_PROVIDER || ''
  const model = input.model || process.env.ENRICHMENT_LLM_MODEL || ''
  return { provider, model }
}

export function apply(ctx: Context, config: Config = {}): void {
  // CL8: resolve provider/model from plugin config → deployment env-var
  // contract. No silent vendor fallback ('aga'/'qwen3.7-max' removed).
  // CB-1a α: unconfigured enrichment is non-fatal at boot — warn + run the
  // deterministic round only (skip wireEnrichmentLlm). Throwing here rolls
  // back the whole bundle group (vendor all-or-nothing) and drops the
  // semantic-layer UI; see CB-1 blocker 2 / CB-3 S2.
  const { provider, model } = resolveEnrichmentLlmConfig({ provider: config.provider, model: config.model })
  if (!provider || !model) {
    ctx.logger.warn('enrichment-llm-wiring: no provider/model configured; enrichment runs deterministic-only. Set ENRICHMENT_LLM_PROVIDER/MODEL or the settings item (CB-2, deferred) to enable the semantic round.')
    return
  }

  const textLlm: TextLlm = {
    async text(prompt: string): Promise<string> {
      // dsh-llm is an optional peer (peerDependenciesMeta): load it at call
      // time so module scope never depends on an absent optional dependency.
      const { BlockAssembler, createUserMessage } = await import('@deepseek-ai/dsh-llm')
      const assembler = new BlockAssembler()
      const options = {
        provider,
        model,
        messages: [
          createUserMessage({
            content: [{ type: 'text' as const, text: prompt }],
            source: { kind: 'plugin' as const, plugin: 'enrichment-llm-wiring' },
          }),
        ],
      }
      for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
      const text = assembler.blocks()
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map(b => b.text)
        .join('')
      if (text.length === 0) {
        throw new Error('enrichment-llm-wiring: LLM returned no text blocks')
      }
      return text
    },
  }

  wireEnrichmentLlm(ctx.schema, textLlm)
  ctx.logger.info(`enrichment-llm-wiring: wired ${provider}/${model} into ctx.schema enrichment`)
}
