# 研究：跨 agent 接力实测的执行方式可行性（#129）

- **票**：[#129](https://github.com/McKenzieIT/semantic-grounding/issues/129)（map [#125](https://github.com/McKenzieIT/semantic-grounding/issues/125) Destination ④）
- **基线**：worktree `research/relay-harness` @ `4745e83`，`pnpm -r build` 产物
- **日期**：2026-10-14
- **证据口径**：measure, don't infer —— 本文每条结论都来自本机实跑，命令与观测原样记录；未实跑的部分显式标注「未验证」。

---

## 0. Verdict

**接力实测可行，且本次已真实跑通一次完整 A→B 接力，外加一条跨宿主腿。**

| 问题 | 结论 |
|---|---|
| 两宿主 headless 驱动 sg-mcp | **都能**。`claude -p --mcp-config` 与 `codex exec -c mcp_servers.*` 均实测连上、实测调用 |
| B 的上下文隔离 | **`claude --bare` 实测挡住 CLAUDE.md**（同一目录对照：`--bare` 答 `NONE`，不带 `--bare` 吐出暗号）。但 `--bare` **仍读 `~/.claude/settings.json` 的 env 块** |
| 判定口径 | **轨迹 + 答案双断言**，两者本次都取到了结构化证据 |
| 门禁归属 | **不进四门禁**，独立 opt-in 脚本。实测一次接力 ≈ **$0.25**、**约 2 分钟**，且依赖外部模型服务 |
| 录制回放 | 可作门禁内的**退化替身**（钉工具面契约），但**不能替代**接力本身 |

**接力实测的核心结论**：在「语义层里只有一条口径记录、B 完全不知道 A 存在」的条件下，**B 自发调了 SG 读工具，并据此给出了正确口径**。Destination ④ 的判定范式成立。

**另有一项重大旁证（非本票范围，但必须开票）**：`create_definition` / `update_definition` **到不了 Claude Code 客户端**——服务端 `tools/list` 报 29 个，客户端只看到 27 个，被丢的恰是这两个。根因见 §6。

---

## 1. 两宿主的 headless 形态（实测）

### 1.1 Claude Code（claude 2.1.263）

```bash
claude -p --bare --model haiku \
  --mcp-config /tmp/sg-relay-probe/mcp.json --strict-mcp-config \
  --permission-mode bypassPermissions \
  --output-format stream-json --verbose \
  "<prompt>" < /dev/null
```

关键 flag（均以 `claude --help` 为准）：

| flag | 作用 |
|---|---|
| `-p, --print` | 非交互，打印后退出 |
| `--mcp-config <file>` | 从 JSON 载入 MCP server |
| `--strict-mcp-config` | **只用** `--mcp-config` 给的，忽略其它所有 MCP 配置 |
| `--bare` | 跳过 hooks / LSP / 插件同步 / auto-memory / 后台预取 / keychain / **CLAUDE.md 自动发现**；置 `CLAUDE_CODE_SIMPLE=1` |
| `--output-format stream-json` + `--verbose` | 逐事件 JSONL，含 `tool_use`、`system/init`、`result` |
| `--setting-sources <user,project,local>` | 控制载入哪些 settings（**隔离的第二把锁**，本次未单独实测） |
| `--no-session-persistence` | 会话不落盘（B 腿建议带上） |
| `--permission-prompts none` | 任何需要授权的操作直接拒绝（只读腿更安全） |

**坑 1：stdin**。不重定向会先等 3 秒 stdin（`Warning: no stdin data received in 3s`）；codex 更严重，**直接挂死**。两边都必须 `< /dev/null`。

**坑 2：`--bare` 的认证口径与 help 文案不符**。help 写 "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via --settings"，但本机 `ANTHROPIC_API_KEY` 未设置，仅靠 `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`（第三方 Anthropic 兼容网关）**实测可用**。即：`--bare` 不挡 `ANTHROPIC_AUTH_TOKEN`。

探针本身不把密钥写进任何文件，运行时从既有配置取：

```bash
export ANTHROPIC_AUTH_TOKEN=$(jq -r '.env.ANTHROPIC_AUTH_TOKEN' ~/.claude/settings.json)
export ANTHROPIC_BASE_URL=$(jq -r '.env.ANTHROPIC_BASE_URL' ~/.claude/settings.json)
```

### 1.2 Codex（codex 0.153.4）

```bash
codex exec --ephemeral --skip-git-repo-check -C /tmp/sg-relay-probe \
  -s read-only --json \
  -c 'mcp_servers.sg.command="node"' \
  -c 'mcp_servers.sg.args=["<repo>/packages/mcp/lib/bin.js","--agent-id","codex-probe","--registry","/tmp/sg-relay-probe/scopes.yaml"]' \
  "<prompt>" < /dev/null
```

| flag | 作用 |
|---|---|
| `--ephemeral` | 会话不落盘 |
| `--ignore-user-config` | 不载入 `$CODEX_HOME/config.toml`（**但认证仍走 CODEX_HOME**） |
| `-C <dir>` / `--skip-git-repo-check` | 指定工作根 / 允许在非 git 目录跑 |
| `-s read-only` | 沙箱只读（B 腿天然适配） |
| `--json` | JSONL 事件流 |
| `-c mcp_servers.<name>.*` | **命令行注入 MCP server**，无需改 config.toml |

**坑 3：`--ignore-user-config` 与认证互斥（本机）**。带上它 → `401 Unauthorized`（`wss://api.openai.com/v1/responses`）；去掉它 → 正常跑通。本机的可用 provider 配置就在 `config.toml` 里，一刀切忽略会把认证一起砍掉。**隔离与认证在 codex 侧需要手工权衡**（可行解：`--profile` 另起一份干净 profile，未验证）。

---

## 2. 上下文隔离（实测对照）

同一目录放 `CLAUDE.md`（内含暗号 `PURPLE-ELEPHANT-7788`），同一个问题，只差 `--bare`：

| 命令 | 输出 |
|---|---|
| `claude -p --bare ... "有暗号就只输出暗号，没有就输出 NONE"` | `NONE` |
| `claude -p ... （同问题，不带 --bare）` | `PURPLE-ELEPHANT-7788` |

**结论：`--bare` 确实切断 CLAUDE.md 这条泄漏路径**，这是 B 腿隔离的主力开关。

**但 `--bare` 不是全隔离**：同一次运行里，`--model haiku` 被解析成了 `GLM-5.2`（告警 `"GLM-5.2" isn't described by this version's model catalog`），而该映射只存在于 `~/.claude/settings.json` 的 `env` 块（`ANTHROPIC_DEFAULT_HAIKU_MODEL`），且我并未 export 它。**说明 `--bare` 仍在读用户 settings 的 env**。要做到更干净，需叠加 `--setting-sources`（限定来源）或换 `HOME`。

B 腿隔离清单（建议全开）：

1. `--bare`（挡 CLAUDE.md / hooks / auto-memory / keychain）
2. `--strict-mcp-config`（只认本次给的 SG，杜绝别的记忆类 MCP 混入）
3. 独立进程、**不带** `--continue` / `--resume`、`--no-session-persistence`
4. cwd 在 `/tmp` 沙箱（既无 CLAUDE.md 也无 AGENTS.md）
5. `--setting-sources` 收紧（消除 §2 的 env 残留）
6. 校验腿：B 的 prompt 里**不得**出现答案关键词（本次 B 的 prompt 只说「付费用户的渠道留存」，未提 `channel_id` / `server_id`）

---

## 3. 实测记录：一次完整接力

**沙箱**：`/tmp/sg-relay-probe`，语料 `/tmp/sg-relay-probe/corpus`（独立 git 仓），注册表 `--registry /tmp/sg-relay-probe/scopes.yaml`。**全程未读写 `~/.semantic-grounding/scopes.yaml`。**

### A 腿（写）

提示：注册 scope `probe`，并写一条带口径坑的表定义（关联用 `channel_id` 不用 `channel_name`；统计付费用户剔除测试服 `server_id=0`）。

观测（`out/A.jsonl`）：

- 工具轨迹：`register_scope` ×1 → `switch_scope` ×1 → `import_definitions` ×2
- `result`：`subtype=success turns=5 cost=$0.134769 dur=64.4s`
- **A 自述「本环境中没有 create_definition 工具」**，改用 `import_definitions`；首次因字段名 `name` 应为 `table_name` 报校验错，自行修正后成功

落盘审计（语料仓 `git log`）：

```
1e9d829 relay-probe <relay-probe@agents.corpus> | import_definitions(1/1 items (1 created, 0 updated)): 种子写入表 dws_pay_user_d 定义及口径注意事项
```

trailer：`X-SG-Tool: import_definitions` / `X-SG-Derivation: agent` / `X-SG-Confidence: 0.9` / `X-SG-Agent: relay-probe` / `X-SG-Scope: probe` / `X-SG-Files: 1` / `X-SG-Rounds: 1`。

→ **Tier-2 审计链在接力场景下完整成立**：作者 = agent id，口径以 commit 形式进 git。

### B 腿（读，同宿主、全新隔离会话）

提示（不含任何答案关键词）：「我要统计上个月付费用户的渠道留存……先查一下语义层里有没有相关表定义和口径说明，再告诉我：关联键用哪个字段？统计付费用户有没有要注意的坑？」

观测（`out/B.jsonl`）：

- 工具轨迹：`list_scopes` ×1、`search_definitions` ×3、`list_definitions` ×1、`get_definition` ×1、`get_relations` ×1、`resolve_alias` ×1（9 turns，$0.118377）
- 答案命中：`channel_id`（且复述了「名称会重复」的理由）、`server_id = 0` 测试服剔除
- **额外观测**：B 主动报告该定义「审核状态还是 draft（未确认）」——即 #127 盘出的休眠槽 `confirmation.status`。**这个字段已经在影响 agent 的表述**，对 #130 的「确认事实 vs 经验」分层是现成的抓手
- B 还自行区分了「语义层明确记录的（权威口径）」与「描述之外的合理推断（供参考，语义层没写）」——**agent 自发做了事实/推断分层**

### C 腿（读，跨宿主 codex）

提示：「用 sg 这个 MCP 服务查语义层：付费用户表关联渠道维表该用哪个字段？……只答结论。」

观测（`out/C2.jsonl`）：

- MCP 工具调用：`sg/list_mcp_resources` ×1、`sg/search_definitions` ×2（均 `status=completed`）
- 最终答案：**「用 `channel_id`，不要用 `channel_name`（名称会重复）。」**
- reasoning 事件里明确写出「The search results clearly show the answer…」

→ **跨厂商接力成立**：A 用 Claude Code 写的口径，codex 在独立会话里经 SG 读到并复用。

---

## 4. 判定口径（rubric）

**双层断言，两层都要过**：

**第一层 · 轨迹（机械可判）**，从 JSONL 提取：

```bash
# claude
jq -r 'select(.type=="assistant") | .message.content[]? | select(.type=="tool_use") | .name' B.jsonl
# codex
jq -r 'select(.type=="item.completed") | .item | select(.server) | "\(.server)/\(.tool)"' C.jsonl
```

- 必要条件：B 至少调用一次 SG 读工具（`search_definitions` / `get_definition` / `list_definitions` / `get_join_path`）
- 反向条件：B 未经任何工具就「凭空答对」→ **判负**（说明答案泄漏在 prompt 或宿主上下文里）

**第二层 · 答案（关键词 + 反关键词）**：

- 正向：答案含 `channel_id`、`server_id=0`/`测试服`
- 反向：答案**不得**把 `channel_name` 当作可用关联键
- 建议升级为 LLM-judge 或 Genie benchmarks 式「标准 SQL 对照」（#126 借鉴项），纯关键词在口径复杂时会脆

**非确定性**：单次通过不算数。建议 **N=5，通过率 ≥ 4/5** 作为门槛；记录每次的工具轨迹差异（本次 B 用了 6 种工具 9 轮，换一次可能只用 2 轮——**轨迹数量不可断言，只断言「是否调用过读工具」**）。

**分层判定（建议）**：

| 层级 | 断言 | 性质 |
|---|---|---|
| L0 | A 的写在语料仓产生了带 trailer 的 commit | 确定性，可进门禁 |
| L1 | B 的轨迹里出现 SG 读工具 | 半确定性 |
| L2 | B 的答案命中口径关键词 | 非确定性，需 N 次通过率 |
| L3 | B 的答案在跨宿主下同样命中 | 非确定性，成本最高 |

---

## 5. 成本与门禁归属

实测成本（本机第三方网关计价）：A 腿 $0.1348 / 64s，B 腿 $0.1184 / 9 turns，**一次完整接力 ≈ $0.25、约 2 分钟**（codex 腿另计，未取到 cost 字段）。

**裁决建议：不进四门禁**，理由三条：

1. **依赖外部模型服务**：401、网关限流、模型目录不识别（本次 `GLM-5.2` 告警）都会把门禁染红，而这些与本仓代码无关——违反 #81 立下的「环境性红只能 skipIf，不进台账」范式
2. **非确定性**：L2/L3 本质是通过率断言，门禁要的是确定性
3. **成本与时长**：四门禁当前是秒级、零外部依赖

**推荐形态**：`packages/mcp/scripts/check-relay.ts`（opt-in，`pnpm relay`），CI 里只在打标签/手动触发时跑。

**录制回放作为门禁内替身**：把本次 A/B 的 JSONL 固化成 fixture，在门禁里只回放「B 发出的 MCP 请求序列 → 断言 SG 的响应仍包含那条口径」。这钉死的是**工具面契约不回归**（SG 该返回的内容还在返回），**不是** agent 行为。两者不可互相替代，应并存：门禁跑回放（确定性、免费），opt-in 跑真接力（证明 Destination ④）。

---

## 6. 旁证（**不在本票范围，建议另开 bug 票**）

**`create_definition` / `update_definition` 到不了 Claude Code 客户端。**

证据链：

1. A 腿里 agent 自述「本环境中没有 create_definition 工具」，被迫改用 `import_definitions`
2. `system/init` 事件里客户端可见的 SG 工具 **27 个**，缺的恰是 `create_definition`、`update_definition`
3. 直连 stdio 握手 `tools/list` → 服务端报 **29 个**，两者都在

→ **服务端没问题，丢在客户端边界。**

根因（schema 实测）：

```
create_definition.inputSchema 顶层 keys = ["$schema","oneOf","type"]   ← 顶层是 oneOf，没有 properties
update_definition 同形
两者 schema 体积 10.7KB / 11.0KB，是第三名 import_definitions(2.4KB) 的 4 倍余
```

工具 `input_schema` 需要是 `{"type":"object","properties":{…}}` 形；**顶层 `oneOf`（kind 判别联合 table|event|concept）不被接受，客户端静默丢弃该工具**。`import_definitions` 是扁平 object，所以活着。

**与 #102 的关系**：#102 把 dogfood 反馈「update_definition/create_definition 不存在」判为「过时构件（main 与 tarball 均在，不复现）」。本次实测**复现了**——因为「不复现」的验证方式多半是查服务端 tools/list（确实 29 个，确实都在）。**丢弃发生在客户端，服务端自检看不见。**

影响：远程 agent 在 Claude Code 下**无法使用主力写工具**，只能绕 `import_definitions`。这直接打击 map #125 ③「memory 读写面落地」与初始化体验。

附带 DX 观测：`import_definitions` 的表项字段是 `table_name` 而非 `name`，A 腿第一次就踩错；错误信息足够 agent 自愈，但多花一轮。

---

## 7. 推荐 harness 形状

```
packages/mcp/scripts/check-relay.ts        # opt-in，pnpm relay
  fixtures/relay/<scenario>.json           # 场景卡片（#128 产出）：A 的任务、B 的问题、判定关键词
  ├── setup()      mktemp 语料 + git init + 独立 --registry（永不碰真注册表）
  ├── legA()       claude -p --bare --strict-mcp-config ... → A.jsonl
  ├── assertL0()   语料仓 git log：commit 存在 + trailer 齐（确定性）
  ├── legB()       全新进程 + 隔离六件套 → B.jsonl
  ├── assertL1()   轨迹含 SG 读工具
  ├── assertL2()   答案命中/反命中关键词
  ├── legC()       可选：codex exec 跨宿主复跑 B 的问题
  └── report()     N 次通过率表 + 成本汇总
```

设计要点：

- **场景即数据**：scenario 文件来自 #128 的场景卡片，harness 本身不含业务知识
- **宿主可插拔**：`--host claude|codex`，两者只差「如何起进程 + 如何解析 JSONL」两个适配函数
- **先 L0/L1 后 L2**：L0/L1 便宜且确定，失败就不必烧 L2
- **沙箱铁律**：语料、注册表、HOME 全在 mktemp 下；`--registry` 必传；断言脚本自身校验「真注册表 mtime 未变」

---

## 8. 坑清单（按踩到顺序）

1. 两个 CLI 都必须 `< /dev/null`，否则等 stdin（codex 直接挂死到超时）
2. `--bare` 的 help 文案与实际认证口径不符（`ANTHROPIC_AUTH_TOKEN` 实测可用）
3. `--bare` 仍读 settings 的 `env` 块——隔离要叠 `--setting-sources`
4. codex `--ignore-user-config` 会连认证一起砍掉（本机 401）
5. 第三方网关的模型名不在客户端目录里 → 每次都有 `unrecognized_model` 告警（无害，但污染 stderr 断言）
6. **客户端静默丢弃顶层 `oneOf` 的工具**（§6）——服务端自检发现不了
7. `import_definitions` 字段名 `table_name` 易错写成 `name`
8. 本机 `~/.agents/skills/...` 下两个 SKILL.md YAML 非法，codex 每次启动都报 `failed to load skill`（与本仓无关，噪声）

---

## 9. 对 Destination ④ 的直接结论

- **可做，已做成一次**。A 用 Claude Code 写、B 在隔离会话里读到并改变行为、C 换厂商同样读到。
- **判定范式**：L0 确定性（git commit + trailer）+ L1 轨迹 + L2 答案关键词，N 次通过率。
- **门禁**：不进四门禁；门禁内放录制回放，真接力走 opt-in 脚本。
- **前置依赖**：#128 的场景卡片决定 L2 关键词；§6 的客户端丢工具问题会影响「A 怎么写」，应在落地票前解决或显式绕开。
