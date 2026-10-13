/**
 * The config surface's legal and illegal branches — #22's acceptance asks for exactly
 * this ("单元测试覆盖 CLI/config 解析的合法与非法分支"), re-ruled by ADR-0011 ruling 3
 * (#51): `--corpus` is gone, `--registry` takes its place as an *optional* carrier with
 * a real default, and `--agent-id` is the only required flag.
 *
 * `parseServerConfig` is pure over `(argv, env)`, which is why it is a unit test here and
 * the process-level contract (exit codes, stdout silence) is a spawn test in
 * `server-startup.spec.ts`. The split matters: a refusal has to be both *decided*
 * correctly and *reported* correctly, and only the second needs a process.
 *
 * @module tests/config.spec
 */
import { describe, expect, it } from 'vitest'
import { basename, isAbsolute, resolve } from 'node:path'
import { ConfigError, ENV_VARS, HelpRequested, parseServerConfig, usage } from '../src/config.ts'
import { DEFAULT_RATIO_GUARD_FLOOR, DEFAULT_RATIO_GUARD_THRESHOLD } from '../src/tools/import.ts'
import { defaultRegistryPath } from '../src/scope-registry.ts'

/** An environment with none of the server's variables set. */
const NO_ENV: Record<string, string | undefined> = {}

describe('parseServerConfig — legal branches', () => {
  it('takes the required value from flags', () => {
    const cfg = parseServerConfig(['--agent-id', 'analyst-bot'], NO_ENV)
    expect(cfg.agentId).toBe('analyst-bot')
  })

  it('defaults the registry path when none is given', () => {
    // Ruling 2's default: a server started with nothing but --agent-id still has a
    // table to read/write, at the same path every other process on the machine uses.
    const cfg = parseServerConfig(['--agent-id', 'a'], NO_ENV)
    expect(cfg.registryPath).toBe(defaultRegistryPath())
  })

  it('leaves the optional values absent rather than defaulting them', () => {
    const cfg = parseServerConfig(['--agent-id', 'a'], NO_ENV)
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
      ['--agent-id', 'a', '--scope', 'retail', '--lock-timeout-ms', '25000'],
      NO_ENV,
    )
    expect(cfg.scopeId).toBe('retail')
    expect(cfg.lockTimeoutMs).toBe(25_000)
  })

  it('resolves a relative registry path to an absolute one', () => {
    // Under stdio the MCP client picks the working directory, so a relative path names a
    // directory the operator did not choose. Resolving here, once, is what makes every
    // downstream message name the file actually used. Platform-portable assertions
    // (#81): `path.resolve` yields `D:\...` on Windows, so assert the semantics
    // (absolute, right basename) rather than a POSIX-shaped string.
    const cfg = parseServerConfig(['--registry', 'scopes.yaml', '--agent-id', 'a'], NO_ENV)
    expect(isAbsolute(cfg.registryPath)).toBe(true)
    expect(basename(cfg.registryPath)).toBe('scopes.yaml')
  })

  it('falls back to the environment for every setting', () => {
    const cfg = parseServerConfig([], {
      [ENV_VARS.registry]: '/srv/from-env.yaml',
      [ENV_VARS.agentId]: 'env-bot',
      [ENV_VARS.scope]: 'env-scope',
      [ENV_VARS.lockTimeoutMs]: '7000',
    })
    expect(cfg).toMatchObject({
      // The expected absolute form via the same path API the parser uses — a rooted
      // POSIX path resolves to `D:\srv\...` on Windows (#81).
      registryPath: resolve('/srv/from-env.yaml'),
      agentId: 'env-bot',
      scopeId: 'env-scope',
      lockTimeoutMs: 7000,
    })
  })

  it('lets a flag win over its environment variable', () => {
    const cfg = parseServerConfig(['--agent-id', 'flag-bot', '--registry', '/flag-registry.yaml'], {
      [ENV_VARS.agentId]: 'env-bot',
      [ENV_VARS.registry]: '/env-registry.yaml',
    })
    expect(cfg.agentId).toBe('flag-bot')
    expect(cfg.registryPath).toBe(resolve('/flag-registry.yaml'))
  })

  it('treats a blank value in either carrier as absent', () => {
    // A client UI that renders an empty text field as `--scope ""` means "unset". Taking
    // it literally would put an empty `X-SG-Scope` trailer in the audit history.
    const cfg = parseServerConfig(['--agent-id', 'a', '--scope', '   '], {
      [ENV_VARS.scope]: '',
    })
    expect(cfg.scopeId).toBeUndefined()
  })

  it('trims surrounding whitespace off values', () => {
    const cfg = parseServerConfig([], { [ENV_VARS.registry]: '/srv/reg.yaml ', [ENV_VARS.agentId]: ' bot ' })
    expect(cfg.agentId).toBe('bot')
    expect(cfg.registryPath).toBe(resolve('/srv/reg.yaml'))
  })

  it('parses the mass-update warn threshold from a flag, env, or neither (ADR-0018 R5)', () => {
    // The one flag ADR-0018 deliberately added past ADR-0011 ruling 3's four.
    const fromFlag = parseServerConfig(['--agent-id', 'a', '--mass-update-warn-threshold', '25'], NO_ENV)
    expect(fromFlag.massUpdateWarnThreshold).toBe(25)
    const fromEnv = parseServerConfig([], {
      [ENV_VARS.agentId]: 'a',
      [ENV_VARS.massUpdateWarnThreshold]: '30',
    })
    expect(fromEnv.massUpdateWarnThreshold).toBe(30)
    // A flag wins over its environment variable, like every other setting.
    const both = parseServerConfig(['--agent-id', 'a', '--mass-update-warn-threshold', '10'], {
      [ENV_VARS.massUpdateWarnThreshold]: '30',
    })
    expect(both.massUpdateWarnThreshold).toBe(10)
    // Absent (or blank in both carriers) stays absent — the default (50) lives
    // with the guard's consumer in `tools/import.ts`, not here: a default
    // invented here would be a second, competing source.
    const absent = parseServerConfig(['--agent-id', 'a'], { [ENV_VARS.massUpdateWarnThreshold]: '  ' })
    expect(absent.massUpdateWarnThreshold).toBeUndefined()
    expect('massUpdateWarnThreshold' in absent).toBe(false)
    // Zero is legal — "warn on every overwrite" is a posture, not a mistake
    // (the guard is a soft signal and never refuses).
    const zero = parseServerConfig(['--agent-id', 'a', '--mass-update-warn-threshold', '0'], NO_ENV)
    expect(zero.massUpdateWarnThreshold).toBe(0)
  })
})

describe('parseServerConfig — illegal branches', () => {
  it('refuses a missing agent id, and says why a default is not an option', () => {
    try {
      parseServerConfig([], NO_ENV)
      expect.unreachable('should have refused')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError)
      const msg = (e as ConfigError).message
      // Both carriers named: an operator whose host only exposes `env` must not be told
      // to pass a flag they cannot reach.
      expect(msg).toContain('--agent-id')
      expect(msg).toContain(ENV_VARS.agentId)
      // ADR-0004 ruling 9's reason, not just the symptom.
      expect(msg).toContain('not an audit trail')
    }
  })

  it('refuses an unknown flag', () => {
    expect(() => parseServerConfig(['--agent-id', 'a', '--nope'], NO_ENV)).toThrow(ConfigError)
  })

  it('refuses the removed --corpus flag', () => {
    // ADR-0011 ruling 3's clean break: a corpus enters through the register_scope tool
    // now, not the command line, and strict parsing rejects the old flag as unknown
    // rather than silently ignoring it.
    expect(() => parseServerConfig(['--corpus', '/srv/corpus', '--agent-id', 'a'], NO_ENV)).toThrow(ConfigError)
  })

  it('refuses a positional argument', () => {
    // There is no positional form; a corpus/scope enters through the register_scope
    // tool, not the command line.
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
    expect(() => parseServerConfig(['--agent-id', 'a', '--lock-timeout-ms', value], NO_ENV))
      .toThrow(ConfigError)
  })

  it('treats a blank lock timeout as absent rather than refusing it', () => {
    // The same blank-is-absent rule as every other value, applied before validation — so
    // an empty field in a client UI takes the default instead of failing startup.
    const cfg = parseServerConfig(['--agent-id', 'a', '--lock-timeout-ms', '  '], NO_ENV)
    expect(cfg.lockTimeoutMs).toBeUndefined()
  })

  it('refuses a malformed lock timeout from the environment too', () => {
    expect(() => parseServerConfig([], {
      [ENV_VARS.agentId]: 'a',
      [ENV_VARS.lockTimeoutMs]: 'ten seconds',
    })).toThrow(ConfigError)
  })

  it.each([
    ['negative', '-1'],
    ['fractional', '2.5'],
    ['not a number', 'many'],
  ])('refuses a mass-update warn threshold that is %s', (_label, value) => {
    // Refused rather than clamped, same as the lock timeout: a threshold
    // silently reinterpreted is a guard that stays quiet at a level nobody chose.
    expect(() => parseServerConfig(['--agent-id', 'a', '--mass-update-warn-threshold', value], NO_ENV))
      .toThrow(ConfigError)
  })

  it('carries a remedy on every ConfigError', () => {
    // Mirrors `PostureRefusedError`'s discipline: refusing without saying what to run is
    // how an operator concludes the tool is broken rather than the invocation.
    const cases: Array<[readonly string[], Record<string, string | undefined>]> = [
      [[], NO_ENV],
      [['--agent-id', 'a', '--bogus'], NO_ENV],
      [['--agent-id', 'a', '--lock-timeout-ms', 'x'], NO_ENV],
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
    // A nonexistent registry path and an ident-hostile agent id both parse here. Keeping
    // the two failure classes separate is what lets the exit code distinguish "your
    // invocation is wrong" (64) from "your deployment is not serviceable" (78).
    const cfg = parseServerConfig(['--registry', '/definitely/not/here/scopes.yaml', '--agent-id', 'bad<name>'], NO_ENV)
    expect(cfg.agentId).toBe('bad<name>')
  })
})

describe('parseServerConfig — mass-update ratio guard knobs (ADR-0019 R6)', () => {
  it('leaves massUpdateRatio absent when neither knob is given, and the defaults are pinned where the guard lives', () => {
    const cfg = parseServerConfig(['--agent-id', 'a'], NO_ENV)
    expect(cfg.massUpdateRatio).toBeUndefined()
    expect('massUpdateRatio' in cfg).toBe(false)
    // The ADR-0019 numbers, pinned: 50% trip threshold, small-corpus floor 10.
    expect(DEFAULT_RATIO_GUARD_THRESHOLD).toBe(0.5)
    expect(DEFAULT_RATIO_GUARD_FLOOR).toBe(10)
  })

  it('accepts both knobs from flags', () => {
    const cfg = parseServerConfig(
      ['--agent-id', 'a', '--mass-update-ratio-threshold', '0.25', '--mass-update-ratio-floor', '25'],
      NO_ENV,
    )
    expect(cfg.massUpdateRatio).toEqual({ threshold: 0.25, floor: 25 })
  })

  it('accepts one knob alone and leaves the other to its default', () => {
    const cfg = parseServerConfig(['--agent-id', 'a', '--mass-update-ratio-floor', '3'], NO_ENV)
    expect(cfg.massUpdateRatio).toEqual({ floor: 3 })
  })

  it('falls back to the environment, and a flag wins', () => {
    const fromEnv = parseServerConfig([], {
      [ENV_VARS.agentId]: 'a',
      [ENV_VARS.massUpdateRatioThreshold]: '0.8',
      [ENV_VARS.massUpdateRatioFloor]: '4',
    })
    expect(fromEnv.massUpdateRatio).toEqual({ threshold: 0.8, floor: 4 })
    const flagWins = parseServerConfig(
      ['--agent-id', 'a', '--mass-update-ratio-threshold', '0.1'],
      { [ENV_VARS.massUpdateRatioThreshold]: '0.8' },
    )
    expect(flagWins.massUpdateRatio).toEqual({ threshold: 0.1 })
  })

  it.each([
    ['zero', '0'],
    ['above one', '1.5'],
    ['negative', '-0.2'],
    ['not a number', 'half'],
    ['percent form', '50'],
  ])('refuses a threshold that is %s', (_label, value) => {
    // Refused rather than clamped: a threshold silently reinterpreted is a guard
    // that fires (or stays silent) for reasons nobody chose — and `50` meaning
    // 50% must be told the surface wants `0.5`.
    expect(() => parseServerConfig(['--agent-id', 'a', '--mass-update-ratio-threshold', value], NO_ENV))
      .toThrow(ConfigError)
  })

  it.each([
    ['negative', '-1'],
    ['fractional', '2.5'],
    ['not a number', 'few'],
  ])('refuses a floor that is %s', (_label, value) => {
    expect(() => parseServerConfig(['--agent-id', 'a', '--mass-update-ratio-floor', value], NO_ENV))
      .toThrow(ConfigError)
  })

  it('accepts a floor of zero (evaluating the ratio everywhere is a legal choice)', () => {
    const cfg = parseServerConfig(['--agent-id', 'a', '--mass-update-ratio-floor', '0'], NO_ENV)
    expect(cfg.massUpdateRatio).toEqual({ floor: 0 })
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
    for (const flag of ['--agent-id', '--scope', '--registry', '--lock-timeout-ms', '--mass-update-warn-threshold', '--help']) {
      expect(text, `usage should mention ${flag}`).toContain(flag)
    }
    for (const name of Object.values(ENV_VARS)) {
      expect(text, `usage should mention ${name}`).toContain(name)
    }
  })

  it('states the precedence rule, since there are two carriers', () => {
    expect(usage()).toContain('A flag always wins over its environment variable.')
  })

  it('explains that a corpus enters through the register_scope tool, not a flag', () => {
    expect(usage()).toContain('register_scope')
  })
})
