# Research: 负知识的现成表达法 —— 数据目录与本体工具怎么记「人否决了机器建议」

**Ticket**: [#34](https://github.com/McKenzieIT/semantic-grounding/issues/34) ·
**Map**: [#32](https://github.com/McKenzieIT/semantic-grounding/issues/32) ·
**日期**: 2026-10-10 · **消费方**: [#36](https://github.com/McKenzieIT/semantic-grounding/issues/36)（定名与定形）

**方法**：只认一手来源——W3C / OASIS 规范正文（带条款号）、各项目仓库里的 schema 与源码
（`.pdl` / `.json` / `.py` / `.java`）、项目官方文档页。二手博客一律不作依据，且本文未引用任何二手材料。
每条结论后面直接挂来源链接与条款号 / 文件路径。

**本票不裁决**。本文只给「成熟系统实际怎么做」的事实与代价，命名与形状留给 #36。
第 5 节把事实对到本仓已核事实（map #32）上，仍然只陈述约束，不选方案。

---

## 0. 三问速答

| 问 | 答 |
| --- | --- |
| **① 词汇** | `tombstone` **已被占用**，而且在 DataHub 与 OpenMetadata 的代码里占的正是「存储层删除/失效标记」那个义项——在数据目录代码里复用它会就近撞车。知识图谱侧没有「被拒候选」的惯例词：`skos:hiddenLabel` **不是**「被拒」（是「拼写变体，可检索不展示」），`owl:deprecated` 是**对象级弃用注解**（零逻辑效力），`owl:NegativePropertyAssertion` 是真负断言但语义是**制造不一致**而非过滤写入。**唯一有标准文本、语义精确对口的词是 SARIF（OASIS 标准）的 `suppression`**——其 `kind: "external"` 的规范定义原文就是「若该 result 再次出现，则应被忽略」。且 SARIF 自己把 `suppressions` 与 `provenance` 放在同一个 `result` 对象上的**两个不同属性**，正是本仓 GLOSSARY 要求的「不与 `provenance` 打架」的现成先例。 |
| **② 存储形状** | 三种形状全部有先例，SARIF 还把前两种**标准化并命名**了：`kind: "inSource"` = 挂在被否决对象自己身上（per-asset；OBO 弃用、DataHub `Deprecation`/`Status` aspect、dbt `deprecation_date` 走这条）；`kind: "external"` = 独立否决表 / sidecar 文件 / 数据库（SARIF 明说 sidecar「甚至可以是另一个 SARIF 文件」）。**第三种是「根本不存」，而且是数据目录里的主流**：OpenMetadata 用 JSON-Patch 的 op 过滤从**当前状态**派生（字段非空就不许机器 replace），Amundsen 与 dbt 用**写者隔离**（机器写到另一个槽 / 根本没有机器写回人工产物的路径）让冲突不发生。注意：外部否决表有一条硬前置——**否决记录拿什么做键**，SARIF 为此专门定义了 `fingerprints` / `partialFingerprints`。 |
| **③ 撤销与生命周期** | **撤销普遍支持，但实现方式分两类**：SARIF 把撤销建模成否决记录自身的**状态迁移**（`status: accepted / underReview / rejected`），GitHub code scanning 同理（`state: open ⇄ dismissed`）；DataHub 软删除给的是**反向批量命令**（`datahub delete undo-by-filter`）。**膨胀问题：数据目录全都没有压实机制，因为它们的否决集天生有界**——否决记录挂在「真实存在的对象」上（表、字段、术语），数量 = 对象数，不是坏建议数。唯一真的做了压实/过期的是 Cassandra 的 tombstone（`gc_grace_seconds` 默认 864000 秒 = 10 天后随 compaction 丢弃），而那套机制的**过期语义恰好是本仓要的反面**（见 §4.1）。dbt 的 `deprecation_date` 给的是另一条路：**否决记录自带时间点**，到期只告警不删数据。 |

---

## 1. 词汇

### 1.1 `tombstone` 已被占用——而且占的是存储层义项

在本仓要对标的两个开源数据目录里，`tombstone` 这个词**已经在用**，且用的都是分布式存储/缓存层的原义：

- **DataHub**：`ReadMissReason` 枚举里有 `TOMBSTONE`，与 `DISABLED` / `ABSENT` / `STALE_BLOCKED` /
  `TRUNCATED` 并列——它是**缓存读失败的原因码**。文档原文：「Tombstone states (`OVER_LIMIT`,
  `COOLDOWN`, `INVALID`) return `GraphReadResult.Miss(TOMBSTONE)`」、「Failed builds write **failure
  tombstones**」。即「这个快照是坏的，别拿来服务」。
  来源：[`entity-registry/.../graph/cache/ReadMissReason.java`](https://github.com/datahub-project/datahub/blob/master/entity-registry/src/main/java/com/linkedin/metadata/graph/cache/ReadMissReason.java)、
  [`docs/deploy/gms-entity-graph-cache.md`](https://github.com/datahub-project/datahub/blob/master/docs/deploy/gms-entity-graph-cache.md)
- **OpenMetadata**：`RdfRepository.refreshEntity` 注释原文「A queued update can outlive a hard delete.
  Reconcile that **tombstone** instead of restoring an obsolete snapshot」——即 RDF 投影队列里
  **硬删除与在途更新的对账标记**。另有 `docs/plans/2026-06-22-bulk-deletion-redesign.md` 在同一义项下使用。
  来源：[`openmetadata-service/.../rdf/RdfRepository.java`](https://github.com/open-metadata/OpenMetadata/blob/main/openmetadata-service/src/main/java/org/openmetadata/service/rdf/RdfRepository.java)
- **Amundsen / dbt-core**：全仓零命中（`gh search code --repo … "tombstone"` 返回空）。

**结论**：`tombstone` 不是「未被占用的自由名字」，它是**在同一类代码库里、在相邻的持久化层、以不同
含义被占用的名字**。本仓若把它用作「人否决了机器建议」，在 substrate（持久化）+ 缓存失效
（ADR-0011 hook）这片邻域里会产生就近歧义——跟 GLOSSARY 已经吃过一次的
`origin` / `X-SG-Derivation` 同名相邻问题是同一类病。

### 1.2 `skos:hiddenLabel` 不是「被拒」—— 规范原文是「拼写变体，供检索不供展示」

SKOS Reference §5.1 Preamble 原文（这是语义的唯一权威出处，不是惯例推测）：

> The hidden labels are useful when a user is interacting with a knowledge organization system via a
> text-based search function. The user may, for example, enter **mis-spelled words** when trying to
> find a relevant concept. If the mis-spelled query can be matched against a hidden label, the user
> **will be able to find the relevant concept**, but the hidden label won't otherwise be visible to
> the user (so further mistakes aren't encouraged).

规范给的例子也是拼写错误（§5.5 Example 10）：`skos:prefLabel "animals"@en ; skos:altLabel "fauna"@en ;
skos:hiddenLabel "aminals"@en`。

两条额外事实，决定了它**不能挪用**成否决槽：

1. **它保留检索命中**。hiddenLabel 的全部目的就是「仍然搜得到」。本仓的 `alt_labels` 被
   `corpus.ts` 打进 BM25 `description` 投影——把被否决的垃圾串搬到一个「hiddenLabel 式」槽位里，
   等于**垃圾继续污染检索**，与否决意图相反。
2. **S13 完整性条件：三者两两不交**（`skos:prefLabel`、`skos:altLabel`、`skos:hiddenLabel` are
   pairwise disjoint properties）。规范列了 Example 13/14/15 三个 **not consistent** 的反例：同一字符串
   同时作 altLabel 与 hiddenLabel 是**不一致图**。所以「把被拒别名从 altLabel 移到 hiddenLabel」是
   一次**搬移**而不是一次**标注**——原位置必须删掉，于是「它曾被断言过」这件事没有落脚处。

SKOS-XL（同规范 Appendix B）提供的才是「给单个标签挂元数据」的建模手段：`skosxl:Label` 是**一等资源**
（S47: `owl:Class`），有 URI、有 `skosxl:literalForm`（S52: cardinality exactly 1），并且规范明确
**标签的身份不等于它的字面量**——「If two instances of the class `skosxl:Label` have the same literal
form, they are **not necessarily the same resource**」（§B.2.1、§B.2.4.1 Example 80 non-entailment）。
这正是本仓 `alt_labels: z.array(z.string())`（裸字符串、无 per-item 槽）与 `dimension_refs`
（每条带 `origin` + `derivation`）那条结构性不对称的标准解法：**先把裸串升成对象，才有地方挂任何状态**。
代价是 SKOS-XL 要靠三条 property chain 公理（S55–S57）「dumb down」回普通 SKOS。

来源：[SKOS Reference](https://www.w3.org/TR/skos-reference/) §5.1 / §5.4(S13) / §5.5 / §5.6、
Appendix B（§B.2.1、§B.2.2、§B.2.4.1、§B.3.2）

### 1.3 SKOS 的 note 家族没有「被拒候选」惯例；SKOS 自己删东西时**不写弃用公理**

- §7 Documentation Properties：七个 note 属性（`skos:note`、`changeNote`、`definition`、
  `editorialNote`、`example`、`historyNote`、`scopeNote`）全是 `owl:AnnotationProperty`（S16），
  且 `changeNote` 等六个是 `skos:note` 的子属性（S17）。规范对内容**不作任何限制**（「There is no
  restriction on the nature of this information」），也没有定义任何 range。
  **即：`changeNote` 是自由文本，没有机器语义，不构成「被拒候选」的惯例用法**——它能记录「我们拒了
  X」给人看，但任何程序都无法据此决定「下一轮别再抽 X」。
- **更强的反面证据**：SKOS Appendix D（历史说明）里，W3C 从 schema 中**移除**了 9 个旧元素
  （`skos:subject`、`skos:prefSymbol` 等），原文写的是「Where elements have been removed,
  **no explicit deprecation axioms have been expressed in the schema**」——连 SKOS 自己处理「这个词
  不要再用了」都没有走机器可读的弃用标注，而是写散文 + 列清单。

来源：[SKOS Reference](https://www.w3.org/TR/skos-reference/) §7.1 / §7.3(S16,S17) / §7.5、Appendix D；
[SKOS Primer](https://www.w3.org/TR/skos-primer/) §4（note 的推荐用法，同样是自由文本示例）

### 1.4 `owl:deprecated` —— 对象级弃用注解，零逻辑效力

OWL 2 Structural Specification §5.5 原文：

> An annotation with the `owl:deprecated` annotation property and the value equal to
> `"true"^^xsd:boolean` can be used to specify that an IRI is deprecated.

关键代价，同规范 §1 Introduction 原文：

> **Annotations have no effect on the logical aspects of an ontology** — that is, for the purposes of
> the OWL 2 semantics, **annotations are treated as not being present**. Instead, the use of
> annotations is left to the application.

即：`owl:deprecated` 完全是**给应用看的标牌**，推理机当它不存在。它的作用域也是 **IRI**——一个已经
存在、已经有标识符的实体，不是「一个从未获得标识符的候选串」。

**OBO Foundry 的实际作业流程**是这条路线的成熟样本（一手：OBO Academy 官方 how-to）：永不删除标识符，
改为「make entity obsolete」——在定义前缀加 `OBSOLETE.`、加 `rdfs:comment` 说明为什么废弃、若有替代则加
`term replaced by`（IAO:0100001），若无替代但有近似词则加 `consider`，另可加
`IAO:0000233 term tracker item`（指向 GitHub issue）与 `has_obsolescence_reason`。
**形状是 per-asset、永久保留、自带原因与替代指针**——因为标识符稳定性本身就是目的。
来源：[OBO Academy — Obsolete a term](https://oboacademy.github.io/obook/howto/obsolete-term/)

**与本仓的错配**：OBO 弃用的对象是「存在过、有 ID、被引用过」的实体。本仓要否决的是
**一个从未获得身份的候选字符串**（描述正文碎片、`domains` 词）。给每个垃圾串发一个永久标识符并永久
保留它的弃用记录，是把「有界的实体集」换成「无界的坏建议集」——这正是 map #32「否决集生命周期」那条
未定项的风险所在，也是 §1.5 的推荐词之所以选在「suppression（抑制结果）」而不是「deprecation（弃用对象）」的原因。

### 1.5 `owl:NegativePropertyAssertion` —— 真·一等负断言，代价是「制造不一致」而非「过滤写入」

OWL 2 §9.6.5 原文与 RDF 映射：

> A negative object property assertion `NegativeObjectPropertyAssertion( OPE a1 a2 )` states that the
> individual `a1` is **not** connected by the object property expression `OPE` to the individual `a2`.

```
_:x rdf:type owl:NegativePropertyAssertion .
_:x owl:sourceIndividual  a:Peter .
_:x owl:assertionProperty a:hasSon .
_:x owl:targetIndividual  a:Meg .
```

规范紧接着给出语义后果：

> The ontology would become **inconsistent** if it were extended with the following assertion:
> `ObjectPropertyAssertion( a:hasSon a:Peter a:Meg )`

OWL 2 Primer §4.4 补了一句动机：「Negative property assertions provide a unique opportunity to make
statements where we know something that is **not true**. This kind of information is particularly
important in OWL where the default stance is that **anything is possible until you say otherwise**。」

**建模代价，三条，全部是硬成本**：

1. **必须 reify（具体化）**：一条负断言在 RDF 里是**一个空白节点 + 4 条三元组**（`rdf:type` +
   `sourceIndividual` + `assertionProperty` + `targetIndividual`）。Functional-Style 语法里看着是
   一行，落到存储上是一个带结构的对象。
2. **空白节点不可寻址**：`_:x` 是匿名的。要「撤销这一条否决」，没有 IRI 可以 delete，只能靠三个
   组成部分（source / property / target）**反查**定位。撤销路径天生比断言路径贵。
3. **语义是「不一致」不是「抑制」**——这条对本仓是决定性的。在 OWL 下，加了负断言之后，
   enrichment 轮再把同一条 ref 推回来，结果**不是「写入被忽略」，而是「整个本体不一致」**
   （不一致的本体推不出任何有意义的东西，形式上蕴含一切）。本仓要的是
   「`enrichOnWrite` 这一轮静默不回灌、指纹不回退」，不是「语料进入不可用状态」。
   **负断言在本体里是一等公民，但它是一个一致性约束，不是一个写入过滤器。**

同类：`owl:disjointWith` / `DisjointClasses`（§9.1.3）也是一致性约束——「no individual can be at the
same time an instance of both」——同样是「冲突即不一致」，不是「冲突即丢弃后写」。

来源：[OWL 2 Structural Specification](https://www.w3.org/TR/owl2-syntax/) §5.5 / §9.1.3 / §9.6.5 / §9.6.7 / §1；
[OWL 2 Primer](https://www.w3.org/TR/owl2-primer/) §4.4

### 1.6 推荐词：`suppression`（SARIF v2.1.0，OASIS 标准）

SARIF（Static Analysis Results Interchange Format）v2.1.0 是 **OASIS Standard**，规范文本用
SHALL / MAY 规范语言，有 `suppression` 一等对象。它是我找到的**唯一一处**把「机器产出了一个结论、
人判定不接受、以后再出现就别再报」写成标准条款的地方。

§3.35.1 原文：

> A `suppression` object describes a **request to suppress a result**.
> NOTE 1: The `suppression` object is valuable in compliance scenarios, where teams must show an
> auditor that they have looked at all results that corporate policy requires, and either fixed them
> or **explicitly decided not to fix them**.

§3.27.23 给出「suppress」的操作性定义：

> each of which describes a request to "suppress" a result (that is, **to exclude it from result
> lists, bug counts, etc.**)

§3.35.2 `kind` 枚举里 `"external"` 的规范定义——**这句话就是本仓要的语义，一字不改**：

> `"external"`: The result is suppressed in an external, persistent store.
> EXAMPLE: A database containing historical information about the results from analysis tools. Such a
> store might offer the ability to mark a result as "suppressed," meaning that **if the result is
> encountered again, it is to be ignored.**

**为什么它不与本仓 GLOSSARY 的 `provenance` 打架——SARIF 自己就是分开放的**：
同一个 `result` 对象上，§3.27.23 是 `suppressions`（人的否决判断），§3.27.29 是 `provenance`
（值为 `resultProvenance` 对象，§3.48，「information about **how and when the result was detected**」）。
两个属性、两类概念、同一对象、刻意不对齐——与本仓 ADR-0005 把 `origin`（合并优先级）与
`X-SG-Derivation`（提交归属）刻意不对齐是**同一个设计判断**，且 SARIF 已经把它做成标准。
`suppression` 落到 GLOSSARY 里不会挤占 `provenance` / `origin` 的语义位，因为它回答的是另一个问题：
不是「这个值从哪来」，而是「这个结论被人拒了，以后别再报」。

同时检查了与现有词条的碰撞：`suppression` 与 `alias`（别名本体）、`relation`（有向类型边）、
`enrichment`（确定性派生变换）均无语义重叠——它作用在 enrichment **产出的候选**上，是 enrichment
的输入约束，不是 enrichment 的一种。

来源：[SARIF v2.1.0 OASIS Standard](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html)
§3.35.1 / §3.35.2 / §3.35.3 / §3.35.4 / §3.35.6 / §3.27.16 / §3.27.17 / §3.27.23 / §3.27.29 / §3.48

### 1.7 各系统的实际词汇对照

| 系统 | 词 | 语义 | 一手来源 |
| --- | --- | --- | --- |
| **SARIF (OASIS)** | `suppression`（`kind` / `status` / `justification` / `guid`） | 请求把一个 result 从结果列表中排除；`external` kind 明示「再次出现即忽略」 | spec §3.35 |
| **GitHub code scanning** | `dismissed` / `dismissed_reason` | `state: open｜dismissed`；`dismissed_reason: false positive｜won't fix｜used in tests｜mitigated`，设 `dismissed` 时 `dismissed_reason` **必填** | [REST API — Update a code scanning alert](https://docs.github.com/en/rest/code-scanning/code-scanning) |
| **DataHub** | `proposal` + `approve` / `reject`；`MetadataAttribution` | 建议走提案队列，由 owner 批/拒；attribution 记 who/why/how | `change-proposals.md`、`context-review.md`、`MetadataAttribution.pdl` |
| **OpenMetadata** | `labelType` + `state` | `labelType: Manual｜Propagated｜Automated｜Derived｜Generated`；`state: Suggested｜Confirmed`（**没有 Rejected**） | `tagLabel.json` |
| **Amundsen** | `ProgrammaticDescription` / `UNEDITABLE_*` | 机器描述是独立类型，放独立列表；人工可编辑性由配置规则控制 | `models/table.py`、`config.py` |
| **dbt** | `deprecation_date` | 对象级、带日期、到期只告警 | `deprecation_date.md` |
| **OWL 2** | `NegativePropertyAssertion` / `deprecated` | 负断言（一致性约束）/ 弃用注解（零逻辑效力） | spec §9.6.5 / §5.5 |
| **SKOS** | `hiddenLabel` / `changeNote` | 可检索不展示的拼写变体 / 自由文本注记 | spec §5.1 / §7.1 |
| **Cassandra** | `tombstone` | 带时间戳的删除标记，为复制收敛而存在，10 天后丢弃 | `tombstones.adoc` |

---

## 2. 存储形状

### 2.1 SARIF 把两种形状标准化并且命名了

这是本节最有用的一条：不必自己发明分类，SARIF §3.35.2 已经把「否决记录放哪」做成了一个**必填枚举**
（`kind` 是 SHALL，不是 MAY）：

- **`"inSource"`** —— 否决由「被否决物所在位置的一个语法构件」承载。规范举的例子是 .NET 的
  `SuppressMessage` 特性，即**写在现场的注解**。§3.35.4 说明：这种情况下 `location` 属性是
  **不必要的**（「because an end user who navigates from the result to the source code location will
  see the suppression attribute or comment near the relevant code」）——否决记录与被否决物同址，
  自然可发现。
- **`"external"`** —— 否决存在「一个外部的、持久的存储」里。§3.35.4 枚举了三种外部落点及各自对
  `location` 的要求：**sidecar 文件**（「The sidecar file **might even be another SARIF file**」）、
  **数据库**（`location.physicalLocation` 可以是一个返回否决信息的查询 URI）、以及独立编译单元。

另外 §3.27.23 定下一条**运行级一致性规则**，对本仓的「读路径要不要连带动」直接相关：

> The `suppressions` values for all `result` objects in `theRun` SHALL be either all `null` or all
> non-`null`. NOTE: The rationale is that an engineering system will generally evaluate all results
> for suppression, or none of them.

即：**「否决信息是否可用」是一个全局属性，不是逐条属性**——消费者看一条 result 就能判断整个 run
有没有接否决机制。`null` 与空数组语义不同：空数组 = 「评估过了，没被否决」，`null` = 「没评估」。

### 2.2 形状 A：挂在被否决对象上（per-asset 字段）

全部走这条路的先例，都有一个共同前提：**被否决物是一个已经存在的、有标识符的对象**。

- **DataHub `Status` aspect**（soft delete 的规范形状）：
  ```
  record Status {
    removed: boolean = false              // 「Whether the entity has been removed (soft-deleted)」
    lifecycleStage: optional Urn          // 指向 lifecycleStageType 实体；其 hideInSearch 设置决定行为
    lifecycleLastUpdated: optional AuditStamp  // 「who moved the entity into its current stage and when」
  }
  ```
  aspect doc 原文：「This aspect is used to represent **soft deletes** conventionally」。CLI 文档：
  软删除「will set the `status` aspect's `removed` field to `true`, which will **hide the entity from
  the UI**. However, you'll still be able to view the entity's metadata in the UI with a direct link」。
  注意新增的 `lifecycleStage` 把「隐藏」从布尔升级成了**指向一个独立实体的引用** +
  `hideInSearch` 开关——即「可见性策略」被提取成了可配置对象，而不是写死的布尔。
  来源：[`Status.pdl`](https://github.com/datahub-project/datahub/blob/master/metadata-models/src/main/pegasus/com/linkedin/common/Status.pdl)、
  [`docs/how/delete-metadata.md`](https://github.com/datahub-project/datahub/blob/master/docs/how/delete-metadata.md)
- **DataHub `Deprecation` aspect**：`deprecated: boolean` + `decommissionTime` + `note: string`
  + `actor: Urn` + `replacement: optional Urn`。**形状与 OBO 弃用几乎同构**（标志位 + 时间 + 原因 +
  作者 + 替代指针），只是一个在 Java/Pegasus、一个在 OWL 注解里。
  来源：[`Deprecation.pdl`](https://github.com/datahub-project/datahub/blob/master/metadata-models/src/main/pegasus/com/linkedin/common/Deprecation.pdl)
- **OpenMetadata `TagLabel`**：每条标签自带 per-item 槽——这是「`dimension_refs` 式」的成熟版：
  ```json
  "labelType": { "enum": ["Manual","Propagated","Automated","Derived","Generated"], "default": "Manual" },
  "state":     { "enum": ["Suggested","Confirmed"], "default": "Confirmed" },
  "reason":    "An explanation of why this tag was proposed, specially for autoclassification tags",
  "appliedBy": "Who it is that applied this tag (e.g: a bot, AI or a human)",
  "appliedAt": "Timestamp when this tag was applied",
  "metadata":  → tagLabelMetadata.json { recognizer, expiryDate }
  ```
  `labelType` 的 schema 描述把来源语义写得很细：「'Manual' indicates the tag label was applied by a
  person. 'Derived' … 'Propagated' indicates a tag label was propagated from upstream based on
  lineage. 'Automated' is used when a tool was used to determine the tag label」。
  `state` 的描述：「'Suggested' state is used when a tag label is suggested by users or tools.
  **Owner of the entity must confirm the suggested labels before it is marked as 'Confirmed'**」。
  **关键事实：`state` 枚举里没有 `Rejected`。** OpenMetadata 里「拒绝一个自动分类建议」= 把这条
  TagLabel 删掉，不留任何否决记录。per-item provenance 槽做得很完备，但**否决本身不被持久化**。
  来源：[`tagLabel.json`](https://github.com/open-metadata/OpenMetadata/blob/main/openmetadata-spec/src/main/resources/json/schema/type/tagLabel.json)、
  [`tagLabelMetadata.json`](https://github.com/open-metadata/OpenMetadata/blob/main/openmetadata-spec/src/main/resources/json/schema/type/tagLabelMetadata.json)
- **dbt `deprecation_date`**：模型 YAML 上的一个日期字段。
  来源：[dbt docs — `deprecation_date`](https://docs.getdbt.com/reference/resource-properties/deprecation_date)

### 2.3 形状 B：独立的否决/提案表

- **DataHub Change Proposals**：建议不落在资产上，而是成为**独立的提案对象**，进 reviewer 的收件箱，
  由权限位（`Propose Tags` / `Manage Tag Proposals` …）治理。文档原文：「they can choose to either
  accept or reject the proposal. **A full log of all accepted or rejected proposals is kept for each
  user**」——即否决留痕，但留在**提案这条记录上**，不在资产上。
  来源：[`docs/managed-datahub/change-proposals.md`](https://github.com/datahub-project/datahub/blob/master/docs/managed-datahub/change-proposals.md)
- **DataHub Context Review**（AI 建议的人工审核，与本票场景最贴近的一条）：
  「anyone can propose a change to context: people on your team, **DataHub's AI, your own agents**, or
  Context Generation」→「The proposal goes to the owners … **Then approve or reject it**」。
  纳入审核的明确包含「**Suggested table and column descriptions**」。
  来源：[`docs/features/feature-guides/context/context-review.md`](https://github.com/datahub-project/datahub/blob/master/docs/features/feature-guides/context/context-review.md)
- **SARIF `kind: "external"`**：如 §2.1，sidecar 文件或数据库，规范级认可。

### 2.4 形状 C-1：根本不存——从**当前状态**派生（OpenMetadata，最强的一手源码）

OpenMetadata 对「人写的描述不被机器覆盖」的回答是**一个 JSON-Patch 操作过滤器**，完全无状态、
不需要任何否决记录：

```python
# ingestion/src/metadata/ingestion/models/patch_request.py
RESTRICT_UPDATE_LIST = ["description", "tags", "owners", "displayName",
                        "tableConstraints", "extension"]

def _determine_restricted_operation(self, patch_ops, override_metadata) -> bool:
    """Only retain add operation for restrict_update_fields fields"""
    path, ops = patch_ops.get("path"), patch_ops.get("op")
    for field in self.restrict_update_fields or []:
        if field in path:
            if override_metadata:
                if ops == PatchOperation.REMOVE.value:   # REMOVE 永不放行
                    return False
                return True
            # overrideMetadata 关闭时：只放行 ADD
            if ops != PatchOperation.ADD.value:
                return False
    return True
```

机制：ingestion 先算出 source→destination 的 JSON Patch，再把受限字段上的 `replace` / `remove`
操作**从 patch 里删掉**，只留 `add`。语义即「**空槽可以填，非空槽不许动**」。
官方 UI 文案把这条规则说成大白话：

> If the toggle is `disabled`, the metadata fetched from the source will **not override** the existing
> metadata in the OpenMetadata server. In this case the metadata will **only get updated for fields
> that has no value added** in OpenMetadata. This is applicable for fields like description, tags,
> owner and displayName.

**代价（对本仓直接相关）**：这是从「字段现在是否非空」派生的，不是从「人是否否决过」派生的。
它能挡住「机器覆盖人写的描述」，**挡不住「人把机器加的东西删空、机器再填回来」**——删空之后字段
变空，`add` 合法。本仓的回灌循环（`remove_alias` → `enrich_on_write` 回写，`26fdc32` → `fd4ad3f`，
指纹 `60d47c13…` → `4dd62262…`）正好落在这个盲区里。
来源：[`patch_request.py`](https://github.com/open-metadata/OpenMetadata/blob/main/ingestion/src/metadata/ingestion/models/patch_request.py)、
[`locales/en-US/Metadata/workflows/metadata.md`](https://github.com/open-metadata/OpenMetadata/blob/main/openmetadata-ui/src/main/resources/ui/public/locales/en-US/Metadata/workflows/metadata.md)

### 2.5 形状 C-2：根本不存——**隔离写者**（Amundsen、dbt）

这两家根本没有「机器与人争同一个槽」的问题，所以也不需要否决记录。

- **Amundsen：机器描述进独立类型 + 独立列表**
  ```python
  # common/amundsen_common/models/table.py
  @attr.s(auto_attribs=True, kw_only=True)
  class ProgrammaticDescription:
      source: str
      text: str

  class Table:
      description: Optional[str] = None                              # 人工可编辑
      programmatic_descriptions: List[ProgrammaticDescription] = []  # 机器写，带 source
  ```
  即「机器推导的」与「人工编辑的」**不是同一个字段的两种 origin，而是两个字段**。
  优先级不靠仲裁规则，靠**结构上不可能冲突**。前端另有三个配置位专管人工可编辑性：
  `ALL_UNEDITABLE_SCHEMAS` / `UNEDITABLE_SCHEMAS` / `UNEDITABLE_TABLE_DESCRIPTION_MATCH_RULES`
  （「a list of regex rules for schema name, table name, or both」），以及
  `PROGRAMMATIC_DISPLAY` 控制机器描述的展示。
  来源：[`models/table.py`](https://github.com/amundsen-io/amundsen/blob/main/common/amundsen_common/models/table.py)、
  [`frontend/amundsen_application/config.py`](https://github.com/amundsen-io/amundsen/blob/main/frontend/amundsen_application/config.py)
- **dbt：源头倒置，机器没有写回人工产物的路径**
  `persist_docs` 的定义是「**Optionally persist resource descriptions as column and relation comments
  in the database**」——方向是 **YAML（人写、进版本库）→ 数仓 comment（派生投影）**，单向。
  `meta` 是「sets metadata for a resource and accepts any key-value pairs. This metadata is
  **compiled into the `manifest.json`** file generated by dbt」——同样是 YAML → artifact 单向，
  且 dbt 明确声明 `meta` 变更**不触发** `state:modified`（「dbt treats `meta` (and `tags`) as metadata
  only, since it doesn't affect how a resource is materialized」）。
  **dbt 表达「人写的描述不被自动覆盖」的方式是：不存在一个会覆盖它的自动写者。**
  来源：[`persist_docs`](https://docs.getdbt.com/reference/resource-configs/persist_docs)、
  [`meta`](https://docs.getdbt.com/reference/resource-configs/meta)

### 2.6 外部否决表的硬前置：**拿什么做键**

这条是形状 B 的隐含成本，SARIF 为它专门立了两个属性，值得单列（本仓 `alt_labels` 是裸字符串、
无身份，这个问题会第一个撞上）：

- **§3.27.16 `fingerprints`**：「Each property value in this object SHALL be a string that provides a
  **stable identifier** for the result. This identifier SHALL, to the extent that it is feasible, be
  the same for all results that are **logically identical**, and different for any two results that
  are **logically distinct**. This requirement is intended to ensure that a fingerprint is
  **resistant to changes that do not affect the logical identity** of the result, such as … the line
  number where a result appears in a source file.」属性名是带版本的层级串
  （如 `"stableResultHash/v2"`），消费方「SHOULD use the latest version of the fingerprint available
  in **both** results」——即**指纹算法本身要可演进**，匹配时取双方共有的最高版本。
- **§3.27.17 `partialFingerprints`**：由多个「贡献身份的片段」组成，由结果管理系统合成最终指纹。
- **§3.35.5 `guid`**：否决对象自身可带 GUID，「用于把 SARIF 文件里的 suppression 对象链接到结果
  管理系统数据库里的否决信息」——即**日志内记录与外部存储之间的连接键**。

对照：SKOS-XL 走的是另一条路——不算指纹，而是**给标签发 URI**（`skosxl:Label` 是一等资源，
且「same literal form ≠ same resource」，§B.2.4.1）。两条路的差别是「身份由内容算出」
vs「身份由分配得来」，后者需要一个发号者和一次迁移。

---

## 3. 撤销与生命周期

### 3.1 撤销：普遍支持，两种实现

- **状态迁移（SARIF / GitHub）**——否决记录**不删**，改状态：
  - SARIF §3.35.3 `status`：`"accepted"`（否决生效）/ `"underReview"`（「The engineering team is
    **discussing** the result to decide if they will suppress it」）/ `"rejected"`（「The engineering
    team **decided not to suppress** the result」）。注意这里 `rejected` 的宾语是**否决请求本身**，
    不是那个 result——即「撤销否决」在 SARIF 里是一个一等状态，而不是一次删除。
    §3.35.6 `justification` 另存「why the result was suppressed」的用户文本。
  - GitHub code scanning REST API：`PATCH .../code-scanning/alerts/{alert_number}`，
    `state: open｜dismissed`，「You must provide `dismissed_reason` when you set the state to
    `dismissed`」，`dismissed_reason: false positive｜won't fix｜used in tests｜mitigated｜null`，
    另有 `dismissed_comment` / `dismissed_by` / `dismissed_at`。撤销 = 把 `state` 设回 `open`。
    **强制原因枚举**是这套设计里最值得抄的一点：否决必须说明为什么，且理由是**封闭枚举**而非自由文本。
- **反向批量命令（DataHub）**——提供一个独立的 undo 动词：
  ```
  datahub delete undo-by-filter --urn "urn:li:dataset:(…)"
  datahub delete undo-by-filter --platform snowflake --batch-size 5000
  ```
  文档原文：「You can restore soft-deleted entities using the `undo-by-filter` command. **This reverts
  the effect of a soft delete**」。对比硬删除：「This action **cannot be undone**」。
  即「可撤销」在 DataHub 里是**软删除存在的全部理由**，CLI 文档甚至把它写成告诫：
  「Prefer **reversible** soft deletes (`--soft`) over irreversible hard deletes (`--hard`)」。
- **DataHub 的提案型否决：撤销 = 重新提一次**。这是本票最该注意的一条官方表态，Context Review FAQ 原文：
  > **Can a rejected proposal be recovered?**
  > A rejected proposal is **closed without changing anything**. To try again, **propose the change
  > again**.

  即：DataHub 在「AI / agent 建议被人拒」这个场景里，**刻意不建立持久否决**。拒绝只是关掉这条提案；
  同样的建议可以原样再提一次，系统不会记得「这个已经被拒过」。
  这不是遗漏，而是架构选择的直接后果：**它把闸门放在写入之前（提案队列），而不是写入之后（否决记录）**。
  闸门在前，机器的产出从未进过权威状态，于是「别再断言」这个需求根本不成立——最坏情况只是
  reviewer 多看一眼。
- **DataHub docs propagation 的 undo 是「按自动化运行回滚」**：DataHub Cloud 的
  「**Propagation Rollback (Undo)**: Offers the ability to undo any propagation changes」——
  撤销单位是一次传播动作，不是一条否决记录。
  来源：[`docs/automations/docs-propagation.md`](https://github.com/datahub-project/datahub/blob/master/docs/automations/docs-propagation.md)

### 3.2 膨胀：数据目录**没有压实机制，因为它们的否决集天生有界**

这是本节最重要的一条，而且是一条**否定性发现**——我在 DataHub / OpenMetadata / Amundsen / dbt
四家里**都没有找到**否决集/软删除集的压实（compaction）或过期（expiry）机制。原因不是它们漏了，
而是它们的集合规模被结构限住了：

1. **记录挂在真实存在的对象上** → 集合大小 = 资产数（表、字段、术语），与「坏建议的数量」无关。
   DataHub 的 `Status.removed` 最多一个资产一条；`Deprecation` 同理。OBO 的弃用记录数 = 曾发过的
   标识符数。这些量级由业务对象决定，天然有界。
2. **否决不被持久化** → 根本没有集合要压实。OpenMetadata（删 TagLabel）、
   DataHub 提案（拒了就关）都属于这类。
3. **提案队列会自然清空** → 提案是工作项，有终态，不是长期状态。

唯一我找到的、确实为「只增不减的删除标记集」做了压实与过期的系统是 **Cassandra**，而它的过期语义
恰好是本仓要的反面（§4.1 详述）：

- 过期：`gc_grace_seconds`，**默认 864000 秒 = 10 天**（CQL DDL 表属性文档：「Time to wait before
  garbage collecting tombstones (deletion markers)」）。
- 压实：到期后由 compaction 丢弃，且丢弃有严格前置（tombstone 必须比 `gc_grace_seconds` 老；
  含该 partition 的 SSTable 与所有更老数据的 SSTable 必须进同一次 compaction；
  `only_purge_repaired_tombstones` 开启时还要求数据已 repair）。
- 为什么必须过期，官方原文：「This does mean we will end up **accruing tombstones which will
  permanently accumulate disk space**. To avoid keeping tombstones forever, we set
  `gc_grace_seconds` for every table」。
- 过期的后果，官方原文：「there will **no longer be any record indicating that a specific piece of
  data was deleted**」。

**可借的与不可借的分清**：Cassandra 的**生命周期机械**（必须有压实/过期，否则只增不减的标记集会
无界增长）是普遍真理，可借；它的**过期语义**（到期后否决记录消失 → 否决失效）对「持久否决权」
是直接的功能性错误，不可借。

**第三条路（dbt）**：`deprecation_date` 把生命周期做成**声明式时间点而非 GC 策略**——否决记录自带
一个日期，到期**只升级告警级别，不删任何东西**。`WARN_ERROR_OPTIONS` 可以把
`DeprecatedModel` / `DeprecatedReference` / `UpcomingReferenceDeprecation` 三个警告提升为运行时错误。
即：**用「到期后更吵」代替「到期后遗忘」**。
来源：[Cassandra — Tombstones](https://cassandra.apache.org/doc/latest/cassandra/managing/operating/compaction/tombstones.html)（
源文件 [`tombstones.adoc`](https://github.com/apache/cassandra/blob/trunk/doc/modules/cassandra/pages/managing/operating/compaction/tombstones.adoc)）、
[CQL DDL 表属性](https://github.com/apache/cassandra/blob/trunk/doc/modules/cassandra/pages/developing/cql/ddl.adoc)、
[dbt `deprecation_date`](https://docs.getdbt.com/reference/resource-properties/deprecation_date)

---

## 4. 不适用的来源（以及为什么）

### 4.1 分布式存储的 `tombstone` —— **不适用**，三条差别，逐条都是功能性的

票里要求裁定这一条。确认：**不是一回事**。Cassandra 官方 tombstone 文档逐条给出了差别。

| | Cassandra tombstone | 本仓要的「持久否决权」 |
| --- | --- | --- |
| **后续写入谁赢** | **后写的赢。** 原文：「queries will **ignore all values that are time-stamped previous to** the tombstone insertion」；并且「If a client **writes a new update** to the tombstoned object during the grace period, Cassandra **overwrites the tombstone**」。tombstone 只压制比它**更老**的值。 | **否决必须赢。** `enrichOnWrite` 在 T+1 重新推导出同一个别名，必须被拦住。若按 tombstone 语义，这次「更新」是合法的、会直接覆盖掉否决标记——**本仓的回灌循环会原样复现**。 |
| **存多久** | **10 天后记录本身消失。** `gc_grace_seconds` 默认 864000s；到期后「there will no longer be any record indicating that a specific piece of data was deleted」。 | **持久**。否决权有效期若默认 10 天，等于十天后自动打回地鼠。过期策略要有，但不能是「忘记曾否决」（见 §3.2 dbt 路线）。 |
| **为什么需要它** | **为了把删除传播给联系不上的副本。** 原文：如果某副本在删除时离线，它会继续保存未删数据，repair 会把它复制回全集群——这叫 **zombie**。tombstone 的全部存在理由就是让 repair 传播「已删」而不是传播「旧数据」。单机单副本场景下 tombstone 没有意义。 | **本仓零副本、单进程。** 回灌的原因不是「某个副本没收到删除」，而是**同一把锁内有第二个写者**（`SemanticLayerService.enrichOnWrite`，`index.ts:1108`）在合法地重新推导同一个值。这是**写者冲突**，不是**复制滞后**。 |

**一句话差别**：tombstone 说的是「**这个值在时刻 T 被删了**」——一个带时间戳的事实，会被更新的事实
覆盖，并且到期即遗忘。本仓要的是「**这个值不许再被断言**」——一个不随时间失效的策略，而且必须压制
未来的写入。前者是**最终一致性的删除传播**，后者是**对派生轮的持久约束**。两者唯一真正共享的只有
「只增不减的标记集需要压实/过期」这条运维机械（§3.2）。

**附带确认**：这个名字在 DataHub 与 OpenMetadata 的代码里**已经被原义占用**（§1.1），所以继续用
`tombstone` 不只是语义不准，还会在同一片代码邻域里撞车。

### 4.2 `skos:hiddenLabel` —— **不适用**，语义是「可检索不展示」，且会保留检索污染

详见 §1.2。两条独立的否决理由：规范原文把它钉在「拼写变体供检索」上；S13 的两两不交条件使它成为
一次**搬移**而非一次**标注**，否决事实无处落脚。更实际的问题是它**保留 BM25 命中**，与本仓
「清掉 446 个受污染定义」的目的正相反。

### 4.3 `owl:NegativePropertyAssertion` —— **部分不适用**，语义层级错了

概念上是最贴近的（真正的一等负断言），但语义是**一致性约束**：加了负断言之后，正断言再出现会让
**整个本体不一致**（§9.6.5 原文）。本仓要的是「这一轮静默不回灌、指纹不回退」，不是「语料进入
不可用状态」。另加两项实现代价：reify 成 4 条三元组、空白节点不可寻址导致撤销要反查。
**可借的是词根（negative assertion / 负知识）与「否决是一等对象」的立场，不可借的是它的真值语义。**

### 4.4 `owl:deprecated` / OBO obsoletion —— **部分不适用**，作用域是「存在过的对象」

详见 §1.4。它们解决的是「这个**已有标识符的实体**不要再用了」，per-asset、永久、带原因与替代指针，
形状成熟。但本仓否决的是**从未获得身份的候选字符串**。照搬会把有界的实体集换成无界的坏建议集。
**可借的是记录结构（标志位 + 时间 + 原因 + 替代 + 追踪链接），不可借的是「每个被否决物都该有永久标识符」这个前提。**

### 4.5 DataHub soft delete（`Status.removed`） —— **不适用于否决，适用于可见性**

`Status` aspect 的 doc string 自己写明「This aspect is used to represent **soft deletes**
conventionally」，效果是「hide the entity from the UI」。它回答的是「这个资产还要不要展示」，
不是「这条机器建议被人拒了」。并且 DataHub 自己给出了反例：rollback 时「**A re-ingestion of these
entities will result in this additional metadata becoming visible again**」——软删除标记**不阻止重新摄入**。
**与本仓场景同构的失效模式：软删除挡展示，不挡回灌。**

### 4.6 dbt `persist_docs` —— **不适用（但结论有用）**

`persist_docs` 的方向是 YAML → 数仓 comment，是**导出**而非冲突仲裁；`meta` 同样是 YAML → `manifest.json`
单向。dbt 没有「人写的描述被自动覆盖」这个问题要解，因为**不存在往 YAML 回写的自动写者**。
作为「怎么表达人写的不被覆盖」的答案，它的答案是**取消问题**而不是**解决问题**。
对本仓的意义是一条边界：本仓已经有第二个写者（`enrichOnWrite`），dbt 这条路要么不适用，要么等价于
「取消 on-write enrichment」——那是另一个量级的裁决，不属本票。

### 4.7 Great Expectations / Monte Carlo / Atlan —— **未取到一手材料，不作依据**

票里标为「若有余力」。GE 侧我在 `great-expectations/great_expectations` 的代码搜索未命中
suppression 语义的构件（命中的 `catch_exceptions` / `mostly` 是**执行期容错与阈值**，不是人工否决记录），
不足以作为先例写入结论。Monte Carlo / Atlan 是闭源商业产品，可取的只有营销型文档页，达不到本票
「规范文本 / 官方文档 / 源码」的一手标准，**故不纳入**。
**这一类「dismiss suggestion」形状的空缺，由 SARIF（标准文本）与 GitHub code scanning
（一手 REST API 契约）覆盖，二者语义更精确且可引用，见 §1.6 与 §3.1。**

---

## 5. 对本仓的落点（只列约束，不裁决 —— 留给 #36）

把上面的事实对到 map #32「chart 会话已核事实」上，得到四条可直接用的约束：

1. **`alt_labels` 的裸字符串问题，两家标准给的是两条不同解法。** SKOS-XL 把标签升成一等资源
   （发 URI，且「same literal form ≠ same resource」）；SARIF 不升级对象，而是**算稳定指纹**
   （`fingerprints`，要求「resistant to changes that do not affect the logical identity」，且
   属性名带版本以便指纹算法演进）。前者改 schema + 要发号者，后者不改 schema 但要定义「别名的逻辑身份是什么」。
   已核事实 ①（`alt_labels` 无 per-item provenance 槽 / `dimension_refs` 有）决定了**两侧的落点必然不同**：
   relation 侧已经有 per-item 槽，可走形状 A；alias 侧没有，必须先回答身份问题。
2. **「护栏定否决权尺寸」这条前置边，与 §3.2 的发现方向一致。** 数据目录之所以不需要压实，是因为
   否决记录挂在**有界的真实对象**上。若护栏收紧到只剩「`domains` 词 + `deterministic` 出身的
   relation ref」两类，否决集的量级就与资产数同阶 → 落到形状 A（per-asset）即可，**不需要压实**，
   与四家数据目录的做法一致。若护栏不收、要扛任意数量的垃圾串，就离开了全部数据目录先例，
   进入 Cassandra 那类「无界标记集」的问题域 → 必须自带压实/过期，而且**不能照抄 tombstone 的过期语义**
   （§4.1），参考 dbt 的「到期更吵、不遗忘」。已核事实 ⑧ 的 T2 阻塞 T3 判断，被先例支持。
3. **substrate 零 git 依赖 + 注入 seam，正好对上 SARIF 的 `kind` 二分。**
   `kind: "inSource"`（否决与被否决物同址 → 落 per-asset YAML，天然触发缓存失效）
   vs `kind: "external"`（sidecar / 外部存储 → 需要自带写路径 + 新 Tier-2 动词，且缓存失效要显式接线）。
   已核事实 ③（`excludeColumnsFn` 先例：Service shell 建集合、substrate 不透明消费）与
   ⑤（corpus 级 sidecar 只有读路径）分别是这两条的现成成本估算。
   SARIF §3.27.23 的「全 `null` 或全非 `null`」规则还顺带回答了 map「Not yet specified」里
   「检索投影与缓存失效的连带面」的一半：**「否决信息是否可用」应当是语料级的单一属性，而不是逐条判断**。
4. **「操作员手改语料与否决的仲裁」在先例里有明确答案，而且是分层的。**
   OpenMetadata 把它做成**权限 + 开关**（`overrideMetadata` 由运行 ingestion 的人控制，
   `RESTRICT_UPDATE_LIST` 限定受保护字段）；Amundsen 做成**结构隔离 + 可编辑性配置**
   （`UNEDITABLE_*` 决定人能不能改，`ProgrammaticDescription` 决定机器往哪写）；
   DataHub 做成**提案权限位**（`Propose *` vs `Manage * Proposals` 分离）。
   三家的共同点：**「否决约束谁」不是一个数据模型问题，而是一个写者身份 + 权限问题**。
   本仓只有两个写者（agent 经 MCP 工具面、enrichment 轮），身份区分已经由 `origin` 承担了一半。
5. **一条本票没有找到先例、应当在 #36 明确的空白**：四家数据目录里，**没有任何一家**在
   「机器自动写入权威状态 **之后**」建立持久否决；它们要么**把闸门放在写入之前**（DataHub 提案队列
   —— 对应本仓已有的 Tier-1 建议四件套 + pending queue），要么**让机器写不进那个槽**
   （Amundsen / dbt）。本仓的 `enrichOnWrite` 是「先写后治」，这个姿态在本票覆盖的先例里是**独特的**。
   这不一定是错——本仓的 enrichment 是确定性的、要求「同输入同输出」，而提案队列假设机器产出稀疏且
   需人审——但它意味着**「持久否决权」这个机制本身没有现成样板可抄形状，只能抄词汇（SARIF `suppression`）
   与生命周期机械（压实/过期的必要性 + dbt 式不遗忘）**。这一条建议直接进 #36 的问题陈述。

---

## 6. 来源清单（全部一手）

**规范文本（带条款号）**
- [SKOS Reference](https://www.w3.org/TR/skos-reference/)（W3C Recommendation）— §5.1 Lexical Labels
  Preamble、§5.3(S10–S12)、§5.4(S13–S14)、§5.5 Examples 10–16、§5.6.1–5.6.3、§7 Documentation
  Properties(S16–S17)、Appendix B SKOS-XL(§B.2.1、§B.2.2 S47–S52、§B.2.4.1、§B.3.2 S53–S58、§B.4)、
  Appendix D 命名空间历史说明
- [SKOS Primer](https://www.w3.org/TR/skos-primer/)（W3C Working Group Note）— hiddenLabel 与 note
  家族的推荐用法
- [OWL 2 Web Ontology Language Structural Specification and Functional-Style Syntax (2nd Ed.)](https://www.w3.org/TR/owl2-syntax/)
  — §1 Introduction（注解无逻辑效力）、§5.5 Annotation Properties（`owl:deprecated`）、
  §9.1.3 Disjoint Classes、§9.6.5 Negative Object Property Assertions、§9.6.7 Negative Data Property Assertions
- [OWL 2 Primer](https://www.w3.org/TR/owl2-primer/) — §4.4（负属性断言的动机与五种语法形态）
- [SARIF v2.1.0 — OASIS Standard](https://docs.oasis-open.org/sarif/sarif/v2.1.0/os/sarif-v2.1.0-os.html)
  — §3.27.16 fingerprints、§3.27.17 partialFingerprints、§3.27.23 suppressions、§3.27.29 provenance、
  §3.35 suppression object（§3.35.1 General / §3.35.2 kind / §3.35.3 status / §3.35.4 location /
  §3.35.5 guid / §3.35.6 justification）、§3.48 resultProvenance object

**源码与 schema**
- DataHub：[`Status.pdl`](https://github.com/datahub-project/datahub/blob/master/metadata-models/src/main/pegasus/com/linkedin/common/Status.pdl)、
  [`Deprecation.pdl`](https://github.com/datahub-project/datahub/blob/master/metadata-models/src/main/pegasus/com/linkedin/common/Deprecation.pdl)、
  [`GlossaryTerms.pdl`](https://github.com/datahub-project/datahub/blob/master/metadata-models/src/main/pegasus/com/linkedin/common/GlossaryTerms.pdl)、
  [`GlossaryTermAssociation.pdl`](https://github.com/datahub-project/datahub/blob/master/metadata-models/src/main/pegasus/com/linkedin/common/GlossaryTermAssociation.pdl)、
  [`MetadataAttribution.pdl`](https://github.com/datahub-project/datahub/blob/master/metadata-models/src/main/pegasus/com/linkedin/common/MetadataAttribution.pdl)、
  [`ReadMissReason.java`](https://github.com/datahub-project/datahub/blob/master/entity-registry/src/main/java/com/linkedin/metadata/graph/cache/ReadMissReason.java)
- OpenMetadata：[`tagLabel.json`](https://github.com/open-metadata/OpenMetadata/blob/main/openmetadata-spec/src/main/resources/json/schema/type/tagLabel.json)、
  [`tagLabelMetadata.json`](https://github.com/open-metadata/OpenMetadata/blob/main/openmetadata-spec/src/main/resources/json/schema/type/tagLabelMetadata.json)、
  [`patch_request.py`](https://github.com/open-metadata/OpenMetadata/blob/main/ingestion/src/metadata/ingestion/models/patch_request.py)、
  [`RdfRepository.java`](https://github.com/open-metadata/OpenMetadata/blob/main/openmetadata-service/src/main/java/org/openmetadata/service/rdf/RdfRepository.java)
- Amundsen：[`common/amundsen_common/models/table.py`](https://github.com/amundsen-io/amundsen/blob/main/common/amundsen_common/models/table.py)、
  [`frontend/amundsen_application/config.py`](https://github.com/amundsen-io/amundsen/blob/main/frontend/amundsen_application/config.py)
- Cassandra：[`tombstones.adoc`](https://github.com/apache/cassandra/blob/trunk/doc/modules/cassandra/pages/managing/operating/compaction/tombstones.adoc)、
  [`developing/cql/ddl.adoc`](https://github.com/apache/cassandra/blob/trunk/doc/modules/cassandra/pages/developing/cql/ddl.adoc)（`gc_grace_seconds` 默认值）、
  [`conf/cassandra.yaml`](https://github.com/apache/cassandra/blob/trunk/conf/cassandra.yaml)（`check_data_resurrection`）

**官方文档页**
- DataHub：[Change Proposals](https://github.com/datahub-project/datahub/blob/master/docs/managed-datahub/change-proposals.md)、
  [Reviewing Context Changes](https://github.com/datahub-project/datahub/blob/master/docs/features/feature-guides/context/context-review.md)、
  [Removing Metadata from DataHub](https://github.com/datahub-project/datahub/blob/master/docs/how/delete-metadata.md)、
  [Documentation Propagation](https://github.com/datahub-project/datahub/blob/master/docs/automations/docs-propagation.md)、
  [GMS entity graph cache](https://github.com/datahub-project/datahub/blob/master/docs/deploy/gms-entity-graph-cache.md)
- OpenMetadata：[Metadata workflow — Override Metadata 文案](https://github.com/open-metadata/OpenMetadata/blob/main/openmetadata-ui/src/main/resources/ui/public/locales/en-US/Metadata/workflows/metadata.md)
- dbt：[`deprecation_date`](https://docs.getdbt.com/reference/resource-properties/deprecation_date)、
  [`persist_docs`](https://docs.getdbt.com/reference/resource-configs/persist_docs)、
  [`meta`](https://docs.getdbt.com/reference/resource-configs/meta)
- GitHub：[REST API — Code scanning（Update a code scanning alert）](https://docs.github.com/en/rest/code-scanning/code-scanning)
- OBO：[OBO Academy — Obsolete a term](https://oboacademy.github.io/obook/howto/obsolete-term/)

**未采纳（不达一手标准或未命中）**
- Great Expectations：代码搜索未命中人工否决语义的构件（`catch_exceptions` / `mostly` 是执行期容错与
  阈值，不是否决记录）。
- Monte Carlo / Atlan：闭源，可取材料为营销型文档，不作依据。
