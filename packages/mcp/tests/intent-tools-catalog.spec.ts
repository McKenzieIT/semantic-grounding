/**
 * The tool catalog: names, and the schema shapes the ADRs' rulings bake in —
 * ADR-0005's fifteen intent tools plus ADR-0006/0008's four enrichment tools,
 * nineteen total. ADR-0005's own Verification section asks for exactly this
 * ("门禁脚本断言：十五个工具名与 input/output schema 快照"); ADR-0006/0008 inherited
 * the same ask, and the e2e gate's header defers schema pinning here — this file is
 * where that lands for the whole surface.
 *
 * This file asserts over the *wire* `tools/list` output (real zod → JSON Schema
 * conversion through the real `registerTool`), not this package's own TS types —
 * the schema an agent actually sees is what "schema 即提示词" (ADR-0005 ruling 1)
 * is about.
 *
 * The name reconciliation is the production/tests sync tripwire: the harness serves
 * the default registrars (production's `TOOL_REGISTRARS`), and this file asserts the
 * live `tools/list` equals `TOOL_NAMES` — a tool registered without its name constant
 * (or vice versa) fails here rather than shipping two different surfaces. The
 * `toHaveLength(19)` line is a deliberate speed bump: growing the surface must change
 * this line and show up in the diff.
 *
 * @see docs/adr/0005-mcp-tool-surface.md
 * @see docs/adr/0006-enrichment-agent-driven.md
 * @see docs/adr/0007-dimension-filter-semantics.md
 * @see docs/adr/0008-enrichment-work-response-sizing.md
 */
import { afterEach, describe, expect, it } from 'vitest'
import { TOOL_NAMES } from '../src/tools/index.ts'
import { buildIntentToolHarness, type IntentToolHarness } from './helpers/intent-tools-harness.ts'

let h: IntentToolHarness | undefined
afterEach(() => h?.close())

/** One `tools/list` entry's shape, as this file reads it back. */
interface ListedTool {
  readonly name: string
  readonly description?: string
  readonly inputSchema: {
    readonly type?: string
    readonly properties?: Record<string, unknown>
    readonly required?: readonly string[]
    readonly additionalProperties?: unknown
    readonly oneOf?: readonly { readonly properties?: Record<string, unknown>; readonly required?: readonly string[] }[]
  }
}

async function listTools(): Promise<ListedTool[]> {
  h = await buildIntentToolHarness()
  const res = await h.client.listTools()
  return res.result?.['tools'] as ListedTool[]
}

function byName(tools: readonly ListedTool[], name: string): ListedTool {
  const found = tools.find(t => t.name === name)
  if (found === undefined) throw new Error(`tools/list did not include "${name}"`)
  return found
}

describe('the nineteen names', () => {
  it('registers exactly ADR-0005\'s fifteen + ADR-0006/0008\'s four, reconciled against TOOL_NAMES', async () => {
    const tools = await listTools()
    expect(tools.map(t => t.name).sort()).toEqual([...TOOL_NAMES].sort())
    // Deliberate hard count, not TOOL_NAMES.length: growing the surface to 20 must
    // edit this line, so the change is visible in the diff for review.
    expect(tools).toHaveLength(19)
  })

  it('names every read tool ADR-0005 ruling 6 lists', async () => {
    const tools = await listTools()
    const names = tools.map(t => t.name)
    expect(names).toEqual(expect.arrayContaining([
      'search_definitions', 'get_definition', 'get_join_path', 'get_relations', 'resolve_alias',
    ]))
  })

  it('names every write tool ADR-0005 ruling 2 lists', async () => {
    const tools = await listTools()
    const names = tools.map(t => t.name)
    expect(names).toEqual(expect.arrayContaining([
      'create_definition', 'update_definition',
      'add_alias', 'remove_alias', 'add_relation', 'remove_relation',
      'submit_suggestion', 'list_suggestions', 'get_suggestion', 'discard_suggestion',
    ]))
  })
})

describe('read tool schemas', () => {
  it('search_definitions requires query, and accepts optional top_k + kinds', async () => {
    const tool = byName(await listTools(), 'search_definitions')
    expect(tool.inputSchema.required).toEqual(['query'])
    expect(tool.inputSchema.properties).toHaveProperty('top_k')
    expect(tool.inputSchema.properties).toHaveProperty('kinds')
  })

  it('get_definition requires kind + name, with the four readable kinds', async () => {
    const tool = byName(await listTools(), 'get_definition')
    expect(tool.inputSchema.required?.slice().sort()).toEqual(['kind', 'name'])
    const kindSchema = tool.inputSchema.properties?.['kind'] as { enum?: readonly string[] }
    expect(kindSchema.enum?.slice().sort()).toEqual(['concept', 'event', 'metric', 'table'])
  })

  it('get_join_path requires from + to', async () => {
    const tool = byName(await listTools(), 'get_join_path')
    expect(tool.inputSchema.required?.slice().sort()).toEqual(['from', 'to'])
  })

  it('get_relations requires target, with an optional open-string type filter', async () => {
    const tool = byName(await listTools(), 'get_relations')
    expect(tool.inputSchema.required).toEqual(['target'])
    expect(tool.inputSchema.properties).toHaveProperty('type')
  })

  it('resolve_alias requires term', async () => {
    const tool = byName(await listTools(), 'resolve_alias')
    expect(tool.inputSchema.required).toEqual(['term'])
  })
})

describe('create_definition — ADR-0005 ruling 5', () => {
  it('is a discriminated union on kind: table | event', async () => {
    const tool = byName(await listTools(), 'create_definition')
    const branches = tool.inputSchema.oneOf
    expect(branches).toHaveLength(2)
  })

  it('each branch requires the full TableDefinitionSchema/EventDefinitionSchema payload plus the create-class common block, and omits expected_version', async () => {
    const tool = byName(await listTools(), 'create_definition')
    for (const branch of tool.inputSchema.oneOf ?? []) {
      expect(branch.required).toEqual(expect.arrayContaining(['kind', 'summary', 'derivation', 'confidence']))
      expect(branch.required).not.toContain('expected_version')
      expect(branch.properties).not.toHaveProperty('expected_version')
    }
  })
})

describe('update_definition — ADR-0005 ruling 4', () => {
  it('is a discriminated union on kind: table | event, each requiring expected_version', async () => {
    const tool = byName(await listTools(), 'update_definition')
    const branches = tool.inputSchema.oneOf ?? []
    expect(branches).toHaveLength(2)
    for (const branch of branches) {
      expect(branch.required).toEqual(expect.arrayContaining(['kind', 'name', 'fields', 'summary', 'derivation', 'confidence', 'expected_version']))
    }
  })

  it('rejects table identity fields entirely: table_name and kind are absent from fields\' own properties', async () => {
    const tool = byName(await listTools(), 'update_definition')
    const tableBranch = (tool.inputSchema.oneOf ?? []).find(b => (b.properties?.['kind'] as { const?: string })?.const === 'table')
    const fields = tableBranch?.properties?.['fields'] as { properties?: Record<string, unknown>; additionalProperties?: unknown }
    expect(fields.properties).not.toHaveProperty('table_name')
    expect(fields.properties).not.toHaveProperty('kind')
    // .strict() — a typo'd field is a real zod validation error, not silently dropped.
    expect(fields.additionalProperties).toBe(false)
  })

  it('leaves table array-reference fields in the schema (zod accepts them syntactically; the handler redirects at call time)', async () => {
    const tool = byName(await listTools(), 'update_definition')
    const tableBranch = (tool.inputSchema.oneOf ?? []).find(b => (b.properties?.['kind'] as { const?: string })?.const === 'table')
    const fields = tableBranch?.properties?.['fields'] as { properties?: Record<string, unknown> }
    expect(fields.properties).toHaveProperty('alt_labels')
    expect(fields.properties).toHaveProperty('dimension_refs')
  })

  it('rejects the event identity field (name) the same way', async () => {
    const tool = byName(await listTools(), 'update_definition')
    const eventBranch = (tool.inputSchema.oneOf ?? []).find(b => (b.properties?.['kind'] as { const?: string })?.const === 'event')
    const fields = eventBranch?.properties?.['fields'] as { properties?: Record<string, unknown>; additionalProperties?: unknown }
    expect(fields.properties).not.toHaveProperty('name')
    expect(fields.properties).toHaveProperty('alt_labels')
    expect(fields.properties).toHaveProperty('external_refs')
    expect(fields.additionalProperties).toBe(false)
  })
})

describe('item-level tool schemas — ADR-0005 ruling 3 (reshaped by ADR-0010 / #38: remove_* takes arrays)', () => {
  it('add_alias requires kind, name, alias, and the full update-class common block', async () => {
    const tool = byName(await listTools(), 'add_alias')
    expect(tool.inputSchema.required?.slice().sort()).toEqual(
      ['alias', 'confidence', 'derivation', 'expected_version', 'kind', 'name', 'summary'].sort(),
    )
  })

  it('remove_alias requires kind, name, labels (a same-target batch, #37 §3), and the full update-class common block', async () => {
    const tool = byName(await listTools(), 'remove_alias')
    expect(tool.inputSchema.required?.slice().sort()).toEqual(
      ['confidence', 'derivation', 'expected_version', 'kind', 'labels', 'name', 'summary'].sort(),
    )
    const labels = tool.inputSchema.properties?.['labels'] as { type?: string; minItems?: number }
    expect(labels.type).toBe('array')
    expect(labels.minItems).toBe(1)
  })

  it('add_relation requires a relation object (dim_table + join_keys), never origin or derivation on it', async () => {
    const tool = byName(await listTools(), 'add_relation')
    const relation = tool.inputSchema.properties?.['relation'] as { properties?: Record<string, unknown>; required?: readonly string[] }
    expect(relation.required?.slice().sort()).toEqual(['dim_table', 'join_keys'])
    expect(relation.properties).not.toHaveProperty('origin')
    expect(relation.properties).not.toHaveProperty('derivation')
  })

  it('remove_relation requires an array of relation objects (relations, #37 §3), each dim_table + join_keys, never origin or derivation', async () => {
    const tool = byName(await listTools(), 'remove_relation')
    const relations = tool.inputSchema.properties?.['relations'] as { type?: string; minItems?: number; items?: { properties?: Record<string, unknown>; required?: readonly string[] } }
    expect(relations.type).toBe('array')
    expect(relations.minItems).toBe(1)
    expect(relations.items?.required?.slice().sort()).toEqual(['dim_table', 'join_keys'])
    expect(relations.items?.properties).not.toHaveProperty('origin')
    expect(relations.items?.properties).not.toHaveProperty('derivation')
  })

  it('never exposes a whole-array replace parameter', async () => {
    for (const name of ['add_alias', 'remove_alias', 'add_relation', 'remove_relation']) {
      const tool = byName(await listTools(), name)
      expect(tool.inputSchema.properties).not.toHaveProperty('alt_labels')
      expect(tool.inputSchema.properties).not.toHaveProperty('dimension_refs')
      expect(tool.inputSchema.properties).not.toHaveProperty('external_refs')
    }
  })
})

describe('Tier-1 suggestion tool schemas — ADR-0005 ruling 7 ("Tier-1 无此参")', () => {
  it('none of the four carry the Tier-2 common block', async () => {
    for (const name of ['submit_suggestion', 'list_suggestions', 'get_suggestion', 'discard_suggestion']) {
      const tool = byName(await listTools(), name)
      for (const field of ['summary', 'derivation', 'confidence', 'expected_version']) {
        expect(tool.inputSchema.properties).not.toHaveProperty(field)
      }
    }
  })

  it('submit_suggestion requires kind, subject, content', async () => {
    const tool = byName(await listTools(), 'submit_suggestion')
    expect(tool.inputSchema.required?.slice().sort()).toEqual(['content', 'kind', 'subject'])
  })

  it('list_suggestions takes no parameters at all', async () => {
    const tool = byName(await listTools(), 'list_suggestions')
    expect(tool.inputSchema.properties).toEqual({})
    expect(tool.inputSchema.additionalProperties).toBe(false)
  })

  it('get_suggestion / discard_suggestion require suggestion_id', async () => {
    for (const name of ['get_suggestion', 'discard_suggestion']) {
      const tool = byName(await listTools(), name)
      expect(tool.inputSchema.required).toEqual(['suggestion_id'])
    }
  })
})

describe('enrichment tool schemas — ADR-0006/0007/0008', () => {
  it('get_enrichment_work takes only the dimension-filter pair, each array minItems 1, nothing required', async () => {
    const tool = byName(await listTools(), 'get_enrichment_work')
    expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(['events', 'tables'])
    expect(tool.inputSchema.required).toBeUndefined()
    for (const field of ['tables', 'events']) {
      const filter = tool.inputSchema.properties?.[field] as { type?: string; minItems?: number }
      expect(filter.type).toBe('array')
      expect(filter.minItems).toBe(1) // zod min(1): omit the key, don't pass [] (ADR-0007)
    }
  })

  it('run_enrichment carries the very same filter schema shape as the listing tool', async () => {
    const tools = await listTools()
    expect(byName(tools, 'run_enrichment').inputSchema).toEqual(byName(tools, 'get_enrichment_work').inputSchema)
  })

  it('get_enrichment_prompts requires work_ids as a 1–10 batch (ADR-0008\'s half-window fold)', async () => {
    const tool = byName(await listTools(), 'get_enrichment_prompts')
    expect(tool.inputSchema.required).toEqual(['work_ids'])
    const ids = tool.inputSchema.properties?.['work_ids'] as { type?: string; minItems?: number; maxItems?: number }
    expect(ids.type).toBe('array')
    expect(ids.minItems).toBe(1)
    expect(ids.maxItems).toBe(10)
  })

  it('apply_enrichment requires results + summary + confidence, and has no derivation field at all (ADR-0006 ruling 5)', async () => {
    const tool = byName(await listTools(), 'apply_enrichment')
    expect(tool.inputSchema.required?.slice().sort()).toEqual(['confidence', 'results', 'summary'])
    expect(tool.inputSchema.properties).not.toHaveProperty('derivation') // server恒盖 llm — nothing for the client to claim
    const results = tool.inputSchema.properties?.['results'] as { type?: string; minItems?: number; items?: { required?: readonly string[] } }
    expect(results.type).toBe('array')
    expect(results.minItems).toBe(1)
    expect(results.items?.required?.slice().sort()).toEqual(['text', 'work_id'])
    const summary = tool.inputSchema.properties?.['summary'] as { minLength?: number; maxLength?: number }
    expect(summary.minLength).toBe(1)
    expect(summary.maxLength).toBe(100)
    const confidence = tool.inputSchema.properties?.['confidence'] as { minimum?: number; maximum?: number }
    expect(confidence.minimum).toBe(0)
    expect(confidence.maximum).toBe(1)
  })
})
