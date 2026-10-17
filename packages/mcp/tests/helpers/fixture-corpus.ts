/**
 * A small git-backed corpus, built per test from a per-worker template (#174 4a).
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
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dumpYaml, loadTables } from '@semantic-grounding/substrate'

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
  /**
   * Include one event whose `shop_id` param joins `dim_shop` (default false). The
   * events dimension is what #25's incident was made of — a `tables` filter that
   * silently swept 445 events — so the tests that pin call-wide dimension semantics
   * (ADR-0007) build on a corpus where an event is visibly present to be (not)
   * swept. Off by default because the pre-#31 suites' arithmetic (Files=N, work-list
   * contents) was counted on an events-free corpus.
   */
  readonly withEvents?: boolean
  /** Run `git init` and commit a baseline (default true). False leaves a non-git directory. */
  readonly git?: boolean
  /** Commit the baseline after `git init` (default true). False leaves an unborn HEAD. */
  readonly baselineCommit?: boolean
  /**
   * Build the git layer from scratch (init + configs + baseline commit, ~8
   * spawns) instead of copying the per-worker template (#174 4a). For the
   * specs whose assertions are coupled to the build itself: `git-recorder.spec.ts`
   * pins absolute commit lists — a template's baseline commit is shared by every
   * corpus copied from it, so history-identity assertions need a git layer that
   * belongs to this corpus alone — and `concurrent-write.spec.ts` races real
   * processes against the corpus lock. Default false (template copy).
   */
  readonly freshGit?: boolean
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
 * Commit a direct edit to a table's YAML — "an operator changed this between issuance
 * and apply", landed as its own commit so the tree is clean afterward (a dirty,
 * *uncommitted* edit would instead trip `assertCleanBeforeWrite`, which is a different
 * scenario the specs test separately).
 *
 * The shared copy of a helper that used to live identically in
 * `tests/enrichment-tools.spec.ts` and `scripts/check-e2e-loop.ts`.
 * @param fixture - the fixture corpus.
 * @param tableName - the table to edit.
 * @param changes - fields to merge over the table's current raw dict.
 */
export function commitExternalEdit(fixture: FixtureCorpus, tableName: string, changes: Readonly<Record<string, unknown>>): void {
  const raw = loadTables(fixture.root).find(t => t.table_name === tableName)?.raw
  if (raw === undefined) throw new Error(`fixture table not found: ${tableName}`)
  writeFileSync(join(fixture.root, 'tables', `${tableName}.yaml`), dumpYaml({ ...raw, ...changes }), 'utf8')
  fixtureGit(['add', '-A'], fixture.root)
  fixtureGit(['commit', '--quiet', '-m', 'operator edit between issuance and apply'], fixture.root)
}

/**
 * Write the corpus working tree (config, tables, events) — no git.
 * @param root - the corpus root (existing directory).
 * @param withDim - include the joinable DIM table.
 * @param withEvents - include the joinable event.
 */
function writeCorpusFiles(root: string, withDim: boolean, withEvents: boolean): void {
  mkdirSync(join(root, 'tables'), { recursive: true })
  // Events live one domain-directory deep (`loadEvents` iterates domain dirs), the
  // same shape `packages/substrate/tests/enrichment-work.spec.ts` writes.
  mkdirSync(join(root, 'events', 'biz'), { recursive: true })
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
  if (withEvents) {
    // pay_success: `shop_id` param matches dim_shop's primary key, so the deterministic
    // relation round has an event-side join to find (when the events leg is in the
    // call). The description carries no parenthesized/quoted terms and no domains, so
    // the deterministic alt_labels round finds nothing for it — its alt_labels gap
    // survives every run, a stable LLM-half target.
    writeFileSync(
      join(root, 'events', 'biz', 'pay_success.yaml'),
      dumpYaml({
        name: 'pay_success',
        event_filter: '',
        description: '支付成功',
        alt_labels: [],
        domains: [],
        params_fields: { shop_id: { type: 'string', description: '店铺ID' } },
        metrics: {},
        disambiguation: [],
        external_refs: [],
      }),
      'utf8',
    )
  }
}

/** The identity the canonical recipe installs for in-suite fixtures (the
 *  human-write identity the audit history contrasts against — see below). */
const FIXTURE_IDENTITY = { name: 'Fixture Human', email: 'human@fixture.local' } as const

/**
 * Init the fixture's git layer: repository-local identity, hermetic line
 * endings, gc off, optional baseline commit. The canonical 8-step recipe
 * every corpus-rooted git repo in this package starts from — the e2e relay
 * stub and the opt-in relay driver reuse it for their k11-copy sandboxes.
 * @param root - the corpus root (working tree already written).
 * @param identity - repo-local `user.name`/`user.email`.
 * @param baselineMessage - land `add -A` + commit with this message, or
 *  leave an unborn HEAD when omitted.
 */
export function initFixtureGit(root: string, identity: Readonly<{ name: string; email: string }>, baselineMessage?: string): void {
  fixtureGit(['init', '--quiet', '--initial-branch=main', '.'], root)
  // Repository-local identity: these tests must pass on a machine with no global git
  // config. It is also the human-write identity the audit history contrasts against,
  // which is why the recorder passes author/committer per invocation instead of
  // touching this config (see `git/identity.ts`).
  fixtureGit(['config', 'user.name', identity.name], root)
  fixtureGit(['config', 'user.email', identity.email], root)
  fixtureGit(['config', 'commit.gpgsign', 'false'], root)
  // Hermetic line endings alongside the hermetic identity: Git-for-Windows defaults
  // `core.autocrlf=true` globally, and its smudge/clean filters make byte-exact
  // rollback and recovery-content assertions machine-dependent. A repo-local `false`
  // pins LF pass-through for every git call in this repo — the recorder's and
  // posture's own invocations included, since they read .git/config too (#81).
  fixtureGit(['config', 'core.autocrlf', 'false'], root)
  // #174 4a: auto-gc off. Every fixture repo sees dozens of add/commit invocations
  // across a suite run (the recorder's among them), and each is a fresh chance for
  // git to fork a `maintenance run --auto` child that no-ops — #167 measured 525
  // such wasted spawns on the mcp suite. A repo-local `0` pins that off for every
  // git call that reads this repo's config, template copies included (the config
  // travels with the copy).
  fixtureGit(['config', 'gc.auto', '0'], root)
  if (baselineMessage !== undefined) {
    fixtureGit(['add', '-A'], root)
    fixtureGit(['commit', '--quiet', '-m', baselineMessage], root)
  }
}

/**
 * Per-worker git-corpus templates (#174 4a): the 8-spawn build recipe (init +
 * 5 configs + add + commit, ~118ms) runs once per corpus shape per worker;
 * every corpus after that is an `fs.cpSync` of its template (~15.6ms measured
 * in #167, 7.6× cheaper). Keyed by shape, because the baseline commit's tree
 * differs per shape. Template copies share the template's baseline commit
 * hash — harmless to every spec that reasons about relative history (commit
 * counts, subjects, ordering), which is why the two that reason about
 * absolute history pay the `freshGit` tax instead.
 */
const gitCorpusTemplates = new Map<string, string>()

function gitCorpusTemplate(withDim: boolean, withEvents: boolean, baselineCommit: boolean): string {
  const key = `${withDim}|${withEvents}|${baselineCommit}`
  const cached = gitCorpusTemplates.get(key)
  if (cached !== undefined) return cached

  const dir = mkdtempSync(join(tmpdir(), 'sg-corpus-template-'))
  writeCorpusFiles(dir, withDim, withEvents)
  initFixtureGit(dir, FIXTURE_IDENTITY, baselineCommit ? 'corpus baseline' : undefined)
  gitCorpusTemplates.set(key, dir)
  // Best-effort cleanup when the worker exits; a leaked template directory is
  // a few KB in the OS tempdir, never a correctness concern.
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/**
 * Create a fixture corpus in a fresh temp directory.
 * @param opts - see {@link FixtureCorpusOptions}.
 * @returns the corpus root and a cleanup function.
 */
export function createFixtureCorpus(opts: FixtureCorpusOptions = {}): FixtureCorpus {
  const withDim = opts.withDim ?? true
  const withEvents = opts.withEvents ?? false
  const wantGit = opts.git ?? true
  const wantBaseline = opts.baselineCommit ?? true
  const wantFreshGit = opts.freshGit ?? false

  const root = mkdtempSync(join(tmpdir(), 'sg-corpus-'))
  if (wantGit && !wantFreshGit) {
    // The fast path: one directory copy carries working tree AND the
    // pre-initialized git layer (identity/autocrlf/gc configs + baseline
    // commit included). Git repos are relocatable — nothing inside .git
    // points back at the template's path.
    cpSync(gitCorpusTemplate(withDim, withEvents, wantBaseline), root, { recursive: true })
  } else {
    writeCorpusFiles(root, withDim, withEvents)
    if (wantGit) initFixtureGit(root, FIXTURE_IDENTITY, wantBaseline ? 'corpus baseline' : undefined)
  }

  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
