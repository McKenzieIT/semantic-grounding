# Decision framing

How to present an architecture decision in this repo — and the standard of evidence it
has to meet before it counts as a decision.

Applies to wayfinder grilling rounds, ADRs, ticket resolutions, and any "here are the
options" message.

## Presenting options

**Do not produce a menu with filler.** No lettered option trees containing entries that
exist only to be rejected, and no "the best choice is C = A + B" synthesis. Every option
presented must be one a reasonable person would actually pick.

**Evaluate along ROI, project trajectory, user-facing benefit, and feasibility** — not
along abstract architectural purity. "It's cleaner" is not an argument; "it removes 4,086
lines we maintain and unblocks the strict type checking this project's value proposition
depends on" is.

**If there is a single sound architectural answer, say so and stop offering
alternatives.** Then order the work by ROI and make the highest-ROI action the first
implementation target. The useful output in that case is not a comparison, it is a
sequence.

**Push anything that doesn't affect the baseline experience to Followup** — performance
tuning, cleanliness refactors, latent tech debt. Say "Followup" explicitly; do not
silently drop it.

**When a priority changes, name the input that changed it.** Slice 2's `extends Service`
removal moved from Followup to mainline the moment MCP was confirmed as a second host,
and the reason was functional (a cordis context admits one service per name, so one
context held exactly one semantic layer) rather than aesthetic. State that link; a
priority that changes without a stated cause reads as drift.

**Grilling rounds ask ONE question at a time.** A wayfinder grilling round resolves a
single decision point: one question + one recommended answer, illustrated with a concrete
问数 / 数据工程 scenario, jargon glossed inline. Do not batch the whole frontier into one
round (2026-10-08 session correction).

Shape that works: **verdict first**, then an ROI table (`action | cost | concrete
user-facing benefit | ROI`), then only the genuinely open questions.

**When the decision is about unfamiliar machinery, explain the machinery before the
verdict.** Verdict-first assumes the reader can already judge the verdict. Where the
subject is a mechanism they have not seen — a protocol revision's wire format, a
framework's lifecycle — a verdict plus an ROI table is unjudgeable, and glossing the
individual jargon words is not enough: what is missing is what the thing *does*. Lead
with two or three plain sentences on the mechanism (an analogy earns its place here),
state the one-sentence question it raises, then the verdict and the table. #22's
`legacy` question was first put as verdict + evidence + ROI and came back
"重新详细通俗声明当前的问题是什么?"; re-framed as "MCP 是说话规矩，出过几版，新版砍了握手
改成每句话自带身份牌 —— 对面用老规矩开口时我们理不理?" it resolved in one round
(2026-10-09 session correction).

## Register

Write decision discussions in **Chinese**. Illustrate with concrete scenarios from this
product's actual domain — a 问数 question ("上个月付费用户的渠道留存") or a 数据工程
task (onboarding a new table, enrichment failing) — rather than abstract examples.

**Gloss every piece of jargon in plain terms on first use**, including framework and
architecture vocabulary: `cordis` is a plugin framework / DI container (think Spring, or
the VSCode extension host); `setter injection` is handing dependencies in after
construction instead of the object going looking for them; `service locator` is the
object asking a container and getting `undefined`; `peerDependencies` are deps the host
supplies rather than you bundling them. Analogies carry weight here: "semantic-grounding
是数据字典 + 知识图谱，Cordis 是装它的货架" settled more of the Cordis question than the
coupling inventory did.

## Evidence standard

**Verify premises before executing on them, including premises recorded in this repo's
own tickets and resolution comments.** Slice 1's resolution comment stated that npm
`@deepseek-ai/cordis@4.0.4` dropped `Service` and `Context`-as-value and had broken
`.d.ts` refs. Both halves were false, and the claim was load-bearing: it had justified
vendoring 4,086 lines of host framework and relaxing six tsconfig strictness flags, and
the next agent to touch dependency wiring would have re-vendored on its authority rather
than re-testing. Closed tickets are not more trustworthy than open ones.

**Measure, don't infer.** Scratch-dir experiments (`/tmp/<probe>`), throwaway probe
scripts, and tarball installs into clean environments are cheap and settle questions that
argument cannot. Issue #6 exists because a probe showed an unaudited YAML actually on
disk; describing the code path alone would have read as speculation.

**Retract your own arguments when they fail.** I built a case that cordis's logger would
corrupt an MCP stdio JSON-RPC stream, measured it, found `LoggerService` registers no
exporter by default and writes 0 bytes to stdout, and withdrew it. Same for an
overstated claim that three module-level singletons were multi-instance hazards — two are
root-keyed and safe. A decision resting on one false premise is worth less than a
decision resting on three true ones.

**Record non-problems you investigated**, so the next session doesn't rediscover them as
blockers. The stdout finding is in `docs/mcp-map-seed.md` for exactly this reason.
