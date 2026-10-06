/**
 * K11 semantic-layer seed smoke test — validates that the seed at
 * `examples/k11-semantic-layer/` loads correctly through the semantic-layer
 * loaders. Catches drift between the seed YAML and the loader contracts.
 *
 * Run: `npx vitest run packages/data/semantic-layer/tests/k11-seed.spec.ts`
 */
import { test, expect, describe } from 'vitest'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadEvents,
  loadTables,
  loadRetrievalCorpus,
  loadEventDefinition,
  loadTableDefinition,
  loadConfig,
  loadDomains,
  resolveSemanticLayer,
} from '../src/io.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const SEED_PATH = join(HERE, './fixtures/k11')

describe('K11 semantic-layer seed smoke', () => {
  test('resolveSemanticLayer resolves the seed path', () => {
    const resolved = resolveSemanticLayer(SEED_PATH)
    expect(resolved).toBe(SEED_PATH)
  })

  // The migrated K11 seed holds 453 event YAML files = 446 event definitions
  // + 7 `_index.yaml` domain manifests. `loadEvents` is lenient: it skips the
  // 7 `_index.yaml` and 1 malformed file (`activity/funcPoint_activity.yaml`
  // — duplicate mapping key), so 445 events are loadable. The corpus is built
  // from `loadEvents`, so it holds 445 items too.
  test('loadEvents returns 445 events (453 files - 7 _index - 1 malformed)', () => {
    const events = loadEvents(SEED_PATH)
    expect(events).toHaveLength(445)
  })

  test('loadTables returns 321 tables (162 DWS + 159 DIM)', () => {
    const tables = loadTables(SEED_PATH)
    expect(tables).toHaveLength(321)
  })

  test('loadRetrievalCorpus returns 445 items (events only)', () => {
    const corpus = loadRetrievalCorpus(SEED_PATH)
    expect(corpus).toHaveLength(445)
  })

  test('loadEventDefinition parses game.role.online successfully', () => {
    const def = loadEventDefinition(SEED_PATH, 'game.role.online')
    expect(def).not.toBeNull()
    expect(def!.name).toBe('game.role.online')
  })

  test('loadTableDefinition parses dws_10000251_univ_role_act_di successfully', () => {
    const def = loadTableDefinition(SEED_PATH, 'dws_10000251_univ_role_act_di')
    expect(def).not.toBeNull()
    expect(def!.table_name).toBe('dws_10000251_univ_role_act_di')
  })

  test('loadConfig has a scope_id field', () => {
    const config = loadConfig(SEED_PATH)
    expect(config).toBeDefined()
    const project = config.project as Record<string, unknown>
    expect(project.scope_id).toBeDefined()
  })

  test('loadDomains returns a non-empty object', () => {
    const domains = loadDomains(SEED_PATH)
    expect(domains).not.toBeNull()
    expect(Object.keys(domains).length).toBeGreaterThan(0)
  })


})
