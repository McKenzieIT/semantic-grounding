# Semantic Grounding

面向第一次接入的使用者。本项目是一个 MCP server（`packages/mcp`，可执行名 `sg-mcp`），
把 semantic-grounding 的 scope（数仓语义层 + 知识图谱双层语料）暴露给 agent：读查询走
问数工具，每一次写都落成 scope 语料库里的一个 git commit（Tier-2 审计，作者=agent）。
包是 `private` 未发布，接入方式 = clone + build + 注册本地可执行路径。

## 前置

- **Node ≥ 22.18**（直跑 `.ts` 依赖 Node 免 flag 的类型剥离；若用 build 产物
  `lib/bin.js`，无类型剥离要求，但建议同样版本档位）。`node --version` 确认。
- **pnpm**（monorepo 两包：`packages/substrate` + `packages/mcp`）。
- **git 可用且 user 已配置**：scaffold 的首次 commit 由你在 bash 里执行，以当前 git
  user 落款；此后 recorder 写的每条 commit 显式携带 agent/server 身份（作者=agent，
  committer=server，经 `GIT_AUTHOR_*`/`GIT_COMMITTER_*` 传递），但 git 本体必须在 PATH 上。

安装与构建（**两条启动路径都需要**——直跑 `.ts` 也要 substrate 的 `lib/` 先存在，
否则 `ERR_MODULE_NOT_FOUND`）：

```bash
git clone <本仓库> && cd semantic-grounding
pnpm install
pnpm -r build
```

## 注册模板

包未发布，`command` 固定是 `node`，`args` 里给本机 clone 的**绝对路径**（Windows 下
正斜杠即可）。两种启动方式二选一：

直跑 `.ts`（免 build mcp 自身，需 Node ≥ 22.18）：

```json
{
  "mcpServers": {
    "semantic-grounding": {
      "command": "node",
      "args": [
        "<仓库绝对路径>/packages/mcp/src/bin.ts",
        "--agent-id", "your-agent"
      ]
    }
  }
}
```

build 后（`pnpm -r build` 之后的产物）：

```json
{
  "mcpServers": {
    "semantic-grounding": {
      "command": "node",
      "args": [
        "<仓库绝对路径>/packages/mcp/lib/bin.js",
        "--agent-id", "your-agent"
      ]
    }
  }
}
```

flag 面以 `--help` 输出为准（权威清单是 usage()，`packages/mcp/src/config.ts`），每个都有
对应环境变量（**flag 优先于 env**；宿主注册面只暴露 env 时可 env-only 注册——已在真宿主
实测过，见 `docs/mcp-dogfood.md`）：

| flag | env | 必填 | 说明 |
|---|---|---|---|
| `--agent-id <id>` | `SG_AGENT_ID` | 是 | 写入 agent 的身份，记为每条 commit 的作者（ADR-0004） |
| `--scope <id>` | `SG_SCOPE` | 否 | 启动时急绑该 scope，不可服务则 exit 78 |
| `--registry <path>` | `SG_REGISTRY` | 否 | scope 注册表，缺省 `~/.semantic-grounding/scopes.yaml` |
| `--lock-timeout-ms <n>` | `SG_LOCK_TIMEOUT_MS` | 否 | 写等待语料锁的时长，缺省 10000 |
| `--mass-update-warn-threshold <n>` | `SG_MASS_UPDATE_WARN_THRESHOLD` | 否 | count 守卫阈值：批内 `updated` 超过即 WARN 并标注 commit subject（ADR-0018；软信号不拒写，缺省 50） |
| `--mass-update-ratio-threshold <f>` | `SG_MASS_UPDATE_RATIO_THRESHOLD` | 否 | 占比守卫触发点：单 kind `updated/existing` 超过即 WARN（ADR-0019 R6；(0,1] 小数，缺省 0.5） |
| `--mass-update-ratio-floor <n>` | `SG_MASS_UPDATE_RATIO_FLOOR` | 否 | 占比守卫小语料下限：某 kind 的 existing 少于它时占比守卫静默（缺省 10，小语料归 count 守卫管） |

没有 `--corpus`：新语料唯一入口是 `register_scope` 工具（ADR-0011 裁决 3）。退出码：
64 = 调用形状错（改注册 JSON），78 = 部署不可服务（改注册表或语料库），1 = server
自身 bug。

## 自检

客户端显示**零工具**时，先确认而非怀疑——banner 的设计用途就是这个
（`packages/mcp/src/main.ts` 头注释）。本地直接起一次看 stderr：

```bash
node <仓库绝对路径>/packages/mcp/src/bin.ts --agent-id check
```

正常会看到（stdin 保持打开即服务中；`< /dev/null` 让它起完即退）：

```
[semantic-grounding] @semantic-grounding/mcp 0.0.1 serving MCP over stdio
[semantic-grounding]   registry:  C:\Users\you\.semantic-grounding\scopes.yaml
[semantic-grounding]   scope:     (none — definition tools answer no_active_scope until switch_scope)
[semantic-grounding]   agent:     check
[semantic-grounding]   tools:     29
```

- `registry:` 行核对实际解析的注册表路径（`--registry`/`SG_REGISTRY` 拼错在这里现形）；
- `scope:` 行显示启动绑定的 scope 或显式的「无」；
- `tools:` 行是**工具总数**（默认面 29，权威显示即此行）。

连上客户端后调 `tools/list`，应报 **29** 个工具（catalog 单测与 e2e 两道门对账
`tools/list ≡ TOOL_NAMES`，`packages/mcp/src/tools/index.ts`；工具总数的权威显示是
上面 banner 的 `tools:` 行，两边对不上即是漂移）。引导用的
`create_definition` / `update_definition` / `register_scope` / `get_scope_scaffold` 都
应出现在列表里。**自检只想看 banner 时，建议临时 `SG_REGISTRY` 指向一个临时文件**，
避免在真注册表里留下测试痕迹。

## 初始化路径一览

一段话（细则在 ADR）：**`get_scope_scaffold`**（零副作用，返回建壳步骤：mkdir +
config.yaml 模板 + `git init` + 首次 commit + 注册调用）→ 你在 bash 里把基础设施半边
跑完 → **`register_scope`** 进注册表（posture + 全量加载校验；幂等，不自动切换）→
**`switch_scope`** 绑定为 active → 内容半边按轨迹驱动冷启动：查询遇到词 miss 时依据
DDL/文档 **`create_definition`**，不预铺种子（ADR-0012）→ **`get_initialization_playbook`**
看进度（scope_registration → seeding → backfill → llm_supplement → mature 五阶段，
DW/KG 双层独立计，ADR-0014）。设计出处：[ADR-0011](docs/adr/0011-scope-management.md)
（scope 管理与初始化路径）、[ADR-0014](docs/adr/0014-initialization-phase-model.md)
（初始化阶段模型）。

## 文档分工

- 本 README：上手指南（前置、注册、自检、初始化路径）。
- [`docs/mcp-dogfood.md`](docs/mcp-dogfood.md)：真 agent 挂 stdio 的**实测记录**
  （宿主行为、era 判定、写回路副作用、发现的问题），接入后遇到宿主怪相先查这里。
- [`docs/multi-machine-corpus.md`](docs/multi-machine-corpus.md)：多机合账指南
  （多台机器共享同一语料库时的对账与并发约定）。
