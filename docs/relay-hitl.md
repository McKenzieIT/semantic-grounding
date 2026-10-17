# 接力实跑 HITL 清单(#157 · AFK 之外宿主侧不可脚本化的部分)

- **票**:[#157](https://github.com/McKenzieIT/semantic-grounding/issues/157)(map [#125](https://github.com/McKenzieIT/semantic-grounding/issues/125) Destination ④)
- **裁决来源**:[#156 resolution](https://github.com/McKenzieIT/semantic-grounding/issues/156)(三卡/载体/harness/契约替身/L0 按卡定表)、[#129 resolution](https://github.com/McKenzieIT/semantic-grounding/issues/129) 与 [research/relay-harness](https://github.com/McKenzieIT/semantic-grounding/blob/research/relay-harness/docs/research/relay-harness.md)(harness 实测与 8 条坑)、[ADR-0028](adr/0028-column-jargon-as-term-concepts.md) R4(E3 题目/对照组/L1/L2)、[#180 resolution](https://github.com/McKenzieIT/semantic-grounding/issues/180)(三卡宿主重排 + 人工 L3 证据格式)、[#179 resolution](https://github.com/McKenzieIT/semantic-grounding/issues/179)(G3′ 窗口断言判据改形)
- **性质**:真实接力 = 外部 LLM 服务 + 非确定性 + 每卡数十分钟;按 #129/#156 裁决**永不进四门禁**,只能在你(用户)的宿主机上跑。本清单是「你在 Mac 上实跑 `pnpm relay`」的精确步骤;跑完把结果工件回填 #157。

## 0. 跑什么(三卡一览,按 [#180](https://github.com/McKenzieIT/semantic-grounding/issues/180) R1 重排后)

| 卡 | 载体 | A 腿(写) | B 腿(读,N=5) | L3 | L0(确定性) |
|---|---|---|---|---|---|
| E3 | **k11 夹具复制 scope**(临时沙箱,自带给注册表) | `qodercli`(`--model Efficient`,机械执行) | `qodercli`(Auto,N=5,隔离会话) | **无**(per #180 R3) | 晋升 commit 仅 `X-SG-Evidence: source` |
| A3 | 同上 | `qodercli`(Efficient,`record_memory` practice) | `qodercli`(Auto,N=5) | **无** | `record_memory` commit 仅 `X-SG-Session` |
| G3′ | **真实 X63 scope `10000354`**(本机 per-user 注册表) | `qodercli`(Efficient,incident + valid_from/until) | `qodercli`(Auto,N=5) | **QoderWork 人工**(零配置摩擦;有效 L3 = qodercli 写 + QoderWork 读) | 同上(incident 永不升) |

E3 另跑**晋升前对照组**(ADR-0028 R4):同题、无概念语料,必须不过;任何一次对照组答对 → 该卡判 INVALID(换题)。

## 1. 前置(一次性)

1. **仓库**:本 commit 落 main 之后的工作副本;`pnpm install`;`pnpm -r build`(直跑 .ts 解析 workspace 依赖到 `lib/`,substrate 必须先建)。
2. **Node ≥ 22.18 / 24**(type-strip 直跑 `src/bin.ts`;sg-mcp 由脚本经 `node src/bin.ts` 拉起,无需 mcp 构建)。
3. **git** 可用(沙箱语料要 git init + baseline commit)。

## 2. 每条腿需要的 CLI / 认证 / env

**三卡 A/B 腿统一走 qodercli**(per #180 R1,claude/codex 两腿已退役)。L3 腿只在 G3′ 上以**人工 QoderWork 会话**完成,不消耗 CLI 预算。

### qodercli(脚本路径,A/B 所有腿 + 对照组)

- CLI:`qodercli`(1.1.28 实测口径;默认路径 `~/.qoder/bin/qodercli/qodercli`,不在则试 PATH,再不行 `export SG_RELAY_QODERCLI=<路径>`)。
- 认证即 **QoderWork 本机登录态**(两者独立产品,但共用本机账户)。
- 本脚本固定旗语:`--print --permission-mode bypass_permissions --output-format stream-json --no-session-persistence --mcp-config --strict-mcp-config`。
  - `--permission-mode bypass_permissions` 是 **#180 探针实证后的修正**(原版漏传 → 每条 SG 工具调用都被宿主以 `permission confirmation required` 拒绝,L1 假阳性)。
  - `--no-session-persistence` 让每次 B 跑都是全新会话(无 resume、无 session 持久化),N=5 隔离语义。
  - 无 `--verbose`(qodercli 1.1.28 不认,#180 已删)。
- **模型分档**(#180 R5):A 腿默认 `Efficient`(机械执行、档位不影响结果);B 腿与对照组**不设默认**,走 qodercli 的 `Auto` —— B 是被测对象,Destination ④ 证的是「agent 会不会主动经 SG 读」,降档会把「模型懒」误判成「memory 没用」;E3 的晋升前对照组须**不过**,模型太弱会因「什么都不会」而不过,对照失效。
  - `SG_RELAY_QODER_MODEL=<model>` 降级为**调试用的一刀切覆盖**:覆盖 B 腿 = **改变被测条件,结论不可直接对账 Destination ④**。首跑建议最小规模校准:`SG_RELAY_QODER_MODEL=Efficient pnpm relay --scenario g3 --runs 1`,模型过弱会使 L1/L2 因能力而非 SG 失败,首跑只作校准。
  - `SG_RELAY_QODER_FLAGS='--flag1 --flag2'` 追加任意旗语(调试)。
- **成本改读 credits**(qodercli 的 `total_cost_usd` 恒为 `0`;#180 R5):日志与结果工件里用 `credits`,不再打印美元。

### QoderWork(人工路径,仅 G3′ 的 L3)

- 宿主:QoderWork GUI(Mac 或当前 pod 都已装)。
- 认证即 GUI 登录态。
- **前提**:QoderWork 的 `~/.qoderwork/mcp.json` 已注册 `semantic-grounding`(不传 `--scope`,落注册表 `active:`);跑前确认 `active` = 目标 scope,且 MCP 子进程是 `pnpm -r build` 之后起的(§8)。
- **不消耗 CLI 预算**,跑完把证据按 §9 模板填回 `docs/relay-hitl.md`。

## 3. k11 夹具准备(E3/A3)

**无需准备**。脚本自动把 `packages/substrate/tests/fixtures/k11/` 复制进 `$(mktemp -d)` 沙箱、git init + baseline commit、并用**临时 scopes.yaml** 注册为 `k11-relay` —— 真注册表 `~/.semantic-grounding/scopes.yaml` 全程不被读写。

E3/A3 的跨会话隔离靠 qodercli 的 `--no-session-persistence` 保证(同宿主内跨会话,无需跨宿主;#180 R3)。

## 4. X63 / qodercli 配置(G3′)

1. 确认真注册表里有 X63:`grep 10000354 ~/.semantic-grounding/scopes.yaml`(即 QoderWork 侧 #151 初始化的那个 scope;没有则先在 QoderWork 侧完成注册)。
2. 目标表:脚本自动取该 scope 语料 `tables/` 下字典序第一个 `dws_*` 表;要指定就 `export SG_RELAY_G3_TARGET=<表名>`。
3. **G3′ 会写真实语料**:A 腿在 X63 corpus 落一条 **incident memory**(`memory/` 层,带 `valid_from=valid_until=2026-10-10`,**永不晋升、不碰任何定义指纹**)。
4. **跑完最后一步清理**(不自动执行 — 人工 L3 要读 A 写的那条):`pnpm relay --purge <本回合 A 写入的 mem-id>[,…]`。每条 id 经 card-signature 守卫(type=incident,valid_from/until 命中 G3_WINDOW)核对后才删;清的就是本回合 A 写入的 id(L3 清单已打印)。

## 5. 跑

```bash
pnpm relay                      # 三卡全跑(E3 → A3 → G3′)
pnpm relay --scenario e3        # 单卡
pnpm relay --scenario a3 --runs 5 --control-runs 3
pnpm relay --keep               # 保留沙箱(查 A/B 的原始 JSONL)
pnpm relay --purge <mem-id>[,…] # G3′ 跑完后清理 incident memory(见 §4 第 4 条)
```

- **N=5 语义**:每卡 A 写一次,B 以**全新隔离进程**问 5 次(每次都是独立会话,无 resume、无 session 持久化);**通过率 ≥ ⌈0.8·N⌉ = 4/5**。轨迹条数不可断言(#129),只断言「是否调用过 SG 读工具」。
- **判定**:L0(语料仓 git commit + trailer,确定性,不过即整卡 FAIL)+ 对照组全不过 + B 通过率 ≥4/5 → 整卡 PASS(G3′ 的 L3 = 人工 QoderWork,不进脚本通过率)。
- **宿主层拒绝 = 环境错,不是 FAIL**(#180 R4):B 腿任何一条 SG 工具调用被宿主以 `permission denied` / `approval required` 等文案拒绝 → 该次跑**不计入 N=5**,日志打 `ENV ERROR` 给修法(`--permission-mode bypass_permissions` 没传 / qodercli 升级改了权限语义)。与 SG 业务错误(如 `definition_not_found`)严格区分,后者仍计入轨迹、算「调了 SG」。
- 时长/成本量级:每卡 A 一次 + 对照组 3 次 + B 5 次 ≈ 9 次 CLI 调用(G3′ 另需人工 QoderWork 两次会话,A + B 各一);#180 探针实测两次 Efficient 共 0.618 credits。
- 逐腿 JSONL 与 stderr 落在沙箱 `out/` 目录(`--keep` 保留;路径见运行日志)。

## 6. 结果工件在哪、怎么用

| 工件 | 路径 | 去向 |
|---|---|---|
| 冻结 fixture(B 的 MCP 请求序列) | `packages/mcp/fixtures/relay/<id>.json` | **commit 进仓**——e2e 门禁 Phase 8 的回放腿由 skip 转 live |
| 结果工件(通过率/轨迹摘要/commit SHA/credits) | `packages/mcp/fixtures/relay/<id>-result.json`(git-ignored) | 全文粘进 #157 |
| A/B 原始 JSONL | 沙箱 `out/*.jsonl`(`--keep` 保留) | 排障用 |
| **G3′ 人工 L3 证据** | `docs/relay-hitl.md` §9 实跑记录表 | 入正典(格式见 §9) |

## 7. 跑完之后(闭环)

1. `git add packages/mcp/fixtures/relay/e3.json a3.json g3.json && git commit`(fixture 落地;G3′ 的 x63 fixture 也一并提交——门禁回放对它只打印 notice,不密闭重放)。
2. `pnpm e2e` 复跑:Phase 8 的 relay replay 从 skip 变 live(E3/A3 关键词重放命中;G3′ 打印不可密闭重放 notice)。
3. G3′ 人工 L3 在 QoderWork 上跑,按 §9 证据格式记回本文件 §9 表,同步贴进 #157 评论(每次一条)。
4. 跑完 `pnpm relay --purge <本回合 A 写入的 mem-id>[,…]` 清掉 G3′ 在 X63 真实语料上的测试 incident(详见 §4 第 4 条;只清本回合 A 写入的 id —— L3 清单已打印)。
5. 把三个 `<id>-result.json` 的内容(或摘要:L0 commits + 通过率 + credits)+ 语料仓 commit SHA 回填 #157 resolution。真接力的正典证据 = 这些工件 + §9 人工 L3 证据 + #129 已有的一次实跑记录。
6. 对账 map #125 Destination ①–④,关图。

## 8. 已知边界(勿在票外重复排查)

- **QoderWork 与 qodercli 是两套独立产品**(`~/.qoderwork/` vs `~/.qoder/`,会话/认证/`mcp.json` 互不共享):qodercli 跑的会话不出现在 QoderWork 里,反之亦然(#180 R1 判「跨宿主成立」的依据)。
- **`pnpm -r build` 后要重启宿主的 SG MCP 子进程**:常驻的 `node .../lib/bin.js` 不会热加载新构建(2026-10-16 QoderWork 的子进程起于前一日,`record_memory` 报 `Tool not found`);重启宿主或其 MCP 连接即可。
- **B 的 prompt 不含答案关键词**(脚本内固化);如果你手工改 prompt,把答案词带进去会直接判负(L1 反向条件)。
- **G3′ 窗口外腿判据**(已落代码,#179 resolution):g3-out-window 要求 B 至少一次读工具调用带 `data_window` ⊆ 09-01..09-30、且该调用返回**不含**事故 memory;原 `negative` 三词已清空。g3-in-window 不变。
- **`create_definition`/`update_definition` 在 Claude Code CLI 不可见(#132),在 qodercli 可见**(32 工具全在,#180 探针实证)。**E3 A 腿仍走 `import_definitions`** —— 理由换为规避判别联合形状的宿主风险,不依赖某单一宿主行为(见 [ADR-0028 Update 2026-10-16](adr/0028-column-jargon-as-term-concepts.md))。
- **宿主层拒绝误判 L1 假阳性**(已修,#180 R4):`--permission-mode bypass_permissions` 漏传曾是 L1 静默假阳性的根因;修后首次检出宿主拒绝即停机、归类环境错。
- **模型覆盖警告**:`SG_RELAY_QODER_MODEL=<model>` 覆盖 B 腿 = 改变被测条件,结论不可直接对账 Destination ④(§2 已说明)。首跑校准可用,正跑要关掉。

## 9. 人工 QoderWork 路径(G3′ 的 L3 = 唯一有效跨宿主路径)

按 #180 R1/R3,**G3′ 的 L3 现在是 QoderWork 人工**(脚本不再启动 L3 CLI),且人工结果**入正典**、格式固定。E3/A3 没有 L3 —— 它们的跨会话隔离由 qodercli 的 `--no-session-persistence` 在同宿主内保证,A3 的主线地位体现在 B 腿过 N=5。

**有效 L3 = qodercli 写 + QoderWork 读**(A 腿由脚本在 qodercli 上写一条 incident memory,B 腿由你在 QoderWork GUI 新会话里读)。两者会话/认证/`mcp.json` 互不共享 → B 答对则信息只可能来自 SG,构成「跨宿主」(#180 R1 判据;同属 Qoder 体系、模型目录同源,**证不了「跨厂商」** —— 该条由 #129 的 `codex exec` 实测作历史旁证,不复跑)。

**前提**:QoderWork 的 `~/.qoderwork/mcp.json` 已注册 `semantic-grounding`(不传 `--scope`,落注册表 `active:`);跑前确认 `active` = X63 scope `10000354`,且 MCP 子进程是 `pnpm -r build` 之后起的(§8 第 2 条)。

**做法**:
1. 跑 `pnpm relay --scenario g3`(脚本完成 A 腿写入 + B 腿 N=5)。日志末尾会打印 L3 清单 + A 写入的 memory id。
2. **在 QoderWork 开一个全新会话**,不得复用含 A 上下文的会话。
3. B 的 prompt 原样取 `packages/mcp/scripts/relay-scenarios.ts` 里 G3′ 的 `g3-out-window` 问题(把 `<G3_TARGET_TABLE>` 换成脚本发现的目标表,通常是 `dws_10000354_*` 字典序首张)。
4. B 的最终回复 + SG 工具调用逐条,按下方证据格式记回 §9 实跑记录表。
5. 跑完 `pnpm relay --purge <A 写入的 mem-id>` 清掉 incident memory(§4 第 4 条)。

**判定**:
- L0 = 语料仓 `git log -1 --format=%B` 查 trailer(脚本已判,日志打印)。
- L1 = 回复里是否调了 SG 读工具、是否带了 `data_window`、窗是否落在九月内、该调用返回是否**不含**事故 memory id(#179 新判据)。**排除的 memory id = 本回合 A 写入的那条**:脚本 B 腿已用 `bindWindowExclusion` 自动绑定同一 id(#184,此前卡上留空、断言实际休眠),日志 L3 清单里逐题打印「L1 窗口判据」行,人工按该行判,不另取 id。
- L2 = 按该卡 `allOf`/`anyOf`/`negative` 逐词对最终回复(`g3-out-window` 的 `negative` 已清空,#179)。
- **拿不到的**:N=5 通过率、对照组、`fixtures/relay/<id>.json` 的重放(三卡 fixture 已全部入库,e2e Phase 8 回放腿 live —— E3/A3 关键词重放命中,G3′ 打印不可密闭重放 notice,见 §7 第 2 条)。

### 人工证据格式(每条一次,贴本文件 §9 表 + #157 评论)

1. 语料仓 commit SHA + 当时注册表 `active` scope;
2. B 的 prompt 原文 + 最终回复原文;
3. **SG 工具调用逐条**:工具名、关键入参(尤其 `data_window` 的 from/to)、返回里是否出现锚定的 memory id;
4. L1 / L2 逐条判定,判据与脚本一致。

### 实跑记录

| 日期 | 卡 | 宿主 | 结果 |
|---|---|---|---|
| 2026-10-16 | G3′(X63 `10000354`,目标表 `dws_10000354_univ_acc_act_di`) | QoderWork 人工,A + B×2 各新会话 | **L0 PASS**(语料仓 `a2663d8`,memory `mem-20261016-r6kgxn5a`,仅 `X-SG-Session`、无晋升 trailer)· **窗口内 PASS**(L1 带 `data_window` 调 `get_definition`;L2 命中「未产出」「2026-10-10」)· **窗口外 L1 PASS / L2 FAIL**(旧判据)——B 为自证窗口过滤做了一次不带窗对照,并把事故原文写进最终回复,命中 `negative`(→ #179)。按 #179 新判据重判:窗断言未落代码时无法确证,**待 #181 落地后重判**(不重跑,见 #179 resolution) |
| 2026-10-17 | G3′(X63 `10000354`,目标表 `dws_10000354_univ_acc_act_di`;脚本腿 `pnpm relay --scenario g3` PASS 4/5 轮,repo `06c9adb`,fixture `acdfbb8`) | qodercli 写(A,`relay-g3-a`)+ QoderWork 人工读,B×2 各新会话 | **L0 PASS**(语料仓 `2556927`,memory `mem-20261017-h2hr3l24`,仅 `X-SG-Session`)· 注册表 `active` = `10000354`(L3 前由 `10000263` 手切,跑后切回;脚本清单第 2 行打印的是脚本自身 scope 而非真实 active → #186 第十件)· **窗口内 PASS**:`get_definition(table, data_window 2026-10-09..2026-10-12)` 返回含 `mem-20261017-h2hr3l24`;另 `search_definitions`×2、`get_definition(dwd_…_user_act_di, 同窗)` 不含;L1 过,L2 命中「未产出」「2026-10-10」· **窗口外 PASS**(#184 绑定后首次人工判):`get_definition(table, data_window 2026-09-01..2026-09-30)` 返回无 `memories` 键、不含该 id → L1 过;B 随后不带窗自证对照一次(含该 id,#179 部分泄漏允许);L2 无关键词要求 · 证据取自 QoderWork 会话记录 `~/.qoderwork/projects/…mvc8kmn3yr9slds9/17515316-….jsonl`(B1)与 `…mvc97epw41x89zmg/ce622d33-….jsonl`(B2),SG 调用经 `qw_mcp_call` 包装 · **旁注**:两个 B 都用 MaxCompute 实数核验——10-10 分区实际存在(1,302 账号,上游 DWD 全天 55,799 行),判定该 incident「与实数不符、不建议排除」。这是卡片在**真实语料**上植入的虚构事故被如实戳穿,不影响判定(L3 判的是信息只可能经 SG 跨宿主到达 B——B1 原文引用了 memory id 与正文);B 均提议写回更正 memory,人工未授权、零写入 |

*(§9 表随每次人工实跑追加;每条对应一次 QoderWork 会话的证据。)*
