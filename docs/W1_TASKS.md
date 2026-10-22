# W1.0 任务清单（PAR-PRD-003 · DSH 插件版）

> 依据：`REQUIREMENTS_PLUGIN-v1.0.md` §7 的 **W1.0 = 13 条 P0**。
> W0 已完成（19/19、308 条测试），本文件接续 W1.0。
> 编写日期：2026-10-22

---

## 0. 总账

| 项 | 数 |
|---|---|
| W1.0 需求条数 | 13 |
| 拆成任务 | **8 个** |
| 已完成 | **8 / 8** ✅ W1.0 全部完成 |
| 测试 | **1001 单元（31 套件）+ 94 端到端**（scan 16 / reextract 13 / import 15 / 网络 13 / 完整路径 37） |
| W1.1 进度 | **5 / 5 任务完成** ✅ |

---

## 1. 任务

### W1-01 · 正文留存 `texts/` ✅ **已完成**
- **FR**：7.7 / §8 R11
- **已做**：
  - `lib/texts.js`：`writeText` / `readText` / `removeText`，gzip 落盘到 `<数据目录>/texts/<paperId>.txt.gz`
  - 存的是 **R1 规范化后、R3/R4 之前**的正文（重算不必重抓，规则演进可原地重跑）
  - 论文记录写 `hasText` / `rawChars`（code point）/ `textHash`（sha1 前 16）
  - `removePaper` 同事务删正文文件
  - `includeText=1` 导出时把 `texts` 概要带进 JSON（**只给 id 与 hash**）
- **已验**：`test/reextract.test.mjs` [1][2][6][7]；`test/e2e-reextract.mjs`（登记后 `hasTextCount +1`）
- **注意**：现有 5 篇是 v0.2 数据，**没有正文**（v0.2 不存正文），所以 `hasTextCount=0`、重算会跳过它们 —— 这是事实，不是 bug。

### W1-02 · 原地重算 `radar_reextract` ✅ **已完成**
- **FR**：2.9 / §8 R8.2
- **已做**：
  - `reextractPapers(store, { scope, ids, dryRun })`：`all` / `stale` / `ids` 三种范围
  - **`dryRun` 默认 true**；不显式传 `false` 绝不写库
  - 只从留存正文重抽，**不联网、不重抓**；无正文的论文跳过并计入 `skippedNoText`
  - 返回 `{ total, changed, skippedNoText, failed, durationMs, diff[] }`，每篇给 `before/after` 与 `added/removed/countChanged`
  - 工具 + `POST /paper-algo-radar/reextract` 路由两条入口
- **已验**：`test/reextract.test.mjs` [3][4][5]（预览不改库、显式 false 才写、ghost 算法被移除、`staleMentions` 归零）；`test/e2e-reextract.mjs` 13 条
- **状态语义**：`buildState` 现在区分 `stalePapers`（旧口径篇数）与 `staleRecomputable`（**旧口径且有正文**，才真能重算）。面板徽标据此显示「待重算 N 篇」或「旧口径 N 篇 · 无正文」。

### W1-03 · 导入 `radar_import` ✅ **已完成**
- **FR**：7.4
- **已做**：`lib/importer.js` 拆成「先算计划、再执行」两段——`planImport()` 只读 store 并返回 `{report, apply}`，`apply(store)` 才写。**dryRun 从结构上不可能改库。**
  - 三种形态自动识别：`export-v2`（本插件导出）/ `v0.2`（`version:1`）/ `snapshot`（当前快照）
  - `merge`（默认）：按三键合并，**保留本地 id**、补齐空字段、记录 `conflicts`
  - `overwrite`：整体替换
  - 提及按 id 映射重写，三键以论文为准重建
  - 工具 + `POST /paper-algo-radar/import` 两条入口，共用同一个 `importFromPath()`
- **已验**：`test/import.test.mjs` **35/35**（形态识别、空库导入、重复导入不重复、换 id 靠 DOI 命中并记冲突、v0.2 导入、overwrite、错误码、planImport 只读性）；`test/e2e-import.mjs` **15/15**（导出→导入闭环，库完全不变）
- **已知限制**：导入**不带来正文文件**（导出默认不含正文），所以导入后的论文 `hasText` 保持本地实际状态；要让它们可重算，得用 `includeText=1` 导出并另行带正文（W1.1）。
- **E6 状态**：W1.1 补上 `radar_clear` 后，**「导出 → 清空 → 导入」已完整跑通**（`test/acceptance.mjs` 的 E6：清空 2 篇、回来后 2 篇 / 12 条提及完全一致）。E16（导入 v0.2 保持 5 篇）也在单元测试里覆盖。

### W1-04 · 写能力开关与审批 ✅ **已完成**
- **FR**：8.5 / 8.6 / 8.7 / 8.8
- **已做**：
  - **`writeEnabled` 配置**（`cordis.patch.yml` 的 `config.writeEnabled`，默认 true）。false 时**不注册任何写工具**，且 `/scan`、`/register-one`、`/remove`、`/reextract`、`/import` 一律 403 `CAPABILITY_OFF`。
  - **系统提示段（FR-8.8）** `lib/prompt.js`：经 `ctx.systemPrompt.section({name, order, text})` 注册常驻策略段（`paper-algo-radar:policy`，order = `TOOL_COMPUTER_USE - 60`）。`text` 是 provider，每次组装重读 `writeEnabled` / `textReadEnabled`；写关闭时明确禁止用 shell / 解释器 / 直接编辑 `store.json` / `texts/` 绕道。注册走 `ctx.effect`，卸载即释放；`/state.prompt` 暴露注册结果。
  - **写审批闸门** `lib/approval.js`：`ctx.get('approval')` + `exec.agent` → `approval.request(...)`，结算表与宿主一致：`allowed-once` → allowed；`rejected`/`cancelled` → declined；`unavailable`/异常/无服务/无 agent → **失败关闭**。
  - `radar_import` 的 `mode=overwrite` 且 `dryRun=false` 才要求审批（预览不打扰用户）。
  - `dryRun` 默认 true：`radar_reextract`、`radar_import` 都是。
- **已验**：
  - `test/approval.test.mjs` **27/27**（结算表五种取值、五种失败关闭、请求形状、文案、开关三态）
  - `test/import.test.mjs` **41/41**（拒绝时库不动、无服务失败关闭、无 agent 失败关闭）
  - `test/prompt.test.mjs` **44/44**（激活即注册、两态文本、越权禁令、dispose 释放、无 systemPrompt 服务降级、order 兜底）
  - **宿主实测**：`writeEnabled:false` 覆盖后重启 → 工具从 10 个降到 **6 个读工具**、`capabilities.write=false`、`POST /scan` 返回 **403 `CAPABILITY_OFF`**、论文数保持 5 不变；恢复配置后回到 10 个工具。
- **注意**：本会话的审批策略是 `never`（提示被禁用），所以 `request()` 会直接拒绝 —— 在无审批通道的环境里 overwrite 导入**不可能通过**，这是设计意图。
- **未验**：`allowed-once` 的真实放行路径（本会话策略不允许弹审批）。

### W1-05 · `/radar` 命令 ✅ **已完成**
- **FR**：8.9
- **已做**：`lib/command.js` 零依赖实现（不 import `@deepseek-ai/dsh-commands`，`definitionId` 用普通字符串——宿主自己也是这么做的，见 `dsh-plan-mode` 的 `brandString(...)`）。
  - `/radar` 与 `/radar status`：规模 / 口径 / 快照版本 / 旧口径篇数（并说明可不可重算）
  - `/radar reextract [--apply]`：**默认只预览**，`--apply` 才写库（比文档的 `[--dry-run]` 更保守）
  - `/radar export [--csv]`：给路径与体积
  - 拿不到 `commands` 服务或注册抛错时**只 warn，不影响插件其余功能**
- **已验**：`test/command.test.mjs` **28/28**（注册形状、三个子命令、未知子命令、api 抛错、服务缺失、注册抛错）。
- **宿主实测**：`/state.command = { registered: true }` —— 真注册上了，不是「没报错」。这条信号是为它专门加的：`inject` 不回调时不会有任何告警，光看日志无法区分。
- **未验**：在会话里真敲 `/radar` —— 需要真实会话与模型；handler 已单测。

### W1-06 · 算法下钻详情 ✅ **已完成**
- **FR**：3.5
- **已做**：`radar_algorithm` 工具 + `GET /paper-algo-radar/algorithm?id=` + 面板点行进入详情。
  - 详情给：基本信息（名 / 类型 / 分类 / 别名）、章节分布、年份分布、命中论文清单（含证据片段，每篇最多 3 条）
  - 解析支持 id / 规范名 / 别名；**快照没灌词典时回落到内置词典**（否则会误报 404）
  - 清单支持 limit/offset 分页
- **已验**：`test/algorithm.test.mjs` **26/26**；无头浏览器实测点开 LSTM → 1 篇论文 · 59 次提及 · 章节与年份分布 · 两条证据片段，返回按钮可用（截图 `spike/evidence/w1-detail.png`）。

### W1-06 · 算法下钻详情（未开始）
- **FR**：3.5
- **要做**：`radar_algorithm` 工具 + 面板点行进入详情（论文清单、证据片段、章节分布、年份分布）。
- **数据**：`/state.algorithms` 已带 `sections`，但证据片段在 mentions 里，需要在详情里现取。

### W1-07 · 快速添加（DOI / arXiv）（未开始→**已完成**）✅
- **FR**：1.7
- **已做**：`radar_add({ input })`——`parseInputTarget` 认 DOI、arXiv id、`arxiv.org/abs|pdf|html` 链接、`doi:` 前缀，并去掉 arXiv 版本号；DOI 走 Crossref 元数据，arXiv 走 Atom 元数据 + HTML 全文。
- **已验（真网络）**：`test/e2e-network.mjs` 13/13 —— 用 `2401.12345` 登记成功，**抓到 13.5 万字符全文**、命中 5 个算法、`hasText=true`、`arxivId` 正确；再换 URL 形式登记仍是同一篇。
- **限制**：非 arXiv 的 DOI 只有摘要；摘要 < 120 字符会明确报 `EXTRACT_FAILED`（Crossref 摘要常常过短，这是数据现实，不是 bug）。网页链接暂不支持。

### W1-08 · 多源并行检索（未开始→**已完成**）✅
- **FR**：6.2 / 6.3 / P-7
- **已做**：`lib/sources.js` 自带三个客户端（OpenAlex / Crossref / arXiv），`Promise.allSettled` 并发，**单源失败不影响其它源**，逐源上报 `{name, status, count?, error?}`；合并时先按 DOI、再按标题去重（两个不同的非空 DOI 永不合并）；结果**按源轮转**，避免前 N 条全来自同一个源。
- **出站约束**：`lib/net.js` 统一带超时 + 主机白名单（`setAllowedHosts`），fetch 可注入（`setFetch`），测试用本地假服务器。
- **已验**：
  - `test/sources.test.mjs` 39/39（并发、单源失败、去重、字段补齐、Atom 解析、DOI 解析、输入识别）
  - `test/interleave.test.mjs` 5/5（三源轮转 `openalex → crossref → arxiv`，limit×2 上限）
  - **真网络实测**：`/search` 返回 `via=openalex+crossref+arxiv`，三个源各 `ok`，结果按源轮转。
- **D-d 已作废**：W0 时「委托宿主 `paper_search`」只是临时方案；现在宿主工具仍会先问（能复用它的凭据），但它不在时**自带客户端能独立工作**。

---

## 2. W1.1（P1 · 36 条）

主题「好看」：PDF、趋势、领域、撤销、示例数据、响应式、空状态。

### W1.1-01 · 撤销 / 清空 / 恢复 ✅ **已完成**
- **FR**：2.10 / 2.11 / 7.5 / 8.5 / 8.7
- **已做**：
  - `lib/undo.js`：**懒过期**的撤销栈（默认窗口 10 秒、最多 10 条、**不起定时器**）
  - `radar_remove`（默认 dryRun，真删要审批）、`radar_clear`（**确认词 + 审批**，保留词典）、`radar_restore`（令牌撤销）
  - 删除时**正文文件在窗口内不删**——撤销回来 `hasText` 仍是 true，还能重算；过期时才由 `onExpire` 真正删除
  - HTTP：`POST /remove` `/clear` `/restore`；`/state.undo` 带当前可撤销项
  - 面板：论文页每行「删除」按钮 + **撤销条**（10 秒自动消失）
- **已验**：
  - `test/undo.test.mjs` **48/48**（dryRun 默认、审批拒绝/无服务失败关闭、撤销恢复正文与三键、确认词校验、过期后再也撤不回来）
  - **宿主实测**：`/remove` → 令牌 → `/restore` → 篇数 5→6→5；**面板实测** 5 → 删除 4 → 撤销 5，撤销条出现并自动消失
- **一处刻意的偏离**：工具调用（模型发起）走审批；**面板点击（人发起）不再重复要审批**——用户点「删除」本身就是决定，再弹一次只是噪音。写能力开关对两条路都生效。

### W1.1-02 · 趋势 + 领域视图 ✅ **已完成**
- **FR**：4.x（趋势）/ 5.3（领域 × 头部算法矩阵）/ 5.4（领域分布）/ 3.2（类型筛选）/ 3.3（关键词过滤）/ 3.4（分母跟随筛选）/ 3.8（领域筛选）
- **已做**：
  - 宿主：`buildTrends`（`series[{id,name,points[{year,papers}]}]` + `undatedCount` + 年份范围）、`buildFields`（`fields[{name,count}]` + `unclassified`）、`buildMatrix`（`algorithms[] + rows[{field,count,cells}]`；列按论文数、同篇去重、多领域各计一行、示例默认不计入）
  - 工具 `radar_trends` / `radar_fields` / `radar_matrix`；路由 `GET /trends?ids=&from=&to=` / `GET /fields` / `GET /matrix?topN=&field=`
  - `buildState` 的每篇论文新增 `types` 与 `stale`，面板据此算「当前筛选下的分母」
  - 面板：四个标签页（排行 / 论文 / 趋势 / 领域）；排行加关键词输入、领域筛选条、`40% 2/5` 的分母标注；领域页在分布下方渲染「领域 × 头部算法」矩阵表
- **已验**：
  - `test/trends.test.mjs` **28/28**（默认前 N、年份区间、未知 id 不崩、papers 是论文数、无年份单独计数、领域降序、分面字段）
  - `test/matrix.test.mjs` **29/29**（行计数、列按论文数、跨领域不重复计数、同篇去重、field 过滤、topN 边界、示例开关、空库、工具契约与卡片）
  - **宿主实测**：`/trends` 5 条序列 2018–2024；`/fields` 4 个领域 5 篇
  - **浏览器实测**：四标签页可切；关键词 LSTM → 1 行；类型筛选「深度学习」→ 分母 5→**4**；趋势网格与领域条形都渲染
- **一处设计修正**：趋势最初画折线，5 条线数据全相同 → 全重叠成一条。稀疏数据（每年 0–2 篇）折线本来就是错的表达，改成**「行=算法、列=年份」的网格**，空格留白、有值显数字。
- **已知限制**：分母在「按类型/领域筛选」时用面板已加载的论文（最多 60 篇）计算；超大库会偏小，界面已标注「按已加载论文计」。

### W1.1-03 · 示例数据包 + 空状态三入口 ✅ **已完成**
- **FR**：11.2（示例数据）/ S-j（空状态三入口）
- **已做**：
  - `lib/samples.js`：6 篇**真实可抽取**的示例正文（305–358 字，覆盖 NER / 空气质量 / 机器翻译 / 医学影像 / 推荐 / 交通预测，年份 2019–2024）
  - `isSample` 走通全链路：`buildState` / `buildTrends` / `buildFields` 默认**排除示例**；`includeSamples` 或 `?samples=1` 才计入
  - 工具 `radar_samples({action})`：`load`（可重复，按三键去重）/ `clear`（只删示例）/ `promote`（**需 confirm=true**）
  - 面板：空状态三入口（粘正文 / 搜领域 / 先看示例）+ 示例横幅（**先看示例**临时计入 / 转为正式 / 清除示例）
- **已验**：
  - `test/samples.test.mjs` **39/39**（默认不计入、toggle 后计入、重复载入不变两篇、clear 只删示例、promote 需确认、真实数据不受影响）
  - **空库实测**（独立 DSH_HOME）：载入 6 篇 → 统计仍 0 篇 / 0 算法；「先看示例」→ **6 篇 / 20 算法 / 45 提及**；趋势网格 2019–2024 正常
  - **浏览器实测**：空状态三入口 → 载入 → 横幅三按钮 → 切到趋势有数据
- **发现并修复的测试环境坑（重要）**：见下。

### ⚠️ 测试环境坑：junction 被 Copy-Item 解引用
用 `Copy-Item -Recurse` 复制 `dshhome` 建「空库」实例时，**目录联接被解引用成真实副本**，导致宿主加载的是**旧快照**——表现是「新加的按钮不出现」，而日志毫无异常。
已修：
- 两个 profile 都改回 `mklink /J` 目录联接（编辑即时生效）
- **以后判据**：`Get-Item <profile>/node_modules/<pkg> | Select LinkType` 必须是 `Junction` 或 `SymbolicLink`；复制 HOME 之后必须重建联接。
- 代价：这次白跑了 3 轮浏览器验证才定位。

### W1.1-04 · 响应式 + 图表表格视图 + 检索限速/缓存 ✅ **已完成**
- **FR**：4.3（窄屏降级）/ 9.4（每张图表必须配表格视图）/ 13.2 / 6.10（限速）
- **已做**：
  - **图表表格视图**：趋势页与领域页各有「看表格 / 看网格（看条形）」切换，表格带 caption（`data-radar-chart-table`）
  - **响应式**：`useNarrow()` 以 720px 为界；窄屏下隐藏排行「年份」列、趋势网格列宽 84→56px、表格容器横向滚动
  - **限速**：同主机最小间隔（默认 300ms），三源并发时互不影响
  - **缓存**：5 分钟内存缓存（上限 200 条），同一查询点「刷新」不再出站；`configureThrottle` / `clearSourceCache` / `cacheStats` 可注入，测试用本地假服务器
- **已验**：
  - `test/throttle.test.mjs` **12/12**（缓存命中/过期、相邻请求间隔 ≥100ms、跨主机并发、缓存上限）
  - **浏览器实测（1424px）**：趋势表格 5 行、领域表格 4 行，切换按钮成对出现
  - **浏览器实测（624px）**：`narrow=true`、年份列消失、表格与条形都可用（截图 `spike/evidence/w11-narrow.png`）
- **教训**：这一轮我的补丁脚本有一次**静默失败**（目标字符串没匹配上，脚本没断言就报成功），导致趋势页的切换按钮没生成，浏览器验证才发现。以后补丁脚本必须逐条断言。

### W1.1-05 · PDF 登记 ✅ **已完成**
- **FR**：1.8（登记 PDF）/ 10.8（子进程 + 超时强杀）/ 7.7（不留 PDF 原件）
- **已做**：
  - `lib/pdf.js`：**零依赖**最小提取器——解 `/FlateDecode` 与未压缩流，扫 `Tj` / `TJ` / `'` / `"`，处理转义、八进制、十六进制串，按 `Td` / `TD` / `T*` / `ET` 分段
  - `lib/pdf-worker.mjs` + `lib/pdfrun.js`：**独立子进程**解析，20 秒超时 SIGKILL；`setPdfRunner` 可注入
  - `radar_add({ pdfPath })` 与 `POST /scan { pdfPath }` 共用 `ingestPdf()`：≤20MB 校验 → 子进程抽取 → 统计 → **PDF 原件全程不复制不留存**
  - 扫描件 / 纯图 / CID 字体：抛 `UNSUPPORTED_MEDIA` 并说明原因，不假装成功
- **已验**：
  - `test/pdf.test.mjs` **28/28**（未压缩流 / FlateDecode / 纯图 / 真实子进程 / 登记 / 扫描件报错 / 超时 / 20MB 上限 / 不留 PDF）
  - **宿主实测**：`POST /scan {pdfPath}` → 抽出 **368 字符**、命中 **4 个算法**、`hasText=true`；随即 `radar_reextract` 对这篇重算 `skippedNoText=0` —— PDF 登记的论文**可以重算**
- **能力边界（如实标注）**：Type0/CID 字体（字形编号不是 Unicode）、加密 PDF、对象流里的内容流都不支持；返回 `diagnostics` 说明原因。
- **一个隐蔽的坑**：模块注释里写了 `Td/TD/T*/ET`，其中的 `*/` **提前关闭了块注释**，导致整个文件语法错误。注释里出现 `*/` 必须避开（改成 `Td / TD / T* / ET`）。

## W1.1 收口

W1.1（P1，36 条）覆盖的能力：PDF 登记 / 趋势 / 领域 / 撤销 / 示例数据 / 响应式 / 空状态 / 图表表格视图 / 限速缓存 —— 全部落地并有测试与实测证据。

## 3. W1.2（P2 · 5 条）

主题「数字站得住」：批量 PDF、词典管理、共现、封顶计数、双时间轴。

### W1.2-01 · 共现 + 封顶 + 双时间轴 ✅ **已完成**
- **FR**：3.6（共现）/ 3.7（封顶）/ 4.4（双时间轴）
- **已做**：
  - `buildCooccurrence()`：同篇算法对、共同篇数、各自篇数、**lift**（观测/独立期望），支持领域过滤与 `minPapers` 门槛
  - `capPerPaper` 配置（默认 0 = 不封顶）：封顶只裁「提及数」列，**论文数与覆盖率口径不变**；同时保留 `rawMentions`，两者都能看到
  - 趋势 `axis: year | readAt`（发表年 / 入库年）
  - 面板新增「共现」标签页（表格 + 门槛切换），趋势页加「发表年 / 入库年」开关
- **已验**：
  - `test/cooccurrence.test.mjs` **29/29**（共现计数与 lift、门槛、领域过滤、封顶真的裁剪且恢复后回原值、两种时间轴结果不同）
  - **宿主实测**：`/cooccurrence?minPapers=1` → 33 对 / 5 篇；`minPapers=2` → 0 对（真实语料里没有两篇以上共现的组合，是数据现实）
  - **浏览器实测**：共现页 30 行表格、门槛 ≥2 时给出「降到 1 篇」的可操作提示、趋势页切到入库年后变为 2026 单年
- **一处 UI 调整**：门槛默认从 2 改成 1——真实小语料下 ≥2 会得到空页面，第一印象很差；空态里再提示「门槛降到 1 或再登记几篇」。

### W1.2-02 · 词典管理 + 批量 PDF ✅ **已完成**
- **FR**：2.7（词典管理）/ 1.9（批量 PDF）
- **已做**：
  - `lib/dict.js`：`addDictEntry` / `updateDictEntry` / `removeDictEntry`（内置条目**软删除**标 disabled）/ `moveDictAlias`（合并与拆分）
  - **运行时口径**：抽取不再用模块级常量，而是 `matchersFor(store)`——用户改过词典立刻生效；改动会让 `dictVersion` 变成 `x.y.z+n`
  - `radar_dictionary` 工具 + `GET/POST /dictionary` 路由 + 面板「词典」标签页（列表 / 新增 / 删除）
  - `radar_add_batch({ pdfPaths })`：批量 PDF，逐条独立
- **已验**：
  - `test/dict.test.mjs` **35/35**（新增即可被抽取命中、别名更新、口径版本联动、重算刷掉旧口径、删除需审批、软删除内置条目、别名搬移、中文名 id 不撞、错误路径）
  - `test/pdf.test.mjs` 扩到 **35/35**（批量里 1 个扫描件只让它自己失败）
  - **宿主实测**：新增「图注意力网络」→ 口径 `2026.10.1+1`，`stalePapers` 变 5；两个中文条目得到**不同 id**（`custom-502f3742` / `custom-4bae4a6d`）
  - **浏览器实测**：词典页 105 行；UI 新增（+9）→ 行出现 → UI 删除（+10）→ 行消失
- **两个真 bug（都是跑出来的）**：
  1. 中文名 slug 后成空串，所有自定义条目都生成 `custom-entry` → 第二个就撞。改成用名字短哈希兜底。
  2. `radar_reextract` 的 `changed` 只比计数，**口径版本刷新不算变化** → 重算后报 `changed=0` 却把旧口径刷掉了。补上 `versionRefreshed` 判定。
- **一处归类修正**：`radar_dictionary` 一开始放进只读工具表，但它在 `writeEnabled=false` 时不该可用 → 移到写工具表（写能力关闭时不注册）。

### W1.2 收口
5 条（批量 PDF / 词典管理 / 共现 / 封顶 / 双时间轴）全部落地。

### W2.0 收口（4/4）✅

**FR-12.2 / E23 · `radar_text`（默认不注册）**
- `textReadEnabled` 默认 **false**，此时 `radar_text` **完全不注册**
- 打开后是正文进上下文的唯一通道：单次 ≤ **8,000 字符**，带 `truncated` 与 `textIncluded:true`
- 自检清单在开关打开时把 `radar_text` 纳入 → `/state.tools` 能**证明**注册与否

**FR-7.6 · 每日自动备份**
- `backups/radar-YYYYMMDD.json`，同日不重复；保留 **7 份**；**不起定时器**（读状态时顺带检查）
- 备份是结构化快照，**不打包正文**（正文在 `texts/`，迁移要连目录一起拷）

**FR-9.6 · i18n 骨架**
- `locale/zh.json` + `locale/en.json` 为唯一真源，`GET /locale?lang=` 读取
- 客户端启动拉一次覆盖兜底；主框架 25 个键已外置

**FR-2.8 · 新词候选队列**
- `lib/candidates.js`：插件**不调 LLM**——模型发现词典外算法名时 `add` 进队列，用户在词典页 `采纳 / 忽略`
- 采纳 = 真写词典并推口径版本；**若同名已在词典里，复用已有条目、不造重复、不动版本**
- 面板词典页顶部有「待采纳候选」区块

**FR-11.3 · 首次激活引导（面板内版本）**
- 面板顶部一次性提示「说一句就能登记」，`知道了` 关闭后写入 `store.meta.guide.dismissed`，不再出现
- `welcomeGuide: false` 可整体停用
- **为什么不是会话注入**：宿主那条路是 `ctx.systemPrompt.section({name, order, text})`，`order` 取自宿主枚举，且**没有真实模型回合就无法验证它真的进了提示词**。与其发一条没验过的注入，不如在可控面上做可验证的等价引导。

**验收**
- `test/w20.test.mjs` **33/33**、`test/candidates.test.mjs` **33/33**，全库 **785 单元 + 57 端到端**，验收批 10 PASS / 0 FAIL / 9 SKIP
- **宿主实测**：默认 18 工具；`textReadEnabled:true` → 19 含 `radar_text`；`/candidates` add → approve → 词典版本 +1；同名重复被 `CONFLICT` 拒；引导条出现在标题下方、`知道了` 后消失
- **数据清理**：验证中造的词典条目（`custom-entry`、`custom-mamba`）与候选（`Mamba`、`RWKV`）均已清除/标记，配置恢复默认（正文读取关闭）

## 4. 剩余（全部为 P2 外围，且已说明取舍）

| 项 | 状态 |
|---|---|
| FR-9.6 全量文案 i18n | ⚠️ 主框架 25 键已外置；长文案仍中文（拆完要动 ~40 处 JSX，收益低） |
| `ctx.configForms` 设置表单 | ❌ 未用：它是客户端设置服务；配置走 `cordis.patch.yml`，面板已有只读设置页（FR-12.1/12.3 满足） |
| 会话内注入式引导 | ❌ 由面板内引导替代（理由见上） |


## 5. 交付验收

见根目录 `ACCEPTANCE.md`。要点：
- 24 个单元套件 **785 条**全绿；5 套端到端 **94 条**全绿；验收批 10 PASS / 0 FAIL / 9 SKIP
- 干净实例走完整用户路径：空库 → 载入示例（不计入统计）→ 临时计入 → 登记真实论文 → 排行/下钻/趋势/领域/共现/词典/locale 全可读 → 导出 → 删除 → 撤销 → 清理，**37/37**
- 未做项 3 条（全量 i18n / `ctx.configForms` / 会话注入式引导）均有明示理由
