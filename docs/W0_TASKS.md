# W0 任务清单（PAR-PRD-003 · DSH 插件版）

> 依据：`REQUIREMENTS_PLUGIN-v1.0.md` §7 的 **28 条 W0 需求**，落到 v0.2 现成代码上。
> v0.2 源码：`C:\Users\<user>\Documents\deepseek-harness\default-workspace\paper-algo-radar\index.js`（**1217 行**）
> 现网数据：`~/.dsh/plugin-data/paper-algo-radar/store.json`（**5 篇 / 105 条词典 / 16 条提及**，33 KB，2026-10-22 01:15）
> 编写日期：2026-10-22

---

## 0. 总账

| 项 | 数 |
|---|---|
| W0 需求条数 | 28 |
| 拆成任务 | **19 个**（其中 3 个是横切项） |
| **已完成** | **19 / 19** ✅ 全部完成（T-16 随 T-06 落地）。W0 的 28 条需求已全部覆盖 |
| 里程碑 | 4 个（M0 地基 → M1 工具面 → M2 视图 → M3 收口） |
| 总估时 | **约 60 小时 / 7–8 个工作日**（单人），已投入约 5 小时 |
| 能砍的 | T-10（导出）、T-16（回执卡片）——砍了不阻塞 W0 判定 |

**关键路径**：`T-02 存储` → `T-04 抽取对齐` → `T-06 radar_add` → `T-13 排行页`。这四件事串起来之前，其它任务并行意义有限。

---

## 1. 复用盘点（v0.2 到底能拿多少）

先看清哪些是白捡的、哪些是坑。行号对应 `index.js`。

| v0.2 位置 | 内容 | 状态 | 对应 FR |
|---|---|---|---|
| `31–146` `LEXICON` | 105 条词典（DL/ML/MATH + 别名） | ✅ **原样复用** | FR-2.1 |
| `151–175` `aliasCaseSensitive` / `buildPattern` / `MATCHERS` | 大小写敏感判定 + 预编译正则 | ✅ 复用，补单复数（R6.6） | FR-2.2 / 2.3 |
| `180` `stripReferences` | 参考文献截断 | ⚠️ **改造**：v0.2 只有一条正则，缺 §8 R3 的三级判定、25% 位置保护、L2 编号段落 | FR-1.3 |
| `193–205` `SECTION_HEADING` / `sectionKey` | 章节切分 | ⚠️ **改造**：键名是 `experiments`，§8 R5 要求 `experiment`；缺中文标题词 | FR-1.3 |
| `207` `normalizeText` | NFKC/换行/零宽 | ⚠️ 与 §8 R1 有出入，需逐条对齐 | FR-1.3 |
| `215–286` `scanBody` | 命中扫描 + 章节归属 + 证据片段 | ⚠️ **改造**：非重叠消费规则（R6.3）要核对，片段窗口参数要对齐 R7 | FR-2.2 / 2.5 |
| `287` `resolveStoreFile` | 数据文件路径 | ✅ 复用（保持同路径，见 D-c） | FR-7.1 |
| `292` `class Store` | Map + `writeQueue` 串行写 | ⚠️ **改造**：全量 `save()` 不是原子写，换成 tmp→fsync→rename | FR-7.2 |
| `355` `seedAlgorithms` | 词典灌入 store | ✅ 复用，补 `dictVersion` | FR-2.6 |
| `405` `ingestPaper` | 登记主流程 | ⚠️ **重写一半**：paperId 生成方式有缺陷（见 §6.1），无正文留存 | FR-1.1/1.2/1.4/1.5 |
| `468` `buildState` | 聚合出排行 | ⚠️ **改造**：排序缺 tie-break（见 §6.2） | FR-3.0 |
| `598` `buildScanTool` | `algo_scan_paper` 工具 | ✅ 骨架复用，改名为 `radar_add` 与否见 D-a | FR-1.11/1.12 |
| `628` `buildRankingTool` | `algo_ranking` 工具 | ⚠️ 改造：补 `limit/offset/truncated` | FR-3.0/3.1 |
| `675` `buildSearchTool` | `algo_search_register` | ✅ 复用（W0 走宿主 `paper_search`，见 D-d） | FR-6.1 |
| `793` `executePluginTool` + `1033` | 调宿主 `paper_search` | ✅ 复用（W0 唯一检索通路） | FR-6.1 |
| `870` `fetchArxivFullText` | arXiv HTML 抓全文 | ✅ 复用（W0 只在 search 里用到） | FR-6.1 |
| `995` `searchOpenAlex` | OpenAlex 直连 | 🔒 **W0 不用**，留给 W1.0（FR-6.2） | — |
| `1109–1196` `createHandler` + `ROUTE_BASE` | v0.2 的 HTTP 路由 | ❌ **删除**（插件版无网口，P-1） | — |
| `1197` `apply` | `ctx.effect` 注册工具 | ✅ 复用 | FR-10.3 |

**净结论**：词典、匹配、抓全文、登记主流程、聚合、工具骨架——大约 **60% 可直接挪**；存储原子性、去重键、抽取细则、视图层是主要工作量。

---

## 2. 里程碑

| 里程碑 | 内容 | 任务 | 完成标志 |
|---|---|---|---|
| **M0 地基** | 能装、能存、抽得准 | T-01 … T-05 | 单测跑通 goldens；5 篇旧数据迁移无损 |
| **M1 工具面** | 模型能登记、能查 | T-06 … T-11 | 会话里说「加进雷达」真的入库 |
| **M2 视图** | 人能看 | T-12 … T-16 | 侧栏点开看到排行 |
| **M3 收口** | 不出丑 | T-17 … T-19 | E0/E5/E6/E21 + A2 全绿 |

---

## 3. 任务清单

### M0 地基

#### T-01 · 包骨架与加载（2h）✅ **已完成**
- **FR**：10.1 / 10.2 / 10.3 / 10.5 / 10.6
- **已做**：建 `paper-algo-radar/`（宿主侧 1217 行原样搬入，零依赖保持）；`package.json` 补 `dsh.manifestVersion: 1`、`bundle.patch`、`client.inject`、`engines`；`cordis.patch.yml` 插入行；`icon.svg` + `locale/` 随包。
- **已验**：装入隔离 profile → 插件加载、三个工具注册、六条 exact 路由生效。
- **还差**：`apply()` 里 `await store.load()` + `seedAlgorithms()` 是**加载期写盘**，违反 FR-10.5。见 §5.4，留给 T-18。
- **验收**：E21 未过（见上）；E8 靠 `engines` 声明，未做运行时校验。

#### T-02 · 存储改造：三键去重 + 原子写（6h）✅ **已完成**
- **FR**：1.2 / 7.1 / 7.2
- **已做**：
  1. `paperKeys` 三键倒排（`doi:` / `arxiv:` / `title:<sha1前16>`），登记时三键同查；老快照没有索引时**就地重建**。
  2. `paperId` 改为 `p_<16hex>`（`randomBytes`），不再由年份派生；**旧 id 保持不变**。
  3. `save()` 加 `fsync` + `store.json.bak` 备份；仍是 tmp → rename。
  4. 补登记语义：新值优先、缺省沿用旧值（先无年份后补年份 → 同一篇、年份更新）。
  5. `removePaper` 同步清键；`in` 参的 `doi` 位能自动认出 arXiv id 并分流。
- **已验**：`test/dedupe.test.mjs` **37/37**；`test/e2e-scan.mjs` 走真实宿主路由 **12/12**（E10 核心用例已过）。
- **落盘实证**：快照 `version:2`、5 篇 16 提及、9 条 `paperKeys`、`store.json.bak` 存在。
- **遗留**：正文分片 `texts/` 尚未接（属 FR-7.7 / W1.0）；旧提及没有 `dictVersion`（预期，迁移时补 `v0.2-legacy`，见 T-03）。

#### T-03 · 迁移器：读现有 store.json（3h）✅ **已完成**
- **FR**：7.1（W0 只要「读得起来」；正式导入是 W1.0 的 FR-7.4）
- **已做**：新增 `lib/migrate.js`（纯函数，不改入参、不碰磁盘），`Store.load()` 里调用：
  - 合法 `p_<16hex>` id 沿用，非法则换新**并同步改提及引用**
  - `depth` 缺失时按 `chars ≥ 300 ? fulltext : abstract` 推断
  - `doi` 小写归一、去 `doi.org/` 前缀；`arxivId` 去壳
  - 提及补 `dictVersion:'v0.2-legacy'`、`role:null`；`sections.experiments` → `experiment` 并补齐 8 个键
  - `hasText/rawChars/textHash/isSample/status/dedupeKey` 全部补齐
  - 以论文为准重建三键；同标题两篇记 `keyConflicts` 并保留先到的
  - 孤儿提及（论文已不存在）丢弃并计数
- **已验**：`test/migrate.test.mjs` **42/42**：合成快照（id 重映射、depth 推断、键冲突、孤儿、幂等）+ **真实 v0.2 文件只读校验**。
- **端到端实测**：把真实的 v1 `store.json`（5 篇 / 16 提及）放进隔离实例重启，`/state` 返回 `{fromVersion:1, toVersion:2, changed:true, papers:5, mentions:16, keysBuilt:9, sectionsRenamed:16, dictVersionBackfilled:16, rolesFilled:16, depthInferred:1, droppedMentions:0}`，面板数字不变（5 / 13 / 124）。
- **注意**：迁移**不在加载期写盘**（`migrationPending` 标记留给下次写入），符合 FR-10.5；代价是每次启动都重算一遍（纯函数、毫秒级）。

#### T-04 · 抽取引擎对齐 §8（8h）✅ **已完成**
- **FR**：1.3 / 2.1 / 2.2 / 2.3
- **已做**：新建 `lib/extract.js`（纯函数，零依赖、零 IO），`index.js` 里 121 行旧实现整块删除，不再有第二份口径。
  - **R1** NFKC→NFC、换行统一、零宽/双向字符（含 `U+202A–202E`、`U+2060`）、≥3 换行折叠
  - **R2** 页码行 + 重复行剔除（≥3 次、≤60 code point；章节关键词行保留）——v0.2 完全没有
  - **R3** L1/L2 三级截断 + `max(25%, 3000)` 阈值 + `refHintEarly` + `refCut` 记录
  - **R4** 40 万 code point 上限（`sliceCodePoints` 不切代理对）
  - **R5** 行级章节扫描：trim ≤80、不以句末标点结尾、含中文或 ASCII 字母 ≥3、中英关键词表、键名统一 `experiment`
  - **R6** 四段确定性排序、条目级大小写敏感、中文别名无边界、ASCII 边界含 `_`、单复数生成
  - **R7** 窗口 −60/+140、≤200 code point、跨章节优先、同章节相隔 ≥500
  - **R8** `suspect:short` / `suspect:extract` 告警
- **已验**：`test/extract.test.mjs` **60/60**（规则级，含确定性与"输出无时间戳"断言）；去重 37/37、端到端 12/12 回归通过。
- **未验**：§12.1 的 A1（19 个算法）/ A2 / A3 需要 v0.2 的样例正文，当前只有规则级测试，**这三条不能算过**。
- **注意**：新引擎只影响新登记；现有 16 条提及仍是旧引擎产物，等 W1.0 重算才会刷新。

#### T-05 · dictVersion 落地（1h）✅ **已完成（部分）**
- **FR**：2.6 的 W0 部分（完整重算在 W1.0）
- **已做**：`DICT_VERSION = '2026.10.1'` 常量；新写入的每条提及都带 `dictVersion`；快照 `schemaVersion` 升到 2。
- **还差**：迁移时为 v0.2 的旧提及回填 `dictVersion:'v0.2-legacy'`（并入 T-03）；面板上的「旧口径」标记（T-13 收尾）。

### M1 工具面

#### T-06 · `radar_add`（4h）✅ **已完成**
- **FR**：1.1 / 1.2 / 1.4 / 1.5 / 1.11 / 1.12
- **已做**：
  - `algo_scan_paper` → **`radar_add`**；顺带把另外两个也统一成 `radar_ranking` / `radar_search`（`algo_` 前缀已清零）。
  - 入参扩到 9 个：新增 `arxivId`、`depth`（enum）、`source`；`doi` 描述里写明会自动认 arXiv。
  - 出参改成文档口径：`{ paper, created, hits[{id,name,type,count}], total, chars, depth, warnings[] }`，并带 `refCut` / `refHintEarly` 供排查。
  - **`output.render` 做成紧凑回执**：标题（>48 字截断）+ `N 个算法 · 字符数 · 深度 · ⚠告警` + 前 3 个命中 + 「其余 N 个略」，**硬保证 ≤6 行**（FR-9.8），且不回显正文。
- **已验**：`test/tools.test.mjs` **29/29**（命名空间、入参契约、输出声明、卡片行数与内容、覆盖更新文案、零命中、value 缺失不抛）；端到端 **16/16**（新增 chars / depth / hits / 无正文 四条断言）。
- **注意**：`radar_search` 是过渡名，T-08 会拆成 `radar_discover`（只列候选）+ `radar_add_batch`。

#### T-07 · `radar_ranking` / `radar_papers`（3h）✅ **已完成**
- **FR**：3.0 / 3.1
- **已做**：
  - 排行重写：`rankBy`（papers / mentions）、`type`、`q` 过滤，`limit/offset/total/truncated` 分页。
  - **三级排序**：论文数 desc → 提及数 desc → 规范名 asc（**码位序** `compareCodePoints`）。`localeCompare` 已清零，§5.3 关闭。
  - **覆盖率**：`coverage = papers / denominator`，四位小数；`denominator` 随 `type`/`q` 筛选变化（§8 R9）。
  - 新增 `radar_papers`：q / field / yearFrom / yearTo / depth / hasText 筛选 + 分页，按登记时间倒序，**不含正文字段**。
- **已验**：`test/ranking.test.mjs` **43/43**。

#### T-08 · `radar_discover` + `radar_add_batch`（3h）✅ **已完成**
- **FR**：6.1（`radar_search` 已按 §10.1 拆开）
- **已做**：
  - `radar_discover`：**只列候选不登记**。每条带标题 / 年份 / 会议 / 引用数 / arXiv / 摘要是否够长 / **`inLibrary`（三键判定是否已在库）** / 摘要前 200 字预览。
  - `radar_add_batch`：批量登记，**逐条独立**——单条失败只影响该条，结果按 `index` 回报 `ok / paperId / depth / algorithms / error`；上限 10 条，串行执行（满足「并发 ≤2」的上界）。
  - `radar_search` 已删除，工具名清单同步更新（读 4 个 / 写 2 个）。
- **已验**：`test/tools.test.mjs` **35/35**；宿主实测注册 6 个：`radar_ranking, radar_papers, radar_status, radar_discover, radar_add, radar_add_batch`。
- **未验**：B1（检索「空气质量预测」返回 8 篇左右）——依赖宿主 `paper_search` 插件与网络，隔离实例没有凭据。**这条不能算过**。
- **待补（W1.1）**：多源并行与失败源上报（FR-6.2 / 6.3）、逐条进度与取消（FR-6.10）。

#### T-09 · `radar_status`（1h）✅ **已完成**
- **FR**：§10.1 GET /overview 的模型侧入口
- **已做**：返回口径版本、快照版本、论文 / 算法 / 提及 / 仅摘要数、**旧口径提及数**、数据文件路径与体积（`stat`）、已注册工具、能力标记、上次迁移报告。
- **已验**：`test/status.test.mjs` [3][4] 段；`/state` 里也带 `tools` / `migration` / `dictVersion`。

#### T-10 · `radar_export`（3h）✅ **已完成**
- **FR**：7.3
- **已做**：JSON（论文 / 算法 / 提及 / 三键 / meta，带 `schemaVersion` + `dictVersion`）与 CSV（排行，带 BOM）两种；写到 `<store>.dir/exports/radar-<时间戳>.<ext>`；**只返回 `{path, bytes, papers}`，内容不进上下文**。
- **诚实处理**：`includeText=1` 时若正文还没留存（W1.0 之前），回报 `hasTextIncluded:false` 并在卡片里说明，而不是假装带了。
- **已验**：`test/export.test.mjs` **22/22**（结构完整性、BOM、表头、返回值不含正文、目录位置）。

#### T-11 · 工具契约收口（4h）✅ **已完成（W0 部分）**
- **FR**：8.1 / 8.2 / 8.3 / 8.4 + **R12**
- **已做**：新增 `lib/contract.js`：
  - `READ_TOOL_NAMES` / `WRITE_TOOL_NAMES` 常量（宿主策略与测试共用）
  - `paginate()` 统一 `limit/offset/total/truncated`；`limit` 夹到 50、`offset` 越界返回空页
  - `boundResult()` 单次返回 ≤ 12,000 字符，超限按数组字段收窄并记 `truncatedFields:[{field, shown, total}]`，**不静默丢**
  - `compareCodePoints()` 取代 `localeCompare`
  - 排行 / 论文两个工具都过 `boundResult`
  - **注册自检**：`apply()` 里注册完回查 `ctx.tools.get()`，结果写进 `/state.tools`——实测输出 `radar_ranking, radar_papers, radar_add, radar_search`
- **已验**：`test/ranking.test.mjs` 的 [1]–[3] 段。
- **还差（W1.0）**：`dryRun` 默认、`writeEnabled` 能力开关、写审批（FR-8.5–8.7）。

### M2 视图

#### T-12 · 客户端骨架（3h）✅ **已完成，且超额**
- **FR**：10.1 的客户端部分
- **已做**：新写 `lib/client.js`（零构建，手写 `__ModuleLoader__` 格式），注册 `sidebar.panellist` + `main` 双槽位；**已接真实数据**——`fetch('/paper-algo-radar/state')` 渲染排行，含类型筛选、覆盖率条、年份区间、加载/空/错误三态、刷新按钮、数据文件路径页脚。
- **已验**（隔离实例 + 真实 `store.json`）：侧栏出现「论文算法雷达」；点开显示 5 篇 / 13 个算法 / 124 次提及；排行 CNN 2/45、SVM 2/4、LSTM 1/59；覆盖率条 40%/20%；深浅色跟随。
- **证据**：`spike/evidence/radar-w0-light.png`、`radar-w0-dark.png`。
- **顺带覆盖了 T-13 的大半**：表格、统计串、筛选、覆盖率条都在了。T-13 剩下的只有「按 `order` 调位置、旧口径标记」。

#### T-13 · 排行页（6h → 剩约 2h）✅ **已完成**
- **FR**：3.1 / 9.7
- **已做**：统计串 + 排行表 + 类型筛选 + 覆盖率条 + **旧口径标记**（算法名后的圆点 + 顶部「待重算 N 篇」徽标）。
- **宿主侧**：`buildState` 现在给每个算法带 `stale`，并给出 `staleMentions` / `stalePapers`。
- **已验**：`test/ranking.test.mjs` [9] 段（stale 计数与不误标）；隔离实例实测显示「待重算 5 篇」+ 每行圆点。

#### T-14 · 论文列表 + 下钻入口（4h）✅ **已完成（W0 部分）**
- **FR**：S-b
- **已做**：面板加「算法排行 / 论文」两个标签页；论文页按登记时间倒序，每行给标题、年份、会议、深度（全文 / 仅摘要）、领域标签、命中算法数与前 2 个算法。
- **已验**：隔离实例实测切到论文页，显示真实语料 5 篇（命名实体识别方向），标题 / 年份 / 深度 / `迁移学习×3 · CNN×2` 都对。
- **下钻详情**（点进单篇看证据片段）属 W1.0 的 FR-3.5。

#### T-15 · 加载 / 空 / 错误三态（3h）✅ **已完成**
- **FR**：9.7
- **已做**：loading（「正在读算法库…」）、空库（说清三种登记路径 + 「重新读取」）、读失败（显示后端 `error.message` 而不是裸 HTTP 码 + 「重试」）。
- **已验**：`data-radar-state` 属性可被探针读到（`loading` / `ready` / `error`），隔离实例实测为 `ready`。

#### T-16 · 回执卡片（2h）✅ **已随 T-06 完成**
- **FR**：1.12 / 9.8
- **已做**：`radar_add` 的 `output.render` 输出「已登记 / 已更新 + 标题」、`N 个算法 · 字符数 · 深度 · ⚠告警`、前 3 个命中与「其余 N 个略」，硬保证 ≤6 行且不回显正文。
- **已验**：`test/tools.test.mjs` [4] 段（行数、内容、覆盖更新文案、零命中、value 缺失不抛）。

### M3 收口

#### T-17 · typed error（3h）✅ **已完成**
- **FR**：横切（§10.3 错误码表）
- **已做**：新增 `lib/errors.js`（12 个错误码 + HTTP 映射 + `RadarError` + `toErrorPayload` / `toHttpError`）。全文 7 处裸 `throw new Error` 全部换成 `RadarError(code, message, {field})`；路由层统一回 `{ ok:false, error:{ code, message, field? } }`，**不回显堆栈与正文**；`radar_add_batch` 的逐条失败也带 `code`。
- **已验**：`test/errors.test.mjs` **23/23**（词汇表、映射、payload 形状、真实路径抛出的 code 与 field）。

#### T-18 · 加载期零副作用审计（2h）✅ **已完成**
- **FR**：10.5 / 10.6
- **已做**：`apply()` 改**惰性**——`getStore()` 缓存 Promise，工具与路由在第一次真正用到时才 `await`；打开失败会清缓存允许重试。加载期不再 `load()`、不再 `seedAlgorithms()`（后者会写盘）。
- **已验**：`test/status.test.mjs` **24/24**：
  - 加载后数据目录**只有 store.json**，没有 `.bak` / `.tmp`，文件**一字节未变**，仍是 `version:1`（证明没读盘也没迁移落盘）
  - 五个工具全注册且名字与常量一致
  - 调用 `radar_status` 才触发打开，返回真实计数
  - **数据文件损坏时 `apply` 不抛**，错误推迟到真正用到存储时——插件不会因为一份坏文件整块加载失败
- **遗留**：`setTimeout/setInterval` 全量复核（当前 grep 为 0）并入 T-19。

#### T-19 · W0 验收跑批（4h）✅ **已完成**
- **FR**：全部
- **已做**：`test/acceptance.mjs` 跑 §12 用例，每条给 **PASS / FAIL / SKIP** 三态。
- **实测**：**PASS 9 / FAIL 0 / SKIP 10**
  - PASS：A2、A2b、C1、E10、E15、E16、E19、E21、E6(前半)
  - SKIP（需网络 / 凭据 / 人工）：A1、A3、A4、B1、E2、E3、E4、E13、E22、D1
- **A2b 的实测发现**：它测的是「3000 code point 地板」而非 25% 比例。28% 落到 15k 字的文本里是 4200cp，**超过** 3000 → 应该正常截断；只有总量 ~10k、28% ≈ 2800cp 时才落在地板下。原用例描述容易读成「28% 永远不截断」，已在本任务里写清。
- **退出条件**：见 §7。SKIP 项不计入「已通过」。

---

## 4. 待拍板的五件事

**D-a · 工具名前缀：`algo_` 还是 `radar_`？→ 已定 `radar_`（2026-10-22）**
文档 §10.1 写的是 `radar_*`，v0.2 代码是 `algo_*`。
本会话里 `algo_*` **当前未加载**，改名没有运行时兼容问题；已随 T-06 一次性改净：`radar_add` / `radar_ranking` / `radar_search`（最后一个 T-08 会再拆）。仓库里 `algo_` 出现次数 **0**。

**D-b · `sections` 键名**
v0.2 用 `experiments`，§8 R5 用 `experiment`。
→ **按 §8 统一为 `experiment`**，迁移器做一次键名映射。别留两套。

**D-c · 数据目录**
现网数据在 `~/.dsh/plugin-data/paper-algo-radar/store.json`（5 篇）。
→ **原地沿用这个路径**，只新增 `texts/` 与 `.bak`。换目录会让用户以为数据丢了。

**D-d · 检索来源（与 P-7 有张力）**
P-7 定的是「插件自带 OpenAlex/Crossref/arXiv」。但 v0.2 走的是宿主 `paper_search`（`793`/`1033`），现成能用。
→ **W0 先用宿主 `paper_search`**（FR-6.1 只要求能检索），**W1.0 再换自带客户端**（FR-6.2 多源并行时）。需要把 P-7 改成「W1.0 生效」，否则 W0 就违背了自己的决策。
> 这条要你点头，因为它动的是决策记录，不是实现细节。

---

**D-e · 面板取数通道：`webServer` 路由 vs `ctx.remote`？**
→ **用 `webServer` 的 exact 路由**（`GET /paper-algo-radar/state`）。已实测跑通、代码量小、v0.2 与 `dsh-paper-algo-radar` 都在用。`ctx.remote`（typert 契约）留到以后需要双向推送时再说。
> 影响：需求文档 §6 表面规则第 1 条已按此改写（原本写死 `ctx.remote.radar.*`）。

## 5. 我在 v0.2 代码里发现的四个缺陷（W0 必须修）

### 5.1 `paperId` 把年份编进了主键 → 重复登记会多一篇 ✅ **已修（T-02）**
```js
// 修复前 index.js:423
const paperId = `p_${digest([doi, String(year ?? ''), title...].join('|'))}`
```
先用「无年份」登记得到 `p_A`，再用「补了年份」登记得到 `p_B` —— 同一篇论文变成两条。
这正是网站版 §0.4 第 1 条指出的「去重主键自相矛盾」，v0.2 里仍然存在。
**已改成三键索引 + 随机 id**，迁移时保留旧 id（`test/dedupe.test.mjs` 第 3 段覆盖）。

### 5.2 排行排序缺 tie-break → 同分顺序不稳定
```js
// index.js:657
.sort((a,b) => (sortBy==='mentions' ? b.mentions-a.mentions : b.papers-a.papers) || b.papers-a.papers)
```
同论文数、同提及数的两项，顺序取决于 Map 插入序 —— 违反 §8 R9「键顺序固定、禁用插入序」。
**T-07 补第三级：规范名 asc（码位比较）。**

### 5.3 `localeCompare` 排序（已随 T-07 修）
```js
// 修复前 index.js:510
algorithms.sort((a, b) => b.papers - a.papers || b.mentions - a.mentions || a.name.localeCompare(b.name))
```
第三级用了 `localeCompare` —— §8 **G-5 明令禁用**（结果随系统 locale 变，破坏可复现）。而且它排的是 `name`，混了中英文时顺序在不同机器上会不同。
**已换成 `compareCodePoints()`**（`lib/contract.js`，逐 code point 比较），并有测试断言 `Z < a < 中`。

### 5.4 `apply()` 里同步加载存储（新发现，2026-10-22）
```js
// index.js:1197-1201
export async function apply(ctx) {
  const store = new Store(resolveStoreFile())
  await store.load()
  await seedAlgorithms(store)   // ← 会写盘
```
加载插件就做了一次读盘 + 可能的写盘，违反 FR-10.5「加载期零副作用」。
而且实测有个副作用很坑：**宿主启动后才往数据目录放 `store.json`，面板会一直显示空库**——因为内存里已经 load 过了，不会重读。想看到新数据必须重启宿主。
**T-18 改成惰性初始化**（`getStore()` 缓存 Promise，工具与路由里 `await`），顺带解决「换数据要重启」这个体验问题。

### 5.5 条目级大小写敏感写成了别名级（已随 T-04 修）
v0.2 的判定是**逐别名**的：
```js
function aliasCaseSensitive(alias) {
  return ALL_CAPS_SHORT.test(alias) && HAS_UPPER.test(alias) && !alias.includes(' ')
}
```
于是 `{ aliases: ['CNN', 'convolutional neural network'] }` 这个条目里，`CNN` 大小写敏感、`convolutional neural network` 却不敏感——违反 §8 R6.5「**条目内**任一别名满足条件 ⇒ 全条目精确比较」。
后果：同一算法在不同文本里表现不一致，排行无法解释。
**已改成条目级判定**（`entryCaseSensitive(aliases)`）。

### 5.6 中文别名被加了 ASCII 边界断言（已随 T-04 修）
v0.2 给**所有**别名都包了 `(?<![A-Za-z0-9])` / `(?![A-Za-z0-9])`。§8 R6.7 明确要求：中文别名**不加任何边界断言**。
后果很具体：`本文使用LSTM注意力机制` 里的「注意力」前面紧贴 `M`，被 lookbehind 判掉——中文论文里最自然的写法直接漏计。
**中文别名现在走无边界分支**，`test/extract.test.mjs` 有对应断言。

---

## 6. 排期建议（单人）

> D1（T-01 / T-12）、D2（T-02 / T-05）、D3（T-04）都已完成。**W0 的关键路径已经打通**，剩下的都是横向铺开。

| 天 | 内容 |
|---|---|
| ~~D1~~ | ~~T-01 + T-12~~ ✅ 已完成（含 T-13 大半） |
| ~~D2~~ | ~~T-02 + T-05~~ ✅ 已完成（37 + 12 条测试全绿） |
| ~~D3~~ | ~~T-04 抽取引擎~~ ✅ 已完成（60 条测试） |
| ~~D4~~ | ~~T-06 `radar_add`~~ ✅ 已完成（29 + 16 条测试） |
| ~~D4b~~ | ~~T-03 迁移器~~ ✅ 已完成（42 条测试 + 真实数据端到端） |
| ~~D5a~~ | ~~T-07 + T-11~~ ✅ 已完成（43 条测试） |
| ~~D5~~ | ~~T-08 + T-09~~ ✅ 已完成 |
| ~~D6~~ | ~~T-13 + T-14 + T-15 + T-17~~ ✅ 已完成 |
| ~~D7~~ | ~~T-10 + T-19~~ ✅ 已完成 —— **W0 收口** |

**收尾留半天**：跑隔离实例、截图、把结论回填文档 §12.2。

> **W0 已完成（2026-10-22）**：19/19 任务、308 条测试全绿、验收批 9 PASS / 0 FAIL / 10 SKIP。下一步进 W1.0。

---

## 7. W0 完成的定义

全部满足才算 W0 交付（对照 §12.2）：

- [ ] 会话里说「把这篇加进雷达」→ 入库 + 回执，**上下文里没有任何正文片段**
- [ ] 侧栏点开「算法雷达」→ 排行表可用，切深浅色正常
- [ ] A1 / A2 / A2b / A3 / B1 / E10 / E15 / E19 / E21 全绿
- [ ] 现有 5 篇数据迁移后数量与排行前三不变（E16 形态）
- [ ] `grep -r "setTimeout\|setInterval" lib/` 只在 `execute` 路径里
- [ ] 卸载插件后侧栏不留空壳

---

## 8. 怎么跑测试

三套，都不需要测试框架。

```powershell
cd paper-algo-radar

# 1) 抽取引擎：§8 R1–R8 的规则级测试（不需要宿主）
node test\extract.test.mjs

# 2) 工具契约：命名空间、入参/出参 schema、卡片行数（不需要宿主）
node test\tools.test.mjs

# 3) 迁移器：v0.2 快照 → 当前版本（含真实文件只读校验）
node test\migrate.test.mjs

# 4) 排行 / 论文列表 / 契约件：分页、码位序、返回体预算（不需要宿主）
node test\ranking.test.mjs

# 5) 三键去重 / 补登记 / 删除清键 / 原子写 / 老快照重建（不需要宿主）
node test\dedupe.test.mjs

# 6) 加载期零副作用 + radar_status（不需要宿主）
node test\status.test.mjs

# 7) typed error 词汇与映射（不需要宿主）
node test\errors.test.mjs

# 8) 导出（落盘 + 只回路径）
node test\export.test.mjs

# 9) W0 验收批（§12 用例，PASS/FAIL/SKIP 三态）
node test\acceptance.mjs

# 10) 端到端：走真实宿主进程与 /paper-algo-radar/* 路由
#    先起隔离实例，从 stdout 拿 token
node test\e2e-scan.mjs http://127.0.0.1:52699 <token>
```

当前：**抽取 60 / 工具 35 / 迁移 42 / 排行 49 / 去重 37 / 状态 24 / 错误 23 / 导出 22 / 端到端 16，合计 308 条，全绿**；另有 `test/acceptance.mjs` 跑 §12 验收批（9 PASS / 0 FAIL / 10 SKIP）。

端到端脚本做的事：用 token 换 cookie → 读基线 → 登记一篇 → **补年份再登记（E10）** → 断言 id 不变、年份更新、论文数只 +1 → 删除 → 断言回到基线。跑完不留脏数据。

## 9. 下一步

已完成：**T-01 / T-02 / T-03 / T-04 / T-05 / T-06 / T-12**。数据层与抽取层都齐了：老快照能就地升级，新登记走三键去重，工具名统一 `radar_`，184 条测试兜底。

接下来：

1. **T-07 / T-08 / T-09 / T-11** —— 排行补三级排序与分页（顺手清 §5.3 的 `localeCompare`）、检索拆 `radar_discover` + `radar_add_batch`、`radar_status`、工具契约收口。
2. **T-18** —— `apply()` 惰性化，去掉加载期写盘（现在 `load()` + `seedAlgorithms()` 还在 apply 里同步跑）。
3. **T-13 收尾** —— 面板上把 `migration` 与「旧口径」标出来（`/state` 里已经带了 `migration` 与 `dictVersion`）。
4. 补 §12.1 的 A1/A2/A3 样例正文：现在只有规则级测试，**那三条验收还没算过**。
