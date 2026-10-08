# ADR-0004: git as the Tier-2 audit backbone

- **Status**: accepted
- **Date**: 2026-10-08
- **Deciders**: McKenzieIT
- **Relates to**: ADR-0001 (D5 invariant — mechanism addendum), [map #12](https://github.com/McKenzieIT/semantic-grounding/issues/12), design ticket [#13](https://github.com/McKenzieIT/semantic-grounding/issues/13) (closes [#6](https://github.com/McKenzieIT/semantic-grounding/issues/6))

## Context

The MCP management surface (map #12) lets working agents maintain the semantic layer.
Write means Tier-2, Tier-2 needs a recorder (ADR-0001), and charting chose **git as the
audit backbone**: the corpus already lives in git, `git blame`/`git log -p --follow`
*is* field-level provenance, and branch/PR is the missing approve side of the pending
queue. This ADR records the recorder design ruled in #13 — the audit trail's shape is
baked into every future commit, so changing any of it later means rewriting history:

literally. Ten rulings, each with the trade it closed:

| # | 维度 | 裁决 | 关闭的取舍 |
|---|---|---|---|
| 1 | 原子性 | recorder 契约异步化；基底写前留原始字节、recorder 抛错即恢复并上抛；批路径审计失败=回滚当前表+中止批次 | #6 的「写后炸留脏文件」第三态不再可表达 |
| 2 | raw-edit 表面 | `writeTable`/`writeEventYaml` 保留公共、增可选 `Tier2Opts`——降格为「写原语」；MCP host 全链路必传 | 删表面（dsh revert 是活消费者）vs 维持永久无审计门 |
| 3 | enrichment 写回 | `enrichAll*` 走 recorder；契约预留可选 `beginBatch()`（一轮 = 一次 commit）；批量实现随 #16 | 302 表 = 302 commit 的 log 洪水 vs 派生写无审计 |
| 4 | 归属 | recorder 全放 `packages/mcp`；substrate 只改契约、零新依赖 | substrate 为单一宿主背 git 依赖、动 ADR-0003 名单 |
| 5 | 非 git corpus | unsupported，启动即拒、报错给修法；corpus 根必须 = 仓库根（`rev-parse --show-toplevel` 相等）；嵌大仓同样拒 | JSONL fallback（状态与审计两个可不一致的数据集——恰是 git 胜出的原因）；`git commit -- pathspec` 放宽留将来 |
| 6 | 启动脏树 | 四情形：干净→启；脏+无锁→拒（指路 commit/stash）；脏+死锁→判崩溃残留、恢复 HEAD+释放锁+大声日志；脏+活锁→拒（防双开） | 自动全清（人工手改=数据丢失）vs 一律拒绝（崩溃残留永续） |
| 7 | 并发 | 整仓一把排它锁 `corpusRoot/.git/sg-write.lock`；临界区=读-合并-写+add+commit 全程；读不拿锁；阻塞轮询+超时（默认 10s 量级可配）→应用错误码（JSON-RPC 保留区外）；锁记 pid+心跳、属主死/超龄判破 | 按文件细粒度锁（commit 仍须仓级串行——暂存区全局——复杂度白付） |
| 8 | 基线过期 | 读返回 sha256 内容指纹 `version`；写接受可选 `expected_version`、锁内校验、不符抛基线过期错（重读重试）；基底可选，MCP 工具面强制与否归 #15 | 锁只能防交错、防不了「基于过期前提的写」（整字段覆盖丢别人的改动） |
| 9 | 提交身份 | agent-id 由启动配置声明（client 无关；stdio 下 client 注册的 command/args/env 是唯一现成通道）；缺失拒启；author=agent（`<id>@agents.<corpus>` 命名空间、可配）；committer=server（agent 写 vs 人工写一眼可分）；clientInfo/session/scope 进 trailer | 协议无身份可给（`_meta.clientInfo` 是客户端应用名）；corpus 级配置表达不了「同仓两进程两个 agent」 |
| 10 | message 模式 | subject `<tool>(<target>): <摘要>` + `X-SG-*` trailer 段（`Schema:1` 版本化 / `Tool` / `Derivation: deterministic\|llm\|agent` / `Confidence` / `Agent` / `Client` / `Scope` / `Session`；批量另加 `Files`/`Rounds`）；不用旁车文件 | 自由散文（机器不可查）vs 旁车 JSON（状态与依据重新拆成两个可不一致的数据集） |

## Decision

Adopt all ten rulings above. The audit record of a Tier-2 write **is** the commit: one
auditable write = one commit (batch = one commit per logical run), carrying identity in
git's author/committer fields and basis-of-change in `X-SG-*` trailers. The substrate
contract changes only as ruled in #1–#3 (async, rollback, optional primitive param,
batch slot — ADR-0001 addendum); the recorder implementation is host wiring in
`packages/mcp`, not substrate.

Boundary condition, stated honestly: **identity-from-startup-config holds exactly while
one process serves one agent** (charting's v1 shape). A future transport redraw
(long-running service, multi-tenant gateway) is out of map #12's scope and would take
identity from request credentials instead — a fresh effort, not an amendment here.

## Consequences

- `git log -p --follow` answers provenance end-to-end: which agent (author), when
  (timestamps), on what basis (`X-SG-Derivation` + `X-SG-Confidence`), with
  human-written vs agent-written history separable via committer.
- Commit-rate expectations: local commits are milliseconds against LLM-paced tool
  calls; the end-to-end gate measures rather than assumes.
- The edge case of ruling 6 (a human hand-edit coinciding with a stale crashed lock is
  restored away) is accepted and documented.
- dsh is unaffected by every ruling except the substrate contract change (#1–#3), where
  its fail-silent recorder never raises, so the rollback never triggers.
- Implementation: substrate contract in
  [#18](https://github.com/McKenzieIT/semantic-grounding/issues/18); git recorder in
  [#19](https://github.com/McKenzieIT/semantic-grounding/issues/19) (blocked by #18 and
  the workspace ticket #17).

## Verification

- #18 flips `tests/d5-invariant.spec.ts`'s `it.fails` green and asserts post-raise disk
  equals pre-write state.
- #19 asserts: two processes writing one fixture corpus serialize without lost updates;
  `expected_version` mismatch raises the stale-baseline error; each startup posture
  (clean / dirty-no-lock / dirty-dead-lock / dirty-live-lock) takes its ruled branch;
  trailers round-trip through `git log --format=%(trailers)`.
- The map #12 end-to-end gate (scripted MCP client + one true agent dogfood) is the
  final arbiter.

## References

- Design ticket with the full grilling record: [#13](https://github.com/McKenzieIT/semantic-grounding/issues/13)
- Seed facts and known costs: `docs/mcp-map-seed.md` § First ticket
- Protocol constraints (error-code segments, clientInfo semantics): #14 research,
  `research/mcp-2026-07-28-spec` branch → `docs/research/mcp-2026-07-28-spec.md`
- GLOSSARY: write tier, Tier-2 recorder, git recorder, D5 invariant, corpus
