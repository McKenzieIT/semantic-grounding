/**
 * ADR-0011's five scope-management tools plus #72's `deregister_scope`:
 * `get_scope_scaffold`, `register_scope`, `deregister_scope`, `list_scopes`,
 * `switch_scope`, `get_scope` ([#51](https://github.com/McKenzieIT/semantic-grounding/issues/51),
 * [#72](https://github.com/McKenzieIT/semantic-grounding/issues/72)).
 *
 * The initialization path these carry (ADR-0011 Decision): an agent asks
 * {@link getScopeScaffold} for the shell's layout, **runs the infrastructure
 * half itself in bash** (mkdir / config / git init — the MCP boundary rules
 * knowledge + registry, not infrastructure execution, #42), then walks
 * {@link registerScope} → {@link switchScope}. `register_scope` is the single
 * bootstrap door: posture + a full corpus load happen at the door (constant 2),
 * and the 1:1 id↔path pairing is enforced both directions before the table is
 * written. Registering does **not** switch (constant 1) — an explicit
 * `switch_scope` is an agent's own act, and it is also what updates the
 * registry's next-process default (ruling 9). The door has an exit:
 * `deregister_scope` is its deliberate mirror — pure bookkeeping where the
 * door was guarded, because a dead entry's defining property is that its
 * directory is gone (posture's own failure shape), and a mis-registered id
 * (#69's scenario) exits by deregister + re-register under the new name,
 * old trailers staying fact in the corpus history.
 *
 * `get_scope_scaffold`'s `next_steps` is the one-line bootstrap for the
 * **content** half — ADR-0012 R4's self-contained line (五要素两禁止), canonical
 * home this file's constant, versioned with the source: no doc pointer (nothing
 * to point at that cannot drift), no structured pipeline object (that would make
 * the scaffold a content manual, against ADR-0011 constant 9's seam).
 *
 * #69 adds the soft guidance that path was missing: the **naming** decision,
 * initialization's first human call. The scope_id is a persistent identity —
 * 1:1 with the corpus directory, riding every Tier-2 commit's trailer, no
 * rename tool on the registration surface — so both bootstrap descriptions
 * (`get_scope_scaffold` and `register_scope`, same sentence in different
 * wording) tell the agent to confirm the naming with the user before
 * registering. Words only: no mechanism, no hard gate — map #50's split is
 * primitives + soft guidance, orchestration stays with the user.
 *
 * Everything here works with **no active scope bound** — that is the point of a
 * bootstrap surface. Errors take the `-31060..-31065` segment
 * (`errors.ts`); a posture failure reuses #19's `posture_refused` (−31004),
 * per the segment's one-condition-one-number rule.
 *
 * @module tools/scope
 */
import { realpathSync } from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/server'
import { loadConfig, resolveSemanticLayer } from '@semantic-grounding/substrate'
import { z } from 'zod'
import { assertScopeLoadable } from '../binding.ts'
import { ScopeNotFoundError, toToolErrorResult, DefinitionValidationError } from '../errors.ts'
import type { ServerDeps, ToolRegistrar } from '../server.ts'
import { ensureStartupPosture } from '../git/posture.ts'
import { toolSuccess } from './audited.ts'
import { layerCounts } from './guidance.ts'
import { ScopeIdSchema, type ToolFamily } from './shared.ts'
import { assertScopeIdShape, scopeEntryReachable } from '../scope-registry.ts'

/** The scope-management tool names, in ADR-0011's listing order plus `deregister_scope` beside its verb pair (#72). */
export const SCOPE_TOOL_NAMES = [
  'get_scope_scaffold',
  'register_scope',
  'deregister_scope',
  'list_scopes',
  'switch_scope',
  'get_scope',
] as const

/**
 * The content bootstrap line (ADR-0012 R4, five elements + two prohibitions —
 * wording ruled, canonical home here; ADR-0018 later appended the batch-import
 * clause so a remote agent discovers the dry-run preview). Self-contained on
 * purpose: no doc pointer to drift, no pipeline object to become a content
 * manual.
 */
export const SCOPE_SCAFFOLD_NEXT_STEPS =
  '语料为空是正常态：问数轨迹里词 miss（resolve_alias/search_definitions 空结果）时才注册——依据你读到的 DDL/文档 create_definition（资产词建表/事件并带 pref_label/alt_labels；无单一资产的域词建 concept；表经 update_definition 的 domains 挂概念；候选指标随宿主表/事件的 metrics 块内联写入，metric 层无独立写路径）→ 大批初始化走 import_definitions 单 commit 落盘、先 dry_run:true 预检覆盖面再真写（ADR-0018）→ 积累后 run_enrichment 派生关系 → get_enrichment_work/apply_enrichment 补标签。不预铺种子，不手写 corpus YAML。'

// ── get_scope_scaffold ───────────────────────────────────────────────────────────────

const GetScopeScaffoldInputSchema = z.object({
  scope_id: ScopeIdSchema,
  path: z.string().min(1).describe('Absolute path where the corpus repository will live (an absolute path is strongly preferred: under stdio the MCP client chooses the working directory).'),
})

/** Registers `get_scope_scaffold` — pure knowledge, zero side effects (errors are zod's alone). */
function registerGetScopeScaffold(server: McpServer, _deps: ServerDeps): void {
  server.registerTool(
    'get_scope_scaffold',
    {
      title: 'Get the scope scaffold',
      description: 'Zero-side-effect knowledge tool: the shell layout for a new scope corpus — directory skeleton, config.yaml template (carrying the scope_id), git init + first commit, then the register_scope call that enters it in the registry. You run the infrastructure half yourself in bash (this server manages the knowledge and registry layers, not infrastructure execution); the next_steps line is the content-half bootstrap for after the shell is live. scope_id 是持久身份（1:1 绑定 corpus 目录、随每个 Tier-2 commit 进 git trailer、注册面没有改名工具）——注册前与用户确认命名。',
      inputSchema: GetScopeScaffoldInputSchema,
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      try {
        const dir = input.path.replace(/\/+$/, '') || '/'
        const configTemplate = `scope_id: ${input.scope_id}\nproject:\n  name: ${input.scope_id}\n`
        const steps = [
          { order: 1, action: 'create the corpus skeleton', command: `mkdir -p ${dir}/tables ${dir}/events ${dir}/concepts` },
          { order: 2, action: `write ${dir}/config.yaml`, content: configTemplate },
          { order: 3, action: 'initialize the git repository (the corpus root must BE the repo root — every Tier-2 write is a commit)', command: `cd ${dir} && git init` },
          { order: 4, action: 'first commit (git user must be configured — the recorder authors every later commit)', command: `cd ${dir} && git add -A && git commit -m "scope shell: ${input.scope_id}"` },
          { order: 5, action: 'register the scope in this server\'s registry (the bootstrap door — there is no --corpus flag)', tool: 'register_scope', args: { id: input.scope_id, path: dir } },
        ]
        return toolSuccess({
          scope_id: input.scope_id,
          steps,
          config_template: configTemplate,
          validation: { checks: [
            'git rev-parse --show-toplevel from inside the corpus must name the corpus root itself',
            'the worktree must be clean at registration (posture refuses a dirty tree, recoverable lock residue excepted)',
            `config.yaml must carry scope_id: ${input.scope_id}`,
          ] },
          next_steps: SCOPE_SCAFFOLD_NEXT_STEPS,
        })
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

// ── register_scope ────────────────────────────────────────────────────────────────────

const RegisterScopeInputSchema = z.object({
  id: ScopeIdSchema,
  path: z.string().min(1).describe('The corpus repository root (absolute strongly preferred). Must be its own clean git repository — posture is checked at this door.'),
})

/** The scope-entry half of #45's five fields (constant 3): name from the corpus config, no free-form metadata. */
function corpusNameFor(semanticRoot: string, scopeId: string): string {
  try {
    const config = loadConfig(resolveSemanticLayer(semanticRoot)) as { readonly project?: { readonly name?: unknown } }
    const name = config?.project?.name
    if (typeof name === 'string' && name.trim() !== '') return name.trim()
  } catch {
    // A corpus that does not even parse here will fail the full-load door below
    // with the precise error; the name capture is not that door.
  }
  return scopeId
}

/** Registers `register_scope` — the single bootstrap door (ruling 3). */
function registerRegisterScope(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'register_scope',
    {
      title: 'Register a scope',
      description: 'Enter a corpus in the scope registry: resolves the real path, runs the startup posture check (own git repo, rooted there, clean tree — a refusal carries its remedy), fully loads the corpus (a broken config is refused here, not at first switch), then writes the 1:1 table entry. Idempotent: the same id + same real path registers once and answers already_registered. Does NOT switch (switch_scope is a separate, explicit act) and does not change the active default. scope_id 是持久身份：与 corpus 目录 1:1 双向绑定、随每个 Tier-2 commit 进 git trailer、注册面没有改名工具——先与用户确认命名再注册。',
      inputSchema: RegisterScopeInputSchema,
    },
    async (input, _ctx) => {
      try {
        assertScopeIdShape(input.id, m => new DefinitionValidationError(m))
        const semanticRoot = realpathSync(input.path)
        // Constant 2: posture + full load at the door, before the table is touched.
        // Posture failures surface #19's own coded posture_refused (−31004) with its
        // remedy — the segment rule is one condition, one number.
        await ensureStartupPosture({ corpusRoot: semanticRoot, agentId: deps.config.agentId, logger: () => {} })
        assertScopeLoadable(semanticRoot)
        const { entry, alreadyRegistered } = await deps.registry.register({
          id: input.id,
          semanticRoot,
          name: corpusNameFor(semanticRoot, input.id),
          registeredBy: deps.config.agentId,
        })
        return toolSuccess({
          scope: { id: entry.id, semantic_root: entry.semanticRoot, name: entry.name },
          already_registered: alreadyRegistered,
          active_unchanged: true,
        })
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

// ── deregister_scope ──────────────────────────────────────────────────────────────────

const DeregisterScopeInputSchema = z.object({
  scope_id: ScopeIdSchema,
})

/**
 * Registers `deregister_scope` — pure bookkeeping, the register door's mirror
 * (#72): removes the table entry, clears the next-process default when it names
 * the entry, and drops this process's live binding when it is serving it. The
 * corpus directory and its git history are untouched — old trailers stay fact.
 */
function registerDeregisterScope(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'deregister_scope',
    {
      title: 'Deregister a scope',
      description: 'Remove a scope from the registry: pure bookkeeping — no posture check, no corpus load, no git state, the corpus directory and its git history (old trailers naming the id) untouched. A dead entry (directory gone or moved) is removable exactly then — registration guards the door, deregistration is cleanup, the asymmetry is deliberate. When the registry\'s next-process default names this scope it is cleared along with the entry, and when this process is serving it the live binding is dropped too (later write tools answer no_active_scope; another process serving it keeps its own binding until its next switch). Naming an unregistered id is scope_not_found, not a silent ok — a typo\'d id should surface, not masquerade as a cleanup already done.',
      inputSchema: DeregisterScopeInputSchema,
    },
    async (input) => {
      try {
        const { entry, activeCleared } = await deps.registry.deregister(input.scope_id)
        const bindingCleared = deps.bindings.clearIfActive(input.scope_id)
        return toolSuccess({
          removed: { id: entry.id, semantic_root: entry.semanticRoot, name: entry.name },
          active_cleared: activeCleared,
          binding_cleared: bindingCleared,
        })
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

// ── list_scopes ───────────────────────────────────────────────────────────────────────

/** Registers `list_scopes`. */
function registerListScopes(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'list_scopes',
    {
      title: 'List registered scopes',
      description: 'Every scope in this server\'s registry, with the active one marked. A scope whose directory has disappeared shows reachable:false — a visible dead entry, not an error (the registry keeps it until explicitly re-registered elsewhere).',
      inputSchema: z.object({}).strict(),
      annotations: { readOnlyHint: true },
    },
    async () => {
      try {
        const state = deps.registry.read()
        const activeId = deps.bindings.activeScopeId() ?? state.active
        const scopes = [...state.scopes.values()].map(entry => ({
          id: entry.id,
          semantic_root: entry.semanticRoot,
          name: entry.name,
          is_active: entry.id === activeId,
          reachable: scopeEntryReachable(entry),
        }))
        return toolSuccess({
          scopes,
          active: activeId != null && state.scopes.has(activeId)
            ? { id: activeId, root: state.scopes.get(activeId)!.semanticRoot }
            : null,
          total: scopes.length,
        })
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

// ── switch_scope ──────────────────────────────────────────────────────────────────────

const SwitchScopeInputSchema = z.object({ scope_id: ScopeIdSchema })

/** Registers `switch_scope` — the atomic pointer swap, exposed. */
function registerSwitchScope(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'switch_scope',
    {
      title: 'Switch the active scope',
      description: 'Bind this process to another registered scope: looks the id up, re-runs posture on its directory (cheap, and catches a corpus moved or dirtied since registration), lazily constructs the per-scope core+recorder on first bind, then swaps the active pointer atomically and updates the registry\'s next-process default. In-flight requests keep serving the scope they bound at entry — their writes, trailers and response stamps stay truthful to the old scope; only later calls see the new one.',
      inputSchema: SwitchScopeInputSchema,
    },
    async (input) => {
      try {
        const result = await deps.bindings.switchTo(input.scope_id)
        return toolSuccess({
          scope: { id: result.binding.scopeId, name: deps.registry.getEntry(result.binding.scopeId)?.name ?? result.binding.scopeId, semantic_root: result.binding.semanticRoot },
          switched_from: result.switchedFrom,
          counts: result.counts,
        })
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

// ── get_scope ─────────────────────────────────────────────────────────────────────────

const GetScopeInputSchema = z.object({
  scope_id: ScopeIdSchema.optional().describe('The scope to describe; omit for the active one.'),
})

/** Registers `get_scope`. */
function registerGetScope(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'get_scope',
    {
      title: 'Describe one scope',
      description: 'One registry entry with its registration facts. Omitting scope_id describes the active scope and adds definition counts by layer (counts.dw = tables+events, counts.kg = concepts — the serving snapshot\'s counts, the same derivation guidance/playbook read); naming a non-active scope describes the registry entry only (no corpus load happens for a scope you are not serving).',
      inputSchema: GetScopeInputSchema,
    },
    async (input) => {
      try {
        const activeId = deps.bindings.activeScopeId()
        const scopeId = input.scope_id ?? activeId
        if (scopeId === undefined) {
          throw new ScopeNotFoundError('no scope named and no active scope to default to — list_scopes shows what is registered', { remedy: 'pass scope_id, or switch_scope first' })
        }
        const entry = deps.registry.getEntry(scopeId)
        if (entry === undefined) {
          throw new ScopeNotFoundError(`scope "${scopeId}" is not in the registry`, { scope_id: scopeId, remedy: 'register_scope it first' })
        }
        const isActive = scopeId === activeId
        return toolSuccess({
          scope: { id: entry.id, name: entry.name, semantic_root: entry.semanticRoot, registered_at: entry.registeredAt, registered_by: entry.registeredBy },
          is_active: isActive,
          reachable: scopeEntryReachable(entry),
          // The snapshot's stamp for the active scope: what this process is actually
          // serving right now (ADR-0011's response layer), not just the table entry.
          ...(isActive
          ? {
              serving: { id: scopeId, root: entry.semanticRoot },
              // The description's counts promise (#102 6a): the serving snapshot's
              // definition counts via `layerCounts` — the one count derivation,
              // shared with guidance/playbook, never forked.
              counts: layerCounts(deps.bindings.requireSnapshot()),
            }
          : {}),
        })
      } catch (e) {
        return toToolErrorResult(e)
      }
    },
  )
}

/** Registers all six scope-management tools (ADR-0011's five + #72's deregister). */
export const registerScopeTools: ToolRegistrar = (server, deps) => {
  registerGetScopeScaffold(server, deps)
  registerRegisterScope(server, deps)
  registerDeregisterScope(server, deps)
  registerListScopes(server, deps)
  registerSwitchScope(server, deps)
  registerGetScope(server, deps)
}

/** The scope-management family's descriptor card (#115): its names and registrar bound
 * in one place, for `tools/index.ts` to compose — never a second copy of either key. */
export const SCOPE_TOOL_FAMILY: ToolFamily = { names: SCOPE_TOOL_NAMES, register: registerScopeTools }
