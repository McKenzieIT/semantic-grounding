/**
 * The config surface's legal and illegal branches — #22's acceptance asks for exactly
 * this ("单元测试覆盖 CLI/config 解析的合法与非法分支").
 *
 * `parseServerConfig` is pure over `(argv, env)`, which is why it is a unit test here and
 * the process-level contract (exit codes, stdout silence) is a spawn test in
 * `server-startup.spec.ts`. The split matters: a refusal has to be both *decided*
 * correctly and *reported* correctly, and only the second needs a process.
 *
 * @module tests/config.spec
 */
import { describe, expect, it } from 'vitest'
import { ConfigError, ENV_VARS, HelpRequested, parseServerConfig, usage } from '../src/config.ts'

/** An environment with none of the server's variables set. */
const NO_ENV: Record<string, string | undefined> = {}

describe('parseServerConfig — legal branches', () => {
  it('takes the two required values from flags', () => {
    const cfg = parseServerConfig(['--corpus', '/srv/corpus', '--agent-id', 'analyst-bot'], NO_ENV)
    expect(cfg.corpusRoot).toBe('/srv/corpus')
    expect(cfg.agentId).toBe('analyst-bot')
  })

  it('leaves the optional values absent rather than defaulting them', () => {
    const cfg = parseServerConfig(['--corpus', '/srv/corpus', '--agent-id', 'a'], NO_ENV)
    // Absent, not empty-string and not zero: `buildTrailers` drops `X-SG-Scope` when the
    // scope is blank, and `lock.ts` owns the timeout default. A default invented here
    // would be a second, competing source for both.
    expect(cfg.scopeId).toBeUndefined()
    expect(cfg.lockTimeoutMs).toBeUndefined()
    expect('scopeId' in cfg).toBe(false)
    expect('lockTimeoutMs' in cfg).toBe(false)
  })

  it('accepts the optional values when given', () => {
    const cfg = parseServerConfig(
      ['--corpus', '/srv/c', '--agent-id', 'a', '--scope', 'retail', '--lock-timeout-ms', '25000'],
      NO_ENV,
    )
    expect(cfg.scopeId).toBe('retail')
    expect(cfg.lockTimeoutMs).toBe(25_000)
  })

  it('resolves a relative corpus path to an absolute one', () => {
    // Under stdio the MCP client picks the working directory, so a relative path names a
    // directory the operator did not choose. Resolving here, once, is what makes every
    // downstream message (and the posture check's toplevel comparison) name the directory
    // actually used.
    const cfg = parseServerConfig(['--corpus', 'corpus', '--agent-id', 'a'], NO_ENV)
    expect(cfg.corpusRoot.startsWith('/')).toBe(true)
    expect(cfg.corpusRoot.endsWith('/corpus')).toBe(true)
  })

  it('falls back to the environment for every setting', () => {
    const cfg = parseServerConfig([], {
      [ENV_VARS.corpus]: '/srv/from-env',
      [ENV_VARS.agentId]: 'env-bot',
      [ENV_VARS.scope]: 'env-scope',
      [ENV_VARS.lockTimeoutMs]: '7000',
    })
    expect(cfg).toMatchObject({
      corpusRoot: '/srv/from-env',
      agentId: 'env-bot',
      scopeId: 'env-scope',
      lockTimeoutMs: 7000,
    })
  })

  it('lets a flag win over its environment variable', () => {
    const cfg = parseServerConfig(['--agent-id', 'flag-bot'], {
      [ENV_VARS.corpus]: '/srv/c',
      [ENV_VARS.agentId]: 'env-bot',
    })
    expect(cfg.agentId).toBe('flag-bot')
  })

  it('treats a blank value in either carrier as absent', () => {
    // A client UI that renders an empty text field as `--scope ""` means "unset". Taking
    // it literally would put an empty `X-SG-Scope` trailer in the audit history.
    const cfg = parseServerConfig(['--corpus', '/srv/c', '--agent-id', 'a', '--scope', '   '], {
      [ENV_VARS.scope]: '',
    })
    expect(cfg.scopeId).toBeUndefined()
  })

  it('trims surrounding whitespace off values', () => {
    const cfg = parseServerConfig([], { [ENV_VARS.corpus]: '/srv/c ', [ENV_VARS.agentId]: ' bot ' })
    expect(cfg.agentId).toBe('bot')
  })
})

describe('parseServerConfig — illegal branches', () => {
  it('refuses a missing corpus, naming both carriers', () => {
    try {
      parseServerConfig(['--agent-id', 'a'], NO_ENV)
      expect.unreachable('should have refused')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError)
      // Both carriers named: an operator whose host only exposes `env` must not be told
      // to pass a flag they cannot reach.
      expect((e as ConfigError).message).toContain('--corpus')
      expect((e as ConfigError).message).toContain(ENV_VARS.corpus)
    }
  })

  it('refuses a missing agent id, and says why a default is not an option', () => {
    try {
      parseServerConfig(['--corpus', '/srv/c'], NO_ENV)
      expect.unreachable('should have refused')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError)
      const msg = (e as ConfigError).message
      expect(msg).toContain('--agent-id')
      expect(msg).toContain(ENV_VARS.agentId)
      // ADR-0004 ruling 9's reason, not just the symptom.
      expect(msg).toContain('not an audit trail')
    }
  })

  it('refuses an unknown flag', () => {
    expect(() => parseServerConfig(['--corpus', '/c', '--agent-id', 'a', '--nope'], NO_ENV))
      .toThrow(ConfigError)
  })

  it('refuses a positional argument', () => {
    // There is no positional form. Accepting one would make `sg-mcp /srv/corpus` look
    // configured while leaving the corpus unset.
    expect(() => parseServerConfig(['/srv/corpus'], NO_ENV)).toThrow(ConfigError)
  })

  it.each([
    ['not a number', '10s'],
    ['zero', '0'],
    ['negative', '-1'],
    ['fractional', '1500.5'],
  ])('refuses a lock timeout that is %s', (_label, value) => {
    // Refused rather than clamped or rounded: a timeout silently reinterpreted makes the
    // corpus block or fail for a duration nobody chose.
    expect(() => parseServerConfig(['--corpus', '/c', '--agent-id', 'a', '--lock-timeout-ms', value], NO_ENV))
      .toThrow(ConfigError)
  })

  it('treats a blank lock timeout as absent rather than refusing it', () => {
    // The same blank-is-absent rule as every other value, applied before validation — so
    // an empty field in a client UI takes the default instead of failing startup.
    const cfg = parseServerConfig(['--corpus', '/c', '--agent-id', 'a', '--lock-timeout-ms', '  '], NO_ENV)
    expect(cfg.lockTimeoutMs).toBeUndefined()
  })

  it('refuses a malformed lock timeout from the environment too', () => {
    expect(() => parseServerConfig([], {
      [ENV_VARS.corpus]: '/c',
      [ENV_VARS.agentId]: 'a',
      [ENV_VARS.lockTimeoutMs]: 'ten seconds',
    })).toThrow(ConfigError)
  })

  it('carries a remedy on every ConfigError', () => {
    // Mirrors `PostureRefusedError`'s discipline: refusing without saying what to run is
    // how an operator concludes the tool is broken rather than the invocation.
    const cases: Array<[readonly string[], Record<string, string | undefined>]> = [
      [['--agent-id', 'a'], NO_ENV],
      [['--corpus', '/c'], NO_ENV],
      [['--corpus', '/c', '--agent-id', 'a', '--bogus'], NO_ENV],
      [['--corpus', '/c', '--agent-id', 'a', '--lock-timeout-ms', 'x'], NO_ENV],
    ]
    for (const [argv, env] of cases) {
      try {
        parseServerConfig(argv, env)
        expect.unreachable(`should have refused: ${argv.join(' ')}`)
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError)
        expect((e as ConfigError).remedy.length).toBeGreaterThan(0)
        expect((e as ConfigError).message).toContain((e as ConfigError).remedy)
      }
    }
  })

  it('does not validate the deployment — that is posture.ts and identity.ts', () => {
    // A nonexistent corpus and an ident-hostile agent id both parse here. Keeping the two
    // failure classes separate is what lets the exit code distinguish "your invocation is
    // wrong" (64) from "your deployment is not serviceable" (78).
    const cfg = parseServerConfig(['--corpus', '/definitely/not/here', '--agent-id', 'bad<name>'], NO_ENV)
    expect(cfg.agentId).toBe('bad<name>')
  })
})

describe('--help', () => {
  it.each(['--help', '-h'])('%s raises HelpRequested carrying the usage text', flag => {
    try {
      parseServerConfig([flag], NO_ENV)
      expect.unreachable('should have raised')
    } catch (e) {
      expect(e).toBeInstanceOf(HelpRequested)
      expect((e as HelpRequested).usage).toBe(usage())
    }
  })

  it('wins over an otherwise-invalid invocation', () => {
    // Asking what the flags are must work when you do not yet know them.
    expect(() => parseServerConfig(['--help'], NO_ENV)).toThrow(HelpRequested)
  })
})

describe('usage text', () => {
  it('documents every flag and its environment variable', () => {
    const text = usage()
    for (const flag of ['--corpus', '--agent-id', '--scope', '--lock-timeout-ms', '--help']) {
      expect(text, `usage should mention ${flag}`).toContain(flag)
    }
    for (const name of Object.values(ENV_VARS)) {
      expect(text, `usage should mention ${name}`).toContain(name)
    }
  })

  it('states the precedence rule, since there are two carriers', () => {
    expect(usage()).toContain('A flag always wins over its environment variable.')
  })
})
