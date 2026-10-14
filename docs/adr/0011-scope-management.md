# ADR-0011: scope 初始化——统一注册表、入口快照绑定、删除 `--corpus`

- **Status**: accepted
- **Date**: 2026-10-12
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0004（裁决 5 corpus root=repo root、裁决 9 identity/trailer）、
  ADR-0005（裁决 7 工具无 scope 参数的形状与精确例外）、
  [map #40](https://github.com/McKenzieIT/semantic-grounding/issues/40)、
  [#42](https://github.com/McKenzieIT/semantic-grounding/issues/42)（能力边界）、
  [#43](https://github.com/McKenzieIT/semantic-grounding/issues/43)（三层模型与缺口）、
  [#44](https://github.com/McKenzieIT/semantic-grounding/issues/44)（绑定模型与防线，
  两条被本票 supersede）、[#45](https://github.com/McKenzieIT/semantic-grounding/issues/45)
  （四轮 grilling + 实测，本 ADR 的 canonical 设计来源）、
  执行票 [#51](https://github.com/McKenzieIT/semantic-grounding/issues/51)、
  [#46](https://github.com/McKenzieIT/semantic-grounding/issues/46)（scaffold 内容深度接缝，
  常数 9 的接口留白）

## Context

#42 裁了能力边界（MCP 管知识层+注册层，agent 执行基础设施）；#43 给了三层模型（基础设施→
注册表→运行时）与真实缺口（注册层无工具支持）；#44 裁了绑定模型（server 绑注册表不绑目录）
与隔离防线（三层：读盖戳/写断言/切换 digest），但把「`--corpus` 向后兼容」与「注册表持久化
在成员 git dir 内」当作既定前提。#45 用源码一手（`@modelcontextprotocol/server@2.3.1` 的
`stdio.mjs`/`src-Cqbh3MYc.mjs`）加两套行为探针证明：**同连接的 `tools/call` 请求不互相
等待**——`StdioServerTransport.processReadBuffer` 同步逐条派发、协议层以脱管微任务调用
handler，下一条消息不等上一条办完就进 handler。v1 单 scope 下这个事实无可交错的全局可变
状态可暴露，`switch_scope` 一旦引入可变全局绑定，必须先定并发语义才能谈其余设计。#45 同时
用一份 ROI 盘点（输入变化：确认无用户、无需要保护的既有部署）推翻了 #44 的两个前提，产出
本 ADR 的十项裁决。

## Decision

| # | 维度 | 裁决 | 关闭的取舍 |
|---|---|---|---|
| 1 | 并发模型 | **入口快照绑定**：每个工具 handler 在入口同步（任何 `await` 之前）解析一次绑定快照 `{core, recorder, lock, scopeId}`，全程用快照，不重读；`switch_scope` = 单线程下天然原子的指针赋值；per-scope 实例进程生命周期缓存，切走不 dispose，统一在 `beforeExit` 清理。 | 全局请求 mutex（杀读并发，换不到东西——写本就靠 per-repo 文件锁串行）；静默期屏障（被慢读卡住，只买叙事干净）；「agent 反正逐条调用」（源码+行为双证伪） |
| 2 | 注册表锚点 | **唯一位置 `~/.semantic-grounding/scopes.yaml`**，`--registry` / `SG_REGISTRY` 可覆盖（测试隔离强制要求，兼作逃生口）。 | 成员 git dir 锚定（把集合级状态塞进任意一个成员——`sg-pending/`/`sg-write.lock` 是单库运行时状态的先例，被错误延伸到了集合级状态）；混合锚点（脑裂） |
| 3 | `--corpus` | **删除**。引导唯一门 = `register_scope` 工具调用。 | 兼容保留——ROI 不成立：兼容要保护的只有 e2e（本票本来就要改）+ dogfood 一次重注册 + 不存在的 CI；代价是永久双引导门（两套语义/冲突规则/四格矩阵），双门即双险 |
| 4 | `--scope` | 升格为**启动时 active scope id**：表中查 → posture → 绑定；不可服务时 `exit 78`（fail-fast 经此存活）。 | 自由文本标签（职能已被裁决 5 消灭）；对零 scope 场景报 usage error |
| 5 | trailer | **恒由 registry identity 派生**——注册即有 identity，`X-SG-Scope` 恒存在于每次写入的响应与 commit trailer。 | 「给 flag 才有」（标签存在与否取决于启动开关而非事实，不诚实） |
| 6 | 工具面 | **5 个新管理工具**（`get_scope_scaffold`/`register_scope`/`list_scopes`/`switch_scope`/`get_scope`）+ 既有 8 个提交类工具（`create_definition`/`update_definition`/`add_alias`/`remove_alias`/`add_relation`/`remove_relation`/`apply_enrichment`/`run_enrichment`）新增必填 `scope_id`，handler 入口与快照比对（`assertScopeMatch`，不一致 → `scope_mismatch`）；全部 definition 工具响应顶层盖快照戳 `scope:{id, root}`。 | #44 裁决三的直接落位：断言而非路由、单门而非双门、`create_definition` 免 `expected_version` 但不免 `scope_id` |
| 7 | 错误码 | scope 段 `-31060..-31065` 六码（见下表）；`register_scope` 的 posture 失败复用 `#19` 的 `posture_refused`（`-31004`）——段位表顺延，一条件一号码。 | 新开独立段位或把 posture 失败另编号（没有新语义，复用是诚实的） |
| 8 | substrate | **零改动**。per-scope `SemanticGroundingCore` 各自以静态根构造；`ScopeRegistryFile` 结构性实现 substrate 的 `ScopeRegistryLike`（`active`/`activeId`/`get`，鸭子类型），但**不**调用 `setScopeRegistry`。〔2026-10-13 终结注记（ADR-0017 / S1.6 / #86）：`ScopeRegistryLike` 与 `setScopeRegistry` 已整删——seam 保留面终结，per-scope core + BindingStore 是唯一且已验证的多 scope 机制，见文末 Update。〕 | 单 core + per-call `scopeId` 路由（要求 19 个工具 schema 全部携带路由参数，违反 ADR-0005 裁决 7 的工具无 scope 参数形状） |
| 9 | active 持久化 | 注册表顶层 `active:` 是**下一进程的缺省**，仅此而已：每个进程启动时读一次，此后活在内存；`switch_scope` 更新自己的绑定，顺手更新这个缺省。 | 运行时共享的 active（多进程互踩——"上次在哪"和"现在在哪"是两件事，前者才该共享，像 shell cwd） |
| 10 | scope id | 无默认 id；字符集 `^[a-z0-9][a-z0-9-]*$`，1–64 字符，`register_scope` 时显式给出。 | basename 启发式（魔法，且随 `--corpus` 删除失去了"从路径推一个默认值"的输入） |

**初始化路径**（Decision 的落地顺序）：`get_scope_scaffold`（零副作用知识，返回 shell 骨架：
mkdir + config.yaml 模板 + git init + 首次 commit + `register_scope` 调用，加
`next_steps` 一行指向内容冷启动——ADR-0012 R4 的五要素两禁止）→ agent 自己在 bash 里跑
基础设施半边 → `register_scope`（posture + 全量语料加载 + 1:1 双向校验写表，幂等：同
id+同 realpath → `already_registered`，不自动切换）→ `switch_scope`（posture 复检 + 懒
构造 + 原子置换 + 持久化缺省）。

**Supersede #44 两条**：「`--corpus` 可选·向后兼容」（裁决 3，输入变化 = 确认无用户）；
「注册表持久化在成员 git dir 内」（裁决 2，单库运行时状态先例被错误延伸到集合级状态）。

### 错误码段位

| code | name | 场景 |
|---|---|---|
| −31060 | `no_active_scope` | 无 active scope 时调用提交类工具；remedy 指路 `switch_scope` |
| −31061 | `scope_not_found` | `switch_scope`/`get_scope`/`--scope` 命名了未注册的 id |
| −31062 | `scope_id_conflict` | id 已绑定其他路径（`data.existing` 带原绑定） |
| −31063 | `scope_path_conflict` | 路径已绑定其他 id（`data.existing` 带原绑定） |
| −31064 | `scope_mismatch` | 写断言的 `scope_id` ≠ 入口快照的 active scope（`data` 带 `asserted_scope_id`/`active_scope_id`/remedy） |
| −31065 | `scope_unloadable` | posture 通过但语料加载失败（register 的全量加载门，或 switch 的 counts 计算） |

### 工具面规格

```
get_scope_scaffold(scope_id, path) → 知识工具，零副作用
  出：{scope_id, steps:[{order, action, command?, content?, tool?, args?}],
       config_template, validation:{checks}, next_steps}

register_scope(id, path) → 执行
  服务端：realpath → ensureStartupPosture（软拒绝带 remedy）→ assertScopeLoadable
          （全量加载）→ 锁内 1:1 双向校验写表
  出：{scope:{id, semantic_root, name}, already_registered, active_unchanged}
  幂等：同 id + 同 realpath → already_registered，无写
  错误：scope_id_conflict / scope_path_conflict / posture_refused(−31004 复用) /
        scope_unloadable

list_scopes() → 读
  出：{scopes:[{id, semantic_root, name, is_active, reachable}], active:{id,root}|null, total}
  reachable:false = 路径失效的死条目（可视别，不阻塞，不自动清理）

switch_scope(scope_id) → 执行
  服务端：表中查 → posture 复检（每次切换都复检，不管是否已缓存构造）→ 懒构造绑定
          → 原子置换 active → 持久化 registry 缺省
  出：{scope:{id, name, semantic_root}, switched_from:{id}|null,
       counts:{tables, events, concepts}}

get_scope(scope_id?) → 读
  省略 scope_id = 查 active（并带 serving 戳）；命名非 active 的 scope 只读表项，
  不加载语料（无 counts/serving）
  出：{scope:{id, name, semantic_root, registered_at, registered_by}, is_active,
       reachable, serving?:{id, root}}
```

## Consequences

- 现存语料接入 = 一次性 `register_scope` → `switch_scope` 舞步；dogfood 重注册一次；
  e2e 门禁改走真实 register 流（`scripts/check-e2e-loop.ts` Step 17）。
- `--corpus`/`SG_CORPUS` 从命令行与环境变量两处彻底移除；未知 flag（包括 `--corpus`
  本身）走统一的 strict-parse 拒绝路径，错误消息里带「corpora enter via the
  register_scope tool, not --corpus」的 remedy。
- 启动 flag 面收敛为四个：`--agent-id`（必填）/ `--scope <id>`（可选，eager bind，
  不可服务 `exit 78`）/ `--registry <path>`（默认 `~/.semantic-grounding/scopes.yaml`，
  主要用途是测试/e2e 隔离，不是生产旋钮）/ `--lock-timeout-ms`。
- 8 个提交类工具的参数 schema 新增必填 `scope_id`，是一次破坏性改形——旧的不带
  `scope_id` 的调用会被 zod 直接拒绝；本票同步更新了 `scripts/check-e2e-loop.ts`
  里全部六个工具名下的既有调用点。
- 不带 `--scope` 启动时，`X-SG-Scope` trailer 恒存在于每次 Tier-2 写（从 registry
  identity 派生，不再取决于启动是否带了某个 flag）；没有 active scope 时提交类工具
  统一答 `no_active_scope`（−31060），remedy 指向 `switch_scope`。
- substrate 包零改动：`ScopeRegistryFile` 结构性满足 `ScopeRegistryLike`，但
  `setScopeRegistry` 全程不被调用——per-scope core 各自以静态根构造，substrate 的
  registry 委托路径保持未挂载状态。〔2026-10-13（#86，ADR-0017 / S1.6）：委托路径已从
  substrate **删除**——「未挂载」升级为「不存在」；mcp 侧 `ScopeRegistryFile` 的
  `active()`/`activeId()`/`get()` dsh 兼容面同删，`restoreActive` 改 `read().active`。〕
- 内存：per-scope `{core, recorder}` 实例按进程生命周期驻留，切走不 dispose（k11
  量级约 5.5MB 解析物+图缓存/scope）。实例淘汰、`remove_scope`、运维级单 scope
  进程锁（`--lock-scope`）均列 Followup——各自需要一个尚未出现的触发条件（驻留
  成本成为实测问题 / 退役故事出现 / 运维需求出现），v1 不预做。
- 跨 OS 用户的注册表不一致是已知残留（表 per-user）：两个 OS 用户各自注册同一个
  repo 可能分配到不同的 id，和被否的「成员 git dir 锚定」方案处于同一量级的残留，
  不多不少，部署约束据实记录。
- #46 的接缝：`get_scope_scaffold` 的 `next_steps` 字段止于一行自包含文案（ADR-0012
  R4 五要素两禁止），不是文档指针（没有可指向又不会漂移的目标）也不是结构化
  pipeline 对象（那会让 scaffold 变成一份内容操作手册，违反常数 9 的接缝定位）。
- dsh 不受影响：全部改动在 `packages/mcp` 内（工具面、配置面、错误码），不改变
  substrate 的对外契约。

## Verification

- 单测（新增 4 个文件，`packages/mcp/tests/`）：
  - `scope-registry.spec.ts`——`ScopeRegistryFile` 的注册读写回、幂等、1:1 冲突两个
    方向及其错误数据形状、跨实例持久化、进程内 promise-chain mutex 下的交错注册、
    畸形注册表文件拒绝猜测（intranet-security）、`assertScopeIdShape`
    〔#149 已退役，见文末 Update〕/`scopeEntryReachable`。
  - `binding.spec.ts`——`BindingStore` 的 snapshot/requireSnapshot、`--scope` 启动
    绑定、`switchTo`（切换序列、registry 缺省持久化、counts、在途请求快照不可变、
    切回时的缓存复用、未注册 id 拒绝、目录转脏后的拒绝）、`restoreActive`
    （无缺省/可恢复/降级为无 active 三态）、`disposeAll`、`assertScopeLoadable`。
  - `scope-match.spec.ts`——`assertScopeMatch`（`src/tools/audited.ts`）的放行/拒绝
    /错误数据形状，补上此前全仓零覆盖的写门断言。
  - `scope-tools.spec.ts`——五个管理工具的 handler 级行为：`get_scope_scaffold` 的
    纯函数性与步骤顺序、`register_scope` 的幂等/两个 1:1 冲突/字符集先于 posture
    的拒绝顺序/posture 拒绝/`scope_unloadable`、`list_scopes` 的空表/死条目/
    active 区分、`switch_scope` 的未注册 id 拒绝、`get_scope` 的省略/未注册/
    非-active 不加载/serving 戳。
  - 全量 `pnpm run test`（21 个文件，含上述 4 个新文件与既有 17 个文件一起跑）：
    320 passed（320）。
- e2e（`scripts/check-e2e-loop.ts`）：Step 17 走 `get_scope_scaffold` → `register_scope`
  → `list_scopes` → `switch_scope` → `get_scope` 的真实 `tools/call` 序列；Step 18
  在真实 `sg-mcp`（`src/bin.ts`）子进程上验证 envelope 标记。全 18 步通过。
- 门禁：typecheck（0 错）、test（320/320）、acceptance（substrate 五段全绿，substrate
  零改动故本就不受影响）、e2e（18/18）全部确认绿。

## Update — #72：`deregister_scope` 落地（2026-10-13）

Consequences 把 `remove_scope` 列为带触发条件的 Followup（「退役故事出现」）；
[#69](https://github.com/McKenzieIT/semantic-grounding/issues/69) 的真实使用反馈
（agent 自造 id 注册后发现想改名，无干净退出路径——死表项只能手编
`~/.semantic-grounding/scopes.yaml`，恰好绕开本 ADR 的三层并发防线）就是那个触发
条件。[#72](https://github.com/McKenzieIT/semantic-grounding/issues/72) 经 grilling
五裁决落地 scope 家族第六工具 `deregister_scope`（tools/list 26→27，排在
`register_scope` 之后的动词对位）：

1. **工具面开**：注册/注销是同一生命周期的两半，补全不是「收敛」哲学的反例——
   本 ADR 收敛裁的是引导门与 flag 面（同一功能两个入口的风险）。
2. **纯注册表操作**：不跑 posture、不加载 corpus、不看 git 状态、零 corpus 写。
   注册门守卫（坏 corpus 不许进表）的**故意镜像不对称**：死表项的定义特征就是
   目录已没了（posture 自身的失败形状），注销必须恰好在此情形可用。corpus git
   历史里旧 trailer 命名旧 id 是事实，不改写；错名退出 = deregister +
   重新 register 新 id，1:1 的 id 半与 path 半都释放。
3. **`active:` 缺省连带清**：缺省指向被注销项时一并置 null——悬空缺省正是本票
   要清的死状态本身，一个便利指针（裁决 9：只是下一进程的缺省）不能挡住清理。
   响应报 `active_cleared`。
4. **本进程活绑定连带清**：`BindingStore.clearIfActive`——守卫单赋值，与裁决 1
   的原子指针置换同形状同原子性；清除后写工具答 `no_active_scope`（拒绝选项有
   单 scope 死锁：唯一注册项无处 switch；不碰选项则本进程继续写已除名 corpus）。
   裁决 1 的「活状态唯一变更点是 `switchTo`」注记相应改为两个变更点。实例缓存
   **不**淘汰（Consequences 的实例淘汰 Followup 维持，触发条件未到）；跨进程另一
   server 的活绑定按裁决 9 的分层触达不到（多进程协调是 map #50 的 out of
   scope）。
5. **幂等=报错**：注销不存在的 id 答 `scope_not_found`（−31061 复用，段位
   −31060..-31065 **不扩**、零新码）——与 `switch_scope`/`get_scope` 点名未注册
   id 同条件同码；`register_scope` 的 `already_registered` 是「同一 id+路径对」的
   收编语义，注销侧没有可比对的同一对，打错 id 必须浮出来而非静默 ok。成功响应
   回显 `removed:{id, semantic_root, name}`。

落点：`scope-registry.ts` 的 `deregister()`（promise-chain mutex + 跨进程锁内
读-改-写 + 原子替换，active 连带判定锁内完成）、`binding.ts` 的 `clearIfActive()`、
`tools/scope.ts` 的 `deregister_scope`（`SCOPE_TOOL_NAMES` 六名单一来源）。substrate
零改动；GLOSSARY 不动（五工具本无词条，工具面文档归本 ADR）。测试：
`scope-registry.spec.ts` +7（1:1 两半释放、缺省连带/保留、−31061、跨实例持久化、
mutex 交错不复活条目）、`binding.spec.ts` +4（清除后 `no_active_scope`、非匹配
不碰、缓存保留同实例、在途快照穿清可用）、`scope-tools.spec.ts` +5（含死条目
可清=裁决 2 的可观测、两连带清 serving 态同现、错名退出全流程）；e2e Phase 6.5
步内扩展为 scaffold→register→list→switch→get→deregister（21 步数不变），两连带清
在真 wire 一次观测。门禁：typecheck 双包 0 错；mcp 361 pass（7 存量失败逐一对上
#61 留档名单，零新增）；substrate 零改动（478/479，`read-count-probe` 超时 1 例经
干净 HEAD 复现同败，判环境性留痕）；e2e 21/21。

## Update — ADR-0017 / S1.6（2026-10-13）：裁决 8 的 seam 保留面终结

裁决 8 当年「substrate 零改动、`ScopeRegistryLike` 委托路径保留但不挂载」的形状，依赖的
前提是「substrate 级多租户可能启用」；[ADR-0017](./0017-first-party-frontend-exclusivity.md)
前提总纲（第一方前端独占，多 scope 服务由 mcp 层承担）使该前提失效，#86 将
`setScopeRegistry`/`ScopeRegistryLike`/scope-epoch 合成全链删除——**mcp 的 BindingStore +
per-scope core + `switch_scope` 是唯一且已验证的多 scope 机制**（本 ADR 裁决 1/6 的形状
未动）。连带：360 行 vendored dsh 桩（`tests/fixtures/scope-registry.ts`）与
`@deepseek-ai/cordis`/`@deepseek-ai/schemastery` 两 devDep 整删（`@deepseek-ai` 仓内
清零）；mcp `ScopeRegistryFile` 的 `active()`/`activeId()`/`get()` 兼容面删
（`restoreActive` 换 `read().active`）。substrate 测试基线 462→432（scope-delegation /
per-scope-read 两 spec 随被测机制整删，对账详 #86 resolution）。

## Update — #149（2026-10-15）：charset 门单点化，`assertScopeIdShape` 退役

裁决 10 的字符集门原由两半把守：schema 侧 `ScopeIdSchema` 自拼正则，注册表侧
`assertScopeIdShape`（本 ADR 落地时的 `scope-registry.ts:102`）在 handler 边界再校验一遍。
[#149](https://github.com/McKenzieIT/semantic-grounding/issues/149)（巡检 S5 单点化）把
规则收成单一家：正则本体只住 `scope-registry.ts` 的 `SCOPE_ID_PATTERN`（:58，常数 10 的
one home），`tools/shared.ts` 的 `ScopeIdSchema` 改为 import 该常数作 zod 门（消息文案
逐字不动）；`assertScopeIdShape` 函数本体随之退役，其 10 个直测 describe 同删——字符集
拒绝现在只发生在 schema 门，「字符集先于 posture」的拒绝顺序不变（mcp 基线
447+1skip→437+1skip）。上文 Verification 与 References 中的 `assertScopeIdShape` 系
历史提及，彼时为真，保留原样。

## References

- 设计来源：[#45](https://github.com/McKenzieIT/semantic-grounding/issues/45) 的
  resolution（四轮 grilling 记录、源码一手引用、两套行为探针的完整结果）
- 前置票：[#42](https://github.com/McKenzieIT/semantic-grounding/issues/42)（边界）/
  [#43](https://github.com/McKenzieIT/semantic-grounding/issues/43)（三层模型与缺口）/
  [#44](https://github.com/McKenzieIT/semantic-grounding/issues/44)（绑定模型与防线，
  两条被本票 supersede）
- 执行票：[#51](https://github.com/McKenzieIT/semantic-grounding/issues/51)
- 行为依据：`packages/mcp/src/scope-registry.ts:54`（`SCOPE_ID_PATTERN`，常数 10）、
  `:97`（`defaultRegistryPath`，裁决 2）、`:102`（`assertScopeIdShape`
  〔#149 已退役，见文末 Update〕）、`:114`
  （`ScopeRegistryFile` 类，三层并发防线的实现）、`:356`（`scopeEntryReachable`）、
  `packages/mcp/src/binding.ts:96`（`BindingStore` 类，裁决 1 的入口快照绑定与
  `switchTo` 原子指针置换）、`:306`（`assertScopeLoadable`，`register_scope` 的全量
  加载门）、`packages/mcp/src/tools/scope.ts:43`（`SCOPE_TOOL_NAMES`，五工具列表的
  单一来源）、`:56`（`SCOPE_SCAFFOLD_NEXT_STEPS`，ADR-0012 R4 内容冷启动行的
  canonical 落点）、`:269`（`registerScopeTools`，五个 registrar 的汇总导出）、
  `packages/mcp/src/tools/audited.ts:113`（`assertScopeMatch`，裁决 6 的写断言）、
  `packages/mcp/src/errors.ts:476`（`SCOPE_TOOL_ERROR_CODES`，六码的单一定义）、
  `packages/mcp/src/config.ts:28`（flag 面重排的模块级说明，裁决 3/4）、
  `packages/mcp/scripts/check-e2e-loop.ts:821`（e2e Step 17，五工具的真实 wire 序列）
- GLOSSARY：scope / corpus / write tier / git recorder（既有词条，无新增）
