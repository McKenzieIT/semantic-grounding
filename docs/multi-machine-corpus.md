# 多机共享 corpus 指南——MCP 跟人走、语料跟 git 走

> **与 README 的分工**：[仓根 README](../README.md) 管「**一台机器怎么接进来**」——安装、
> 以 `--agent-id` 注册 sg-mcp、`tools/list` 自检；本指南管「**多台机器怎么合账**」——同一份
> corpus 怎么被几个人、几台机器共同维护。单机接入的细节不在此重复，需要时回 README。

## 0. 一句话模型

corpus 就是一个普通 git 仓库：`tables/`、`events/`、`concepts/` 三层目录加一份
`config.yaml`。启动姿态检查（posture）强制**仓库根 = corpus 根**（嵌在别的仓库里会被拒
绝），Tier-2 审计写路径让**每一笔写就是一次 commit**
（[ADR-0004](./adr/0004-git-tier2-audit-backbone.md)）。由此：

- **共享的单位是仓库，不是服务。** 多机共用语义层 = 多份 clone 指向同一个 git 远端，
  和多人合写一个代码仓库没有本质区别。
- **MCP 对环境的全部要求 = 能读到目录 + 能跑 git。** sg-mcp 只以 stdio 起本地进程
  （`server.ts` 只有 `serveStdio`，没有网络监听），corpus 也不要求任何特殊的服务端组件
  ——任何一份干净的 clone 天然满足。

部署形态因此是「**MCP 跟人走、语料跟 git 走**」：每人在自己机器上跑一个 sg-mcp（各自
声明自己的 `--agent-id`），corpus 挂在 git 远端（自建 bare 仓、公司 GitLab/Gitea、私有
GitHub repo 均可），以 clone / pull / push 共享。

## 1. 走一遍场景

以下命令均可照抄（`<>` 占位符替换成自己的值）；git 侧流程已在真实 bare 远端 + 双 clone
环境里完整验证过。MCP 工具调用以叙述呈现——怎么发起调用（注册、`tools/call`）见
README。

### 首建者（机器 A）：从零建库并推上远端

前提：本机 git user 已配置（见 §4）。远端先有一只空 bare 仓库，例如：

```bash
git init --bare /srv/git/semantic-layer.git        # 任意 git 服务端均可
```

向 sg-mcp 问脚手架（零副作用知识工具）：`get_scope_scaffold(scope_id, path)`，然后
**自己在 bash 里跑基础设施半边**：

```bash
mkdir -p <path>/tables <path>/events <path>/concepts
# 写 <path>/config.yaml（脚手架会给出模板，形如：scope_id / project.name 两行）
cd <path> && git init
git add -A && git commit -m "scope shell: <scope_id>"
```

回 MCP 注册并切入：`register_scope(id, path)` → `switch_scope(scope_id)`。之后正常干活
——`create_definition`、`add_alias`、`add_relation`……每笔写自动落一次审计 commit，无需
手工提交。干完一轮，把仓库推上远端：

```bash
git remote add origin <远端URL>
git push -u origin HEAD
```

### 加入者（机器 B）：clone、本机注册、开写

前提同样是本机 git user 已配置（§4）。

```bash
git clone <远端URL> <本地目录>
```

**在本机重新注册**：`register_scope(id: <scope_id>, path: <本地目录>)` →
`switch_scope(<scope_id>)`。scope_id 建议**沿用首建者的**——clone 里的 `config.yaml` 写
着它，沿用可让 `X-SG-Scope` trailer 跨机器对得上（见 §3）。之后进入日常循环。

### 日常循环：pull → 干活 → push

```bash
git pull        # 开工前同步
# ……经 sg-mcp 读写若干笔（每笔写各自成 commit）……
git push
```

与多人合写代码仓库同一套肌肉记忆。**MCP 不代劳 pull/push**——它们是使用者（或使用者
驱动的 agent）自己的 git 操作，sg-mcp 既不拉也不推（见 §2 末尾的边界）。

## 2. 撞车的三种形态（诚实交代）

两台机器各自 `pull → 干活 → push`，迟早撞车。按「别人的改动到达你这里的时间」分三种：

**① 各写各的文件——git 自动合并。** corpus 的存储粒度是文件：一个概念一个
`concepts/<name>.yaml`，表与事件各归各的文件。两端写的目标不相干时，后推的一端
`git pull` 生成一个普通 merge commit，双方改动都在——无需任何人工介入。

**② 同处修改——push 拒收，pull + merge 再推。** 两端改到了同一个文件：后推的一端会被
远端拒收——

```text
 ! [rejected]        master -> master (fetch first)
error: failed to push some refs to '<远端URL>'
```

先 `git pull`：不同文件的部分照旧自动合并；同一文件同处的修改会留文本冲突标记，人工
裁决后完成合并再推：

```bash
git pull                          # 报 CONFLICT，文件里留 <<<<<<< ======= >>>>>>>
# 编辑该文件，留下裁决结果，删掉三组标记
git add -A && git commit -m "merge: 裁决 <文件>"
git push
```

**注意：冲突裁决完、`git commit` 收尾之前，工作树是脏的——posture 会拒绝这期间的 MCP
写**（干净树是审计提交的前提，[ADR-0004](./adr/0004-git-tier2-audit-backbone.md)）。
先把手头的 merge 办完，再回去写。

**③ 一端对着旧版本写——`stale_baseline` 拒绝这笔写。** 别人的改动已经进了你的工作副本
（你 pull 过，或同机另一个进程写过），而你手里的基准还是旧的：更新类工具
（`update_definition` / `add_alias` / `remove_alias` / `add_relation` / `remove_relation`）
都要求 `expected_version`——`get_definition` 返回的 sha256 内容指纹。指纹对不上，这笔写
被拒：

- 错误码 `-31002`（`stale_baseline`），全表面**唯一可重试**的错误；
- 解法就写在拒绝里：**重读**（拿新指纹）**重写**（带着新 `expected_version` 再提交）；
- 它防的是「基于过期前提的整字段覆盖」——即盲覆盖别人的改动。端到端门禁里有整段验证
  （`../packages/mcp/scripts/check-e2e-loop.ts`：故意用死指纹写 → 拒 → 重读 → 重试
  成功）。

> **边界，醒目地说**：以上机制**只防「写坏」，不替你「同步」**。`stale_baseline` 比较
> 的是你工作副本里的现状；别人的改动若还只在远端，它管不着——那是形态②的 push 拒收
> 管的。而 pull / push 本身始终是使用者/agent 自己的 git 操作，MCP 不代劳、不提醒、不
> 定时同步。想让「干活前先同步」成为习惯，请在自己的工作流里安排，而不是指望服务端。

## 3. 注册表是 per-user 的：clone 不会把注册带过来

scope 注册表住在 `~/.semantic-grounding/scopes.yaml`，**每台机器、每个系统用户各一份，
互不相干**（[ADR-0011](./adr/0011-scope-management.md) 裁决 2）。它在 git 仓库之外，也
**不在 corpus 里**——所以：

- **clone 之后必须在本机 `register_scope`**，首建者的注册不会跟过来。这一步是纯本机
  记账，不产生任何 corpus 写入；
- 注册是幂等的：同一 id + 同一真实路径再注册，答 `already_registered`，无副作用；
- 两台机器各注册各的，同一仓库各自指向本机 clone 的路径，互不感知（跨机、跨系统用户
  的注册表不一致是 ADR-0011 明文接受的残留，不多不少）；
- `--registry <path>`（或环境变量 `SG_REGISTRY`）可挪走注册表位置——主要给测试/e2e 隔
  离用，日常不需要碰。

启动时的便捷项：`--scope <id>` 可在起进程时急绑（等价于开工先 `switch_scope`），详见
README 的注册模板。

## 4. git user 前置：每台机器都要配

Tier-2 审计的身份是**分离**的（[ADR-0004](./adr/0004-git-tier2-audit-backbone.md) 裁决
9）：recorder 落的每笔 commit，**author = agent**（`<agent-id>`，邮箱落在
`<agent-id>@agents.<corpus>` 命名空间，启动时以 `--agent-id` 声明），**committer =
server**（固定 `semantic-grounding-mcp`）——两者都经环境变量逐笔传入，**不读本机 git
user**。`git log --format='%an | %cn'` 一眼分出 agent 写与人工写，靠的正是这个分离。

那为什么每台机器仍要配 git user？因为**人自己要落的 commit** 一笔都少不了它：

1. **首建的第一次 commit**——脚手架第 4 步（`git add -A && git commit -m "scope shell:
   …"`）是你在 bash 里跑的，未配 git user 会直接失败；
2. **日常 `git pull` 的 merge commit 与冲突裁决 commit**——都以本机 git user 落名。多机
   场景下这反而有用：历史里 merge commit 的署名就是「谁在哪台机器上合的账」。

每台机器开工前一次：

```bash
git config --global user.name  "<你的名字>"
git config --global user.email "<你的邮箱>"
```

## 5. 边界与将来

本指南对应的是部署拓扑 **A 方案**（MCP 跟人走、语料跟 git 走，零代码）。另外两条路的
去向（口径见 [#71](https://github.com/McKenzieIT/semantic-grounding/issues/71)）：

- **B（押后，不丢）**：MCP + corpus 同居一台服务器、远程 agent 走 HTTP transport。
  触发条件——出现「多 agent 常驻一台服务器、集中管控」的硬需求时，另起 fresh effort
  开图。已记下的核心决策点：HTTP 一进程服务多连接，而 active-scope 指针是进程级的
  （ADR-0011），per-connection 绑定隔离是真架构决策，不是配置项。
- **C（排除）**：MCP 本地、corpus 远程——要发明远程 FS/git 协议、Tier-2 审计骨干整个
  重做，ROI 不成立，out of scope。

## 参考

- [ADR-0004](./adr/0004-git-tier2-audit-backbone.md)：git 审计骨干——repo 根 = corpus 根、
  脏树拒写、author/committer 分离、`stale_baseline`（裁决 8）；
- [ADR-0011](./adr/0011-scope-management.md)：scope 注册表 per-user、`register_scope` 唯一
  引导门、flag/env 面（`--agent-id` / `--scope` / `--registry` / `SG_REGISTRY`）；
- [README](../README.md)（#70）：单机接入 quickstart；
- [MCP dogfood 记录](./mcp-dogfood.md)：flag 面沿革与 stdio 实测背景。
