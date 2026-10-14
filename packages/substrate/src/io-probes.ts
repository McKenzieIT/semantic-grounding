/**
 * Test-only YAML-read counter — the 01-probe measurement surface, moved out of
 * io.ts (#123 / C8.5) so production code carries only the one-line increment
 * and the reset/get pair lives in a module no production path imports except
 * that call. The counter itself stays a module-level `let` exactly as the probe
 * landed it; only its home moved.
 *
 * NOT exported from index.ts: the public barrel is pinned name-by-name
 * (ADR-0003; the acceptance script deepEquals the runtime surface at 27 names
 * + default) and a test probe is not a host-facing name. Specs import directly
 * from this module — the same off-barrel pattern the io.ts internals follow.
 *
 * @module io-probes (internal; off the public barrel — ADR-0002/0003)
 */
let _readYamlCount = 0
/**
 * Count one `readYaml` parse. io.ts's `readYaml` calls this — its one-line
 * increment, and this module's only production caller.
 */
export function _countReadYamlParse(): void { _readYamlCount++ }
/** Test-only: reset the readYaml call counter to zero. */
export function _resetReadYamlCount(): void { _readYamlCount = 0 }
/** Test-only: read the current readYaml call count since last reset. */
export function _getReadYamlCount(): number { return _readYamlCount }
