# MCP 大响应与分页惯例（#29 findings）

**Verdict：`tools/call` 没有协议级分页——`nextCursor` 只属于四个 list 方法；生态对大 tool 响应的通行做法是
server 自设上限（cap + `total`/`truncated`）+ 过滤参数缩围，绝不依赖客户端截断。** 对 #30 的指向：硬 cap +
`truncated:true` + `total` + tables/events 缩围是顺着生态的形状；协议不提供现成分页通道，翻页若做只能是
app 级自造 cursor（稳定性自担）。

调查日期 2026-10-10。证据分级：**已确证**（SDK v2.3.1 dist 源码，era 精确一手） / **社区级**（blog、discussion） /
**未能确证**（如实记录）。

## 已确证（`node_modules/.pnpm/@modelcontextprotocol+server@2.3.1/…/dist/src-Cqbh3MYc.mjs`）

1. **`nextCursor` 只挂在四个 list 方法的 Result 上**：`ListToolsResultSchema` / `ListPromptsResultSchema` /
   `ListResourcesResultSchema` / `ListResourceTemplatesResultSchema`（行 2949–2977、3216–3238；
   `PaginatedResultSchema = wireResult({ nextCursor: CursorSchema.optional() })`，行 2945）。
2. **`tools/call` 请求侧无 cursor**：`callToolParamsShape = { name, arguments?, …retryParams }`（行 3127）；
   `paginatedParamsShape = { cursor: optional }` 只被 `tools/list` / `prompts/list` / `resources/list` 等
   list 请求展开（行 3134–3136）。
3. **`CallToolResult` 无分页字段**：`{ content: ContentBlock[], structuredContent?: unknown, isError? }`
   （行 2946–2949）。
4. **Cursor 语义 = 不透明 token**：`CursorSchema` doc comment「An opaque token used to represent a cursor
   for pagination.」（行 2480）——cursor 内容物协议不规定，server 自定义。
5. **`structuredContent` / `outputSchema` 在本 SDK era 真实存在且接线**（SEP-2106）：era codec 的
   `projectCallToolResult` 对非对象 `structuredContent` 自动补 text fallback（§4.3，行 585–612）；
   `ToolSchema.outputSchema` 存在（行 2893–2901）+ legacy wrap helpers（行 2363–2421）。
   **⚠️ 与 ADR-0005 的 2026-10-09 addendum「SDK v2.3.1 无 structuredContent/outputSchema 旁路」相抵触**——
   addendum 需复核勘误（我们当前 `toolSuccess` 只发 content 文本、行为不受影响，但「SDK 不支持」这条记录是错的；
   复核点是 addendum 当时量的可能是 2025-era compatibility 路径）。

## 生态实践（社区级证据，非规范；来自搜索摘要层，**URL 未经本环境核实**——web 三通道不可达，只记标题+站点）

- **cap / chunk**：Axiom 博文「Designing MCP Servers for Wide Schemas and Large Result Sets」（axiom.co）——
  uncapped results 让 client 上下文爆炸，要 cap/chunk。
- **list 分页 ≠ tool 分页**：FastMCP 文档（gofastmcp.com）——`list_page_size` 只给 list 方法实现 MCP 规范
  分页；tool 级分页是应用自理。
- **让工具自己可分页/分块**：GitHub community discussion「Handling large text output from MCP server」——
  工具暴露分页参数，client 只见 manageable chunks。
- **别依赖客户端截断**：OpenAI community 帖「Tool Response Truncation on MCP Connector」——ChatGPT MCP
  connector 客户端侧截断会破坏响应——server 必须自设界。

（四条为 blog/discussion 级个案，URL 未核实、未见系统 survey；「server 自设界」的收敛方向一致，但比例无从断言。
#30 引用社区论据时按此分级。）

## 未能确证

- **规范网页原文**：modelcontextprotocol.io 三通道不可达（域验证 / 安全分类器停机 / reader 500）。以 SDK dist
  为替代源——它就是实际解析我们响应的 zod schema，对 wire 契约问题是更强的一手；但「规范是否另有 guidance
  文字」未核对，勘误 ADR-0005 addendum 时应补抓一次。
- **宿主（QoderWork）对 `structuredContent` 的消费能力**：未测。#30 若想用 `structuredContent` 载
  `total`/`truncated` 元数据，先过 ADR-0005 addendum 勘误 + 宿主实测，别把裁决建立在未测通道上。

## 对 #30 的喂料（事实，不裁决）

- 协议零新债的形状：硬 cap + `truncated:true` + `total` + 教 agent 用 tables/events 缩围（元数据放 content
  JSON 顶层即可，`structuredContent` 是可选增强）。
- 翻页 = app 级自造 cursor：opaque token 语义给了自由度，但 work_id 的 `h` 指纹随语料演进，cursor 稳定性是
  自担成本（与 #30 票面已有的称量点一致）。
- `top_k` 类参数与 cap 不互斥（cap 是护栏，参数是阀门）。
