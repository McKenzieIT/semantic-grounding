/**
 * A small git-backed corpus, built from scratch per test.
 *
 * #19 asks for this as a reusable artifact: "产出物可复用为端到端门禁的 fixture 底座" —
 * the end-to-end gate (map #12's Not-yet-specified item) needs a corpus small enough to
 * build in CI but real enough that the deterministic relation round actually fires. So
 * the default shape is the minimum that produces a *discoverable* join: a DIM keyed by
 * `shop_id` and a DWS carrying a `shop_id` column, which `enrichAllDwsTables` matches by
 * exact primary-key name.
 *
 * That default is not decoration. The on-write enrichment hook only writes when it finds
 * something, so a corpus without a matching DIM/DWS pair would quietly skip the residue
 * path and leave the recorder's derived-commit behaviour untested.
 *
 * YAML is dumped through the substrate's own `dumpYaml` (on its public barrel, and on
 * ADR-0003's allow-list) rather than importing `js-yaml` here — the map's Notes require
 * `packages/mcp` to consume the substrate through its root barrel, and a test helper is
 * not an exception worth making.
 *
 * Deliberately free of any `vitest` import: `tests/helpers/concurrent-writer.ts` runs
 * this in a child process under plain `node`, which has no test runner in scope.
 *
 * @module tests/helpers/fixture-corpus
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dumpYaml } from '@semantic-grounding/substrate'

/** A column in a fixture table. */
export interface FixtureColumn {
  readonly name: string
  readonly type: string
  readonly role: string
}

/**
 * Build a schema-valid table definition.
 *
 * Every field `TableDefinitionSchema` knows about is spelled out rather than relying on
 * defaults, because `updateTableMeta` re-validates the *merged* document: a fixture
 * missing a field passes on write and fails on update, which reads as a recorder bug.
 * @param overrides - fields to set on top of the empty-but-valid base.
 * @returns the table definition dict.
 */
export function fixtureTable(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    table_comment: '',
    description: '',
    alt_labels: [],
    domains: [],
    granularity: '',
    engine: 'maxcompute',
    metrics: {},
    partitions: [{ name: 'ds', type: 'string' }],
    confirmation: { status: 'draft', confirmed_by: '', confirmed_at: '' },
    coverage: null,
    supersedes: [],
    disambiguation: null,
    primary_key: [],
    primary_key_unique: null,
    duplicate_sample: [],
    label_columns: [],
    freshness: '',
    dimension_refs: [],
    ...overrides,
  }
}

/** Shorthand for a fixture column. */
export function col(name: string, type: string, role: string): FixtureColumn {
  return { name, type, role }
}

/** Options for {@link createFixtureCorpus}. */
export interface FixtureCorpusOptions {
  /**
   * Include the DIM table that makes the deterministic relation round fire (default
   * true). Set false for a corpus where no join is discoverable — the only way to test
   * that a write leaves the tree clean with *no* derived commit.
   */
  readonly withDim?: boolean
  /** Run `git init` and commit a baseline (default true). False leaves a non-git directory. */
  readonly git?: boolean
  /** Commit the baseline after `git init` (default true). False leaves an unborn HEAD. */
  readonly baselineCommit?: boolean
}

/** A built fixture corpus. */
export interface FixtureCorpus {
  /**
   * The corpus root.
   *
   * Note this is the path as `mkdtemp` returned it — on macOS that is under `/var/...`,
   * a symlink to `/private/var/...`, so every posture check in these tests runs against
   * a corpus root that differs textually from `git rev-parse --show-toplevel`. That is
   * intentional: a string comparison there would reject real corpora, and keeping the
   * symlink in the fixture means the whole suite would catch a regression to one.
   */
  readonly root: string
  /** Remove the corpus directory. */
  readonly cleanup: () => void
}

/**
 * Run git in the fixture, with an identity so commits work on a machine with no global
 * git config (CI).
 * @param args - git argv.
 * @param cwd - the fixture root.
 * @returns git's stdout.
 */
export function fixtureGit(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * Create a fixture corpus in a fresh temp directory.
 * @param opts - see {@link FixtureCorpusOptions}.
 * @returns the corpus root and a cleanup function.
 */
export function createFixtureCorpus(opts: FixtureCorpusOptions = {}): FixtureCorpus {
  const withDim = opts.withDim ?? true
  const wantGit = opts.git ?? true
  const wantBaseline = opts.baselineCommit ?? true

  const root = mkdtempSync(join(tmpdir(), 'sg-corpus-'))
  mkdirSync(join(root, 'tables'), { recursive: true })
  mkdirSync(join(root, 'events'), { recursive: true })
  writeFileSync(join(root, 'config.yaml'), dumpYaml({ scope_id: 'fixture' }), 'utf8')

  writeFileSync(
    join(root, 'tables', 'dws_order.yaml'),
    dumpYaml(fixtureTable({
      table_name: 'dws_order',
      kind: 'dws',
      columns: [col('shop_id', 'string', 'dimension'), col('pay_amt', 'double', 'measure')].map(c => ({ ...c, comment: '' })),
    })),
    'utf8',
  )
  if (withDim) {
    writeFileSync(
      join(root, 'tables', 'dim_shop.yaml'),
      dumpYaml(fixtureTable({
        table_name: 'dim_shop',
        kind: 'dim',
        primary_key: ['shop_id'],
        label_columns: ['shop_name'],
        granularity: '维表(非分区,全量参考,无时间维度)',
        freshness: 'static_reference',
        columns: [col('shop_id', 'string', 'dimension'), col('shop_name', 'string', 'dimension')].map(c => ({ ...c, comment: '' })),
      })),
      'utf8',
    )
  }

  if (wantGit) {
    fixtureGit(['init', '--quiet', '--initial-branch=main', '.'], root)
    // Repository-local identity: these tests must pass on a machine with no global git
    // config. It is also the human-write identity the audit history contrasts against,
    // which is why the recorder passes author/committer per invocation instead of
    // touching this config (see `git/identity.ts`).
    fixtureGit(['config', 'user.name', 'Fixture Human'], root)
    fixtureGit(['config', 'user.email', 'human@fixture.local'], root)
    fixtureGit(['config', 'commit.gpgsign', 'false'], root)
    if (wantBaseline) {
      fixtureGit(['add', '-A'], root)
      fixtureGit(['commit', '--quiet', '-m', 'corpus baseline'], root)
    }
  }

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
