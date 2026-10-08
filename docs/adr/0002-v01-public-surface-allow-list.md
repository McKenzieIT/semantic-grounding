# ADR-0002: v0.1 公共 API 面是两级显式白名单

- **Status**: accepted
- **Date**: 2026-10-07
- **Deciders**: McKenzieIT
- **Ticket**: [slice 3: curate the v0.1 public API surface](https://github.com/McKenzieIT/semantic-grounding/issues/4)

## Context

在此之前 `package.json` 的 `exports` 带一条 `"./src/*": "./src/*"` 通配符，等于把整个
`src/` 目录当公共 API。实测它**在 workspace 之外根本不工作**：`files` 只声明
`lib/**`，`npm pack --dry-run` 产出 7 个文件（`package.json` + 6 个 `lib/`），`src/`
条目 0 个。它只在 `deepseek-harness-da`（下称 dsh）的 monorepo 内靠 tsconfig `paths`
+ workspace 软链生效，而 dsh 正是靠它深链了 **24 行、14 个文件、10 个模块**。

两个约束决定了这条规则的形状：

1. **本项目是面向 NL2SQL data agent 的独立语义层管理产品，dsh 是它的第一个 host，
   不是它的定义者。** 所以"只导出 dsh 用到的东西"这种措辞把宿主的 import 图当成了
   产品 API 的定义，方向是错的。
2. **把域对象从特定数仓约定解耦，是 map #1 明确圈为 out-of-scope 的多月后续工作。**
   但中心域对象今天确实耦合着一套约定——`TableDefinitionSchema` 里
   `engine: z.string().default('maxcompute')`（`src/types.ts:271`）、
   `kind: z.enum(['dws','dim'])` 是闭合 union（`:279`）、`freshness` 预处理中文字面量
   `静态参考`（`:284`）；还有 `enrichAllDwsTables`、`DimensionKeyPair{dws_column,
   dim_column}`、`buildExcludeColumns` 的 `['ds','pt','dt']` 等一整族。
   **导出它们，正是让那个解耦工作变成 breaking change 的原因。**

（术语：`exports` 是 package.json 里声明"这个包的哪些路径可以被 import"的字段，
subpath 指 `"."` / `"./llm-wiring-plugin"` 这种路径条目；barrel 指 `src/index.ts`
这种把多个模块的名字集中 re-export 的文件。）

## Decision

公共面是**两级**显式白名单，不是通配符：

| 级别 | 载体 | 管什么 |
|---|---|---|
| subpath | `package.json` 的 `exports` | 哪些**路径**可被 import |
| name | `src/index.ts` 的 re-export 清单 | `"."` 这个 barrel 里有哪些**名字** |

一个 name 或 subpath 公开，必须服务于**底座自身的域**（即 `GLOSSARY.md` 定义的概念），
且满足以下至少一条：

- **(a)** 在某个 host 有具名的活消费点（今天：dsh）；
- **(b)** 被已确认的 host 需求要求（今天：MCP 管理面，见 `docs/mcp-map-seed.md`）；
- **(c)** 实现某个文档化扩展点所必需（`DataSourceKindPlugin` / `SchemaProvider` /
  `Tier2Recorder` / `LlmCall`）。

**host 的消费是域需求的*证据*，不是域需求的*定义*。**

**加是 additive，删是 breaking**——所以举证责任在**加**的一侧。但本包目前未发布到任何
registry（`npm view` → E404）、无 git tag、版本 `0.1.6-alpha.2`，所以**删暂时还是免费的；
该窗口在首个稳定（非 alpha）发布时关闭。**

**约定耦合条款**：语义依赖特定数仓约定的名字（DWS/DIM 分层、MaxCompute 分区拼写、
中文语料字面量）在 v0.1 **不公开**，除非 (a) 成立。它们仍留在仓内可达，只是不在公共
路径上——删除是独立的后续工作。

### v0.1 的 subpath 白名单（3 条，逐条举证）

| subpath | 依据 |
|---|---|
| `"."` | (a) dsh 14 个生产文件消费 19 个根符号。具名例：`packages/data/tool-update-table-config/src/index.ts:47`（`updateTableMeta`）、`packages/eval/eval-cli/src/context.ts:19`（核心类）、`packages/data/evidence-query/src/index.ts:22`（`loadTables`/`loadEvents`/`loadMetricDefinitions` + 三个 schema）、`packages/eval/retrieval-experiment/src/graph-snapshot.ts:1-15`（三个 kind plugin + metrics + `RelationGraph`） |
| ~~`"./llm-wiring-plugin"`~~ | ~~(a) `packages/bundle/data-agent/cordis.patch.yml:180` 的 cordis mount 行~~ **已于 slice 4a 退役，见下方修订。** |
| `"./package.json"` | **无具名消费者**。保留理由是工具约定（resolver / bundler 会读它），且它不暴露任何代码 |

`"./src/*"` 删除。它在 tarball 里指向不存在的路径，删除把一个静默的 module-not-found
换成清晰的 `ERR_PACKAGE_PATH_NOT_EXPORTED`。

### 修订（slice 4a，2026-10-08）：白名单降为 **2 条**

[slice 4a](https://github.com/McKenzieIT/semantic-grounding/issues/9) 决定把
`llm-wiring-plugin` 搬进 dsh adapter，连带三个后果，记在这里是因为上表是规范性的：

1. **`"./llm-wiring-plugin"` 退役。** 它的全部依据是 (a) —— 那一条 cordis mount 行。
   plugin 搬进 adapter 之后，`cordis.patch.yml:180` 改指 adapter 自己的 subpath，
   底座这边不再有任何消费者，依据随之消失。白名单从 3 条变 **2 条**（`"."` +
   `"./package.json"`）。
   ⚠️ 顺带修正上表一处：该行当时写的是 `/src/llm-wiring-plugin.ts`，走的正是本 ADR
   **已删除**的 `./src/*` 通配 —— 所以它是「改写之后才成立」的依据，不是现成依据。
2. **`peerDependencies` 变空。** `schemastery` 和 `dsh-llm` 当时**只被这一个文件**真正
   import（其余提及全是注释，已逐一验证），`cordis` 则是 type-only。三条 optional peer
   全部删除；`cordis`/`schemastery` 作为 devDependency 留给那几个把 core 挂到真实
   host fiber 上跑的测试。
3. **`exports["."]` 完全未受影响。** 这一点专门验过，因为它本来是最大的风险：
   `TextLlm` 和 `wireEnrichmentLlm` 住在 `src/index.ts`（宿主中立），**不在** shell 文件里。
   删 shell 只带走 `name`/`inject`/`Config`/`apply` 这些 cordis 插件样板，它们只从
   `"./llm-wiring-plugin"` 这条 subpath 导出，从不在 root barrel 上。barrel 的 96 个
   运行时名字、148 个公共名字一个没动。

**给 name 级裁剪票的一条修正**（[slice 5](https://github.com/McKenzieIT/semantic-grounding/issues/7)）：
该票把 `TextLlm` + `wireEnrichmentLlm` 列为可砍候选，理由是「shell code, documented
against `ctx.llm`/`ctx.schema`」。shell 搬进 adapter 之后，**adapter 成了它们具名的活
消费者** —— 依据 (a) 成立，应当**保留**。

本修订**不改**本 ADR 的规则本身（两级白名单、(a)/(b)/(c)、举证责任在「加」的一侧、
约定耦合条款），只改 subpath 表的内容。

### 修订（slice 5，2026-10-08）：name 级白名单落地为 ADR-0003

本 ADR 说过「name 级裁剪不在本 ADR 的执行范围内，是独立一票，且必须排在 slice 4 之后」
——那一票已关闭：见 [ADR-0003](./0003-v01-root-barrel-name-allow-list.md)。规则零修改；
barrel 从 148 名裁到 67 名（含三条适用口径的明确化：(a) 只认生产消费、签名闭包属于公共
面、zod 子模型不公共），acceptance gate 从计数断言升级为精确名单断言。本 ADR 的 subpath
表（2 条）不变。

### 本次同时补上的 barrel 缺口

删掉通配符后，dsh 生产代码只有两簇符号会真的断，它们不在 barrel 里——已补入 `"."`：

- `tableKindPlugin` / `eventKindPlugin` / `conceptKindPlugin`（依据 (a)：
  `retrieval-experiment/src/graph-snapshot.ts:12-14`；依据 (c)：注册 kind 是本底座唯一
  的扩展点，组合自定义 registry 需要内置 kind 作为组合对象）
- `deriveMetricRelations` / `projectMetricCorpusItem`（依据 (a)：同文件 `:15`）

另按依据 (c) 补入三个类型——它们出现在公共签名里却没有导出，导致第三方**无法**实现
文档化的扩展点：`DerivedNodeContributor`（`registry.ts:85`，用于 `:175 derivedNodes?:`）、
`KindGrouping`（`registry.ts:107`，用于 `:181 grouping?:`）、`RelationEdge`
（`relation-graph.ts:12`，是公共 `getRelated()`/`getDerived()` 的返回类型）。以及
`UpdateEventMetaResult`（`io.ts:544`，补 `updateEventMeta` 已导出而其返回类型未导出的
不对称）。

`registerInvalidationHook`（`io.ts:85`）**刻意不补**，尽管 `invalidateCaches` 已导出。
map #1 的 Not-yet-specified 把 `_invalidationHooks` 标为 MCP 面唯一真实的多实例隐患
（全局广播 + 手动生命周期），现在导出它等于把已知隐患扩成公共 API。等该项毕业再定。

## Consequences

- **name 级裁剪不在本 ADR 的执行范围内，是独立一票，且必须排在 slice 4 之后。**
  原因是可验证性：dsh 今天经 `tsconfig.base.json:446` 直接解析到
  `packages/data/semantic-layer/src`，**它的 typecheck 根本不经过 `exports["."]`**，
  所以此刻砍掉任何名字都无法被任何 gate 证伪。slice 4 把 dsh 切到 tarball 之后，
  barrel 才真正成为解析路径，裁剪才可证伪。
- 窗口有硬截止：首个稳定发布之后，裁剪从免费变成 breaking。裁剪票必须在那之前落地。
- 约定耦合的名字暂时仍在公共面上（它们多数满足 (a)）。这是本 ADR 接受的已知债务，
  它的清偿路径是裁剪票 + 后续的约定解耦 map，而不是本次。
