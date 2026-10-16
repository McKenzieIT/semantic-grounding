# 接力实跑 HITL 清单(#157 · AFK 之外宿主侧不可脚本化的部分)

- **票**:[#157](https://github.com/McKenzieIT/semantic-grounding/issues/157)(map [#125](https://github.com/McKenzieIT/semantic-grounding/issues/125) Destination ④)
- **裁决来源**:[#156 resolution](https://github.com/McKenzieIT/semantic-grounding/issues/156)(三卡/载体/harness/契约替身/L0 按卡定表)、[#129 resolution](https://github.com/McKenzieIT/semantic-grounding/issues/129) 与 [research/relay-harness](https://github.com/McKenzieIT/semantic-grounding/blob/research/relay-harness/docs/research/relay-harness.md)(harness 实测与 8 条坑)、[ADR-0028](adr/0028-column-jargon-as-term-concepts.md) R4(E3 题目/对照组/L1/L2)
- **性质**:真实接力 = 外部 LLM 服务 + 非确定性 + 每卡数十分钟;按 #129/#156 裁决**永不进四门禁**,只能在你(用户)的宿主机上跑。本清单是「你在 Mac 上实跑 `pnpm relay`」的精确步骤;跑完把结果工件回填 #157。

## 0. 跑什么(三卡一览)

| 卡 | 载体 | A 腿(写) | B 腿(读,N=5) | L3 跨宿主 | L0(确定性) |
|---|---|---|---|---|---|
| E3 | **k11 夹具复制 scope**(临时沙箱,自带给注册表) | `claude -p --bare` | `claude -p --bare` 隔离会话 | `codex exec` | 晋升 commit 仅 `X-SG-Evidence: source` |
| A3 | 同上 | `claude -p --bare`(`record_memory` practice) | 同上 | `codex exec` | `record_memory` commit 仅 `X-SG-Session` |
| G3′ | **真实 X63 scope `10000354`**(本机 per-user 注册表) | `qodercli`(incident + valid_from/until) | `qodercli` | `claude -p --bare` | 同上(incident 永不升) |

E3 另跑**晋升前对照组**(ADR-0028 R4):同题、无概念语料,必须不过;任何一次对照组答对 → 该卡判 INVALID(换题)。

## 1. 前置(一次性)

1. **仓库**:本 commit 落 main 之后的工作副本;`pnpm install`;`pnpm -r build`(直跑 .ts 解析 workspace 依赖到 `lib/`,substrate 必须先建)。
2. **Node ≥ 22.18 / 24**(type-strip 直跑 `src/bin.ts`;sg-mcp 由脚本经 `node src/bin.ts` 拉起,无需 mcp 构建)。
3. **git** 可用(沙箱语料要 git init + baseline commit)。

## 2. 每条腿需要的 CLI / 认证 / env(#129 实测发现全记)

### claude 腿(E3/A3 的 A、B、L3;G3′ 的 L3)

- CLI:`claude`(2.1.263 实测口径);不在 PATH 时 `export SG_RELAY_CLAUDE=<路径>`。
- 认证:**`--bare` 不挡 `ANTHROPIC_AUTH_TOKEN`**(help 写死 API_KEY,实测 AUTH_TOKEN 亦可用);走第三方网关同时要 `ANTHROPIC_BASE_URL`。
- **隔离坑(关键)**:`--bare` 仍读 `~/.claude/settings.json` 的 env 块(#129 实测:`--model haiku` 被映射成 settings 里的模型)。本脚本默认叠 `--setting-sources ""`(六件套最干净形态),因此**认证必须在真环境变量里**:

  ```bash
  export ANTHROPIC_AUTH_TOKEN=$(jq -r '.env.ANTHROPIC_AUTH_TOKEN' ~/.claude/settings.json)
  export ANTHROPIC_BASE_URL=$(jq -r '.env.ANTHROPIC_BASE_URL' ~/.claude/settings.json)
  ```

  (若你的 token 只存在于交互登录态、拿不到环境变量,可用 `SG_RELAY_TIGHT=0` 退回「--bare 读 settings env」形态——隔离弱一档,先跑通再收紧。)
- 预检会直接报错指出缺哪个变量,不会静默跳过。
- 可选:`SG_RELAY_CLAUDE_MODEL=<model>`(不设则用账号默认)。

### codex 腿(E3/A3 的 L3)

- CLI:`codex`(0.153.4 实测口径);`export SG_RELAY_CODEX=<路径>` 可覆盖。
- 认证走 `$CODEX_HOME/config.toml` 里的 provider。**不要 `--ignore-user-config`**——#129 实测它会连认证一起砍掉(401);本脚本已按此不复带该 flag。
- `-s read-only` 沙箱,B 腿天然只读。

### qodercli 腿(G3′ 的 A、B)

- CLI:`~/.qoder/bin/qodercli/qodercli`(默认路径;不在则试 PATH 里的 `qodercli`;再不行 `export SG_RELAY_QODERCLI=<路径>`)。
- 认证即 QoderWork 本机登录态;#156 实测旗语与 `claude -p` 对齐(`--print` / `--output-format stream-json` / `--mcp-config` / `--strict-mcp-config` / `--model`)。
- 可选:`SG_RELAY_QODER_MODEL=<model>`;`SG_RELAY_QODER_FLAGS='--flag1 --flag2'` 追加旗语。

## 3. k11 夹具准备(E3/A3)

**无需准备**。脚本自动把 `packages/substrate/tests/fixtures/k11/` 复制进 `$(mktemp -d)` 沙箱、git init + baseline commit、并用**临时 scopes.yaml** 注册为 `k11-relay` —— 真注册表 `~/.semantic-grounding/scopes.yaml` 全程不被读写。

## 4. X63 / qodercli 配置(G3′)

1. 确认真注册表里有 X63:`grep 10000354 ~/.semantic-grounding/scopes.yaml`(即 QoderWork 侧 #151 初始化的那个 scope;没有则先在 QoderWork 侧完成注册)。
2. 目标表:脚本自动取该 scope 语料 `tables/` 下字典序第一个 `dws_*` 表;要指定就 `export SG_RELAY_G3_TARGET=<表名>`。
3. **G3′ 会写真实语料**:A 腿在 X63 corpus 落一条 **incident memory**(`memory/` 层,带 `valid_from=valid_until=2026-10-10`,**永不晋升、不碰任何定义指纹**)。不想要它长留时,再记一条 `supersedes {id, reason: outdated}` 即可退役(ADR-0023 R2 只追加)。
4. L3 腿用 claude 直连同一份真注册表(`--registry ~/.semantic-grounding/scopes.yaml --scope 10000354`),所以 G3′ 全跑通还需要 claude 认证就绪(见 §2)。

## 5. 跑

```bash
pnpm relay                      # 三卡全跑(E3 → A3 → G3′)
pnpm relay --scenario e3        # 单卡
pnpm relay --scenario a3 --runs 5 --control-runs 3
pnpm relay --keep               # 保留沙箱(查 A/B 的原始 JSONL)
pnpm relay --skip-l3            # 只跑 L0/L1/L2
```

- **N=5 语义**:每卡 A 写一次,B 以**全新隔离进程**问 5 次(每次都是独立会话,无 resume、无 session 持久化);**通过率 ≥ ⌈0.8·N⌉ = 4/5**。轨迹条数不可断言(#129),只断言「是否调用过 SG 读工具」。
- **判定**:L0(语料仓 git commit + trailer,确定性,不过即整卡 FAIL)+ 对照组全不过 + B 通过率 ≥4/5 + L3 跨宿主一次命中 → 整卡 PASS。
- 时长/成本量级:每卡 A 一次 + 对照组 3 次 + B 5 次 + L3 1 次 ≈ 10 次 CLI 调用;#129 实测单腿 $0.1–0.15 / 1–2 分钟,三卡全程约 30–60 分钟。
- 逐腿 JSONL 与 stderr 落在沙箱 `out/` 目录(`--keep` 保留;路径见运行日志)。
- **模型/成本旋钮**:`SG_RELAY_CLAUDE_MODEL` 管所有 claude 腿(`--model`);`SG_RELAY_QODER_MODEL` 管所有 qodercli 腿(轻量档见 `qodercli --list-models`,如 `Efficient` / `*-Flash`);**codex 腿无逐次覆盖**,模型由 `$CODEX_HOME/config.toml` 全局决定。首跑建议最小规模校准:`SG_RELAY_QODER_MODEL=Efficient pnpm relay --scenario g3 --runs 1 --skip-l3`。模型过弱会使 L1/L2 因能力而非 SG 失败,首跑只作校准。

## 6. 结果工件在哪、怎么用

| 工件 | 路径 | 去向 |
|---|---|---|
| 冻结 fixture(B 的 MCP 请求序列) | `packages/mcp/fixtures/relay/<id>.json` | **commit 进仓**——e2e 门禁 Phase 8 的回放腿由 skip 转 live |
| 结果工件(通过率/轨迹摘要/commit SHA/成本) | `packages/mcp/fixtures/relay/<id>-result.json`(git-ignored) | 全文粘进 #157 |
| A/B 原始 JSONL | 沙箱 `out/*.jsonl`(`--keep` 保留) | 排障用 |

## 7. 跑完之后(闭环)

1. `git add packages/mcp/fixtures/relay/e3.json a3.json g3.json && git commit`(fixture 落地;G3′ 的 x63 fixture 也一并提交——门禁回放对它只打印 notice,不密闭重放)。
2. `pnpm e2e` 复跑:Phase 8 的 relay replay 从 skip 变 live(E3/A3 关键词重放命中;G3′ 打印不可密闭重放 notice)。
3. 把三个 `<id>-result.json` 的内容(或摘要:L0 commits + 通过率 + L3)+ 语料仓 commit SHA 回填 #157 resolution。真接力的正典证据 = 这些工件 + #129 已有的一次实跑记录。

## 8. 已知边界(勿在票外重复排查)

- codex 腿 `--ignore-user-config` 与认证互斥(#129 坑 4)——脚本已不带它;若你本机 codex 无可用 provider,L3 可用 `--skip-l3` 先跑 L0–L2。
- 第三方网关模型名不在客户端目录 → 每次 `unrecognized_model` 告警无害(#129 坑 5)。
- `create_definition`/`update_definition` 在 Claude Code 客户端不可见(#132)——E3 的 A 腿 prompt 已按 #159 裁决走 `import_definitions` + `add_alias`/`add_relation`,不要改回 create_definition。
- B 的 prompt 不含答案关键词(脚本内固化);如果你手工改 prompt,把答案词带进去会直接判负(L1 反向条件)。
- **qodercli 1.1.28 不认 `--verbose`**(2026-10-16 实测 `error: unknown option '--verbose'`)——`qodercliArgs()` 仍带它,G3′ 的脚本路径当前跑不通(参数校验即退出、不触达语料);修复随 #180 定方案后落。
- **`pnpm -r build` 后要重启宿主的 SG MCP 子进程**:常驻的 `node .../lib/bin.js` 不会热加载新构建(2026-10-16 QoderWork 的子进程起于前一日,`record_memory` 报 `Tool not found`);重启宿主或其 MCP 连接即可。
- **QoderWork 与 qodercli 是两套独立产品**(`~/.qoderwork/` vs `~/.qoder/`,会话/认证/`mcp.json` 互不共享):qodercli 跑的会话不出现在 QoderWork 里,反之亦然。

## 9. 人工 QoderWork 路径(不经脚本)

2026-10-16 用户裁决:后续接力实测尽量只用 **QoderWork(人工)+ qodercli(脚本)**,不用 Claude Code / codex;三卡如何重新分派、人工结果算不算正典证据,见 #180。在那之前,人工路径作 sanity check:

- **前提**:QoderWork 的 `~/.qoderwork/mcp.json` 已注册 `semantic-grounding`(不传 `--scope`,落注册表 `active:`);跑前确认 `active` = 目标 scope,且 MCP 子进程是 `pnpm -r build` 之后起的(§8)。
- **做法**:A 腿、B 腿每一问**各开一个全新会话**(不得复用含 A 上下文的会话);prompt 原样取 `packages/mcp/scripts/relay-scenarios.ts`(G3′ 把 `<G3_TARGET_TABLE>` 换成脚本发现的目标表)。
- **判定**:L0 = 语料仓 `git log -1 --format=%B` 查 trailer;L1 = 回复里是否调了 SG 读工具;L2 = 按该卡 `allOf`/`anyOf`/`negative` 逐词对最终回复。
- **拿不到的**:N=5 通过率、对照组、`fixtures/relay/<id>.json`(e2e Phase 8 回放腿仍 skip)。

### 实跑记录

| 日期 | 卡 | 宿主 | 结果 |
|---|---|---|---|
| 2026-10-16 | G3′(X63 `10000354`,目标表 `dws_10000354_univ_acc_act_di`) | QoderWork 人工,A + B×2 各新会话 | **L0 PASS**(语料仓 `a2663d8`,memory `mem-20261016-r6kgxn5a`,仅 `X-SG-Session`、无晋升 trailer)· **窗口内 PASS**(L1 带 `data_window` 调 `get_definition`;L2 命中「未产出」「2026-10-10」)· **窗口外 L1 PASS / L2 FAIL**——B 为自证窗口过滤做了一次不带窗对照,并把事故原文写进最终回复,命中 `negative`(→ #179)。本轮按「两问同过」判 **FAIL**。旁证:`get_definition` 体感偏慢(→ #178) |
