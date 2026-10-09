/**
 * ADR-0005's fifteen intent tools — the catalog: names, and the schema shapes the
 * ADR's rulings bake in. ADR-0005's own Verification section asks for exactly this
 * ("门禁脚本断言：十五个工具名与 input/output schema 快照").
 *
 * This file asserts over the *wire* `tools/list` output (real zod → JSON Schema
 * conversion through the real `registerTool`), not this package's own TS types —
 * the schema an agent actually sees is what "schema 即提示词" (ADR-0005 ruling 1)
 * is about.
 *
 * @see docs/adr/0005-mcp-tool-surface.md
 */
import { afterEach, describe, expect, it } from 'vitest'
import { INTENT_TOOL_NAMES } from '../src/tools/index.ts'
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

describe('the fifteen names', () => {
  it('registers exactly ADR-0005\'s read five + write ten, with the capability pre-declared', async () => {
    const tools = await listTools()
    expect(tools.map(t => t.name).sort()).toEqual([...INTENT_TOOL_NAMES].sort())
    expect(tools).toHaveLength(15)
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

describe('item-level tool schemas — ADR-0005 ruling 3', () => {
  it('add_alias / remove_alias require kind, name, alias, and the full update-class common block', async () => {
    for (const name of ['add_alias', 'remove_alias']) {
      const tool = byName(await listTools(), name)
      expect(tool.inputSchema.required?.slice().sort()).toEqual(
        ['alias', 'confidence', 'derivation', 'expected_version', 'kind', 'name', 'summary'].sort(),
      )
    }
  })

  it('add_relation / remove_relation require a relation object (dim_table + join_keys), never origin or derivation on it', async () => {
    for (const name of ['add_relation', 'remove_relation']) {
      const tool = byName(await listTools(), name)
      const relation = tool.inputSchema.properties?.['relation'] as { properties?: Record<string, unknown>; required?: readonly string[] }
      expect(relation.required?.slice().sort()).toEqual(['dim_table', 'join_keys'])
      expect(relation.properties).not.toHaveProperty('origin')
      expect(relation.properties).not.toHaveProperty('derivation')
    }
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
