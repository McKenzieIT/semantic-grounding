/** Core context type and root context implementation. */
export * from './context.ts'
/** Event bus, dispatch modes, and event augmentation types. */
export * from './events.ts'
/** Plugin fiber lifecycle, effects, and config validation helpers. */
export * from './fiber.ts'
/** Logger facade, logger service, message, exporter, and formatting types. */
export * from './logger.ts'
/** Plugin registry, dependency injection, and plugin entrypoint types. */
export * from './registry.ts'
/** Base service class and service lifecycle symbols. */
export * from './service.ts'
/** Shared internal helpers used by context, services, and plugin fibers. */
export * from './utils.ts'

/**
 * `llm` service augmentation — `@deepseek-ai/dsh-llm` (shimmed in this repo)
 * provides `ctx.llm.stream`. Augments `Context` via the relative-path
 * `declare module './context.ts'` pattern cordis's own services use, so it
 * merges with the source module without shadowing the package specifier.
 * Slice 2 removes the substrate's `ctx.*` lookups; this is transitional.
 */
declare module './context.ts' {
  export interface Context {
    llm: { stream(options: unknown): AsyncIterable<unknown> }
  }
}
