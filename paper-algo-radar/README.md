# dsh-paper-algo-radar

论文算法雷达 —— DSH 插件。把读过的论文转成「算法 × 章节 × 年份 × 领域」的结构化记录，给出排行。

对应需求：`REQUIREMENTS_PLUGIN-v1.0.md`（PAR-PRD-003）；任务拆解：`W0_TASKS.md`。

## 现在是什么状态

**W0 骨架已可运行**（T-01 + T-12 完成，顺带吃掉 T-13 大半）：

| 能力 | 状态 |
|---|---|
| 包形态 / manifest / bundle 安装 | ✅ 已验证 |
| 侧栏入口 + 主区整宽视图（`sidebar.panellist` + `main`） | ✅ 已验证 |
| 排行表（论文数 / 提及数 / 覆盖率条 / 年份区间 / 类型筛选） | ✅ 已验证，读真实数据 |
| 论文标签页（标题 / 年份 / 会议 / 深度 / 领域 / Top 算法） | ✅ 已验证 |
| 旧口径标记（行内圆点 + 「待重算 N 篇」徽标） | ✅ 已验证 |
| typed error（12 个错误码 + HTTP 映射） | ✅ 已实现并测试 |
| 加载 / 空库 / 读失败 三态 | ✅ 已实现 |
| 深浅色跟随（只用宿主 token） | ✅ 已验证 |
| 三个工具（`radar_add` / `radar_ranking` / `radar_search`） | ✅ 已统一 `radar_` 前缀；`radar_add` 出参为 `hits/chars/depth/warnings` |
| **回执卡片**（≤6 行，不回显正文） | ✅ 已实现并测试 |
| **v0.2 快照就地迁移**（version 1 → 2） | ✅ 已实现，真实数据实测通过 |
| **导出到文件**（JSON / CSV，内容不进上下文） | ✅ 已实现并测试 |
| **W0 验收批**（PASS/FAIL/SKIP 三态） | ✅ 9 PASS / 0 FAIL / 10 SKIP |
| **三键去重（doi / arxiv / title）+ 补登记语义** | ✅ 已实现并测试（E10 通过） |
| **原子写（fsync + rename）+ `.bak` 备份** | ✅ 已实现并测试 |
| **`dictVersion` 写入每条提及** | ✅ 已实现（旧提及待迁移回填） |
| **抽取引擎 §8 R1–R8** | ✅ 独立成 `lib/extract.js` 纯函数，60 条规则级测试 |
| **正文留存 `texts/`（gzip + sha1）** | ✅ 已实现并测试（W1.0） |
| **原地重算 `radar_reextract`（默认 dryRun）** | ✅ 已实现并测试（W1.0） |
| **导入 `radar_import`（三种形态 / dryRun / merge·overwrite）** | ✅ 已实现并测试（W1.0） |
| **算法下钻详情**（工具 + 面板点击进入） | ✅ 已实现并测试（W1.0） |
| **`/radar` 命令**（status / reextract / export） | ✅ 已实现；宿主内 `registered: true` |
| **写能力开关 `writeEnabled`**（关闭即不注册写工具 + 写接口 403） | ✅ 已实现并实测 |
| **破坏性操作写审批**（`overwrite` 导入） | ✅ 已实现；无审批通道时失败关闭 |
| **快速添加（DOI / arXiv）** | ✅ 已实现；真网络实测抓到 13.5 万字符全文 |
| **多源并行检索（自带 OpenAlex/Crossref/arXiv）** | ✅ 已实现；真网络三源全通 |
| **撤销 / 清空 / 恢复**（10 秒窗口，正文一起回来） | ✅ 已实现并实测 |
| **趋势视图（行=算法 × 列=年份 网格）** | ✅ 已实现并实测 |
| **领域分布（横向条形）** | ✅ 已实现并实测 |
| **类型 / 关键词 / 领域筛选 + 分母跟随** | ✅ 已实现并实测 |
| **示例数据包**（默认不计入统计，可载入/清除/转正） | ✅ 已实现并实测 |
| **空状态三入口** | ✅ 已实现并实测 |
| **响应式（720px 降级）** | ✅ 已实现，624px 实测通过 |
| **图表表格视图**（可访问性） | ✅ 趋势 / 领域各一套 |
| **检索限速 + 5 分钟缓存** | ✅ 已实现并测试 |
| **PDF 登记（子进程解析 + 超时强杀 + 不留原件）** | ✅ 已实现并实测 |
| **共现分析**（同篇算法对 + lift） | ✅ 已实现并实测 |
| **每篇封顶计数**（可配，保留 rawMentions） | ✅ 已实现并测试 |
| **双时间轴**（发表年 / 入库年） | ✅ 已实现并实测 |
| **词典管理**（增删改 / 别名搬移 / 软删除 / 口径版本联动） | ✅ 已实现并实测 |
| **批量 PDF**（逐条独立） | ✅ 已实现并测试 |
| **正文读取开关**（`textReadEnabled`，关闭时 `radar_text` 不注册） | ✅ 已实现并实测 |
| **每日自动备份**（保留 7 份，不起定时器） | ✅ 已实现并测试 |
| **i18n 骨架**（`locale/*.json` + `/locale` 路由） | ✅ 主框架文案已外置 |
| **新词候选队列**（`radar_candidates`，同名自动复用） | ✅ 已实现并实测 |
| **设置页**（数据位置 / 体积 / 备份 / 能力，只读） | ✅ 已实现并实测 |
| **首次激活引导**（面板内一次性，可关） | ✅ 已实现并实测 |

实测证据：`spike/evidence/radar-w0-light.png`、`radar-w0-dark.png`（5 篇 / 13 个算法 / 124 次提及）。

## 结构

```
package.json          dsh.manifestVersion / bundle.patch / client.inject / engines
cordis.patch.yml      安装为 bundle 时的插入行（id: paper-algo-radar）
lib/index.js          宿主侧：词典 + 存储 + 三个工具 + 六条 exact 路由（零依赖，仅 Node 内建）
lib/extract.js        纯函数抽取引擎：§8 R1–R8，零 IO、零配置、可单测
lib/migrate.js        快照迁移：v0.2（v1）→ 当前（v2），纯函数、幂等
lib/errors.js         错误码表 + RadarError + HTTP 映射（§10.3）
lib/texts.js          正文留存：gzip 落盘 + 读回 + 删除（§8 R11）
lib/importer.js       导入：形态识别 + 计划/执行分离 + merge·overwrite
lib/command.js        /radar 命令（零依赖，可选 commands 服务）
lib/approval.js       写审批闸门（失败关闭）
lib/net.js            出站 HTTP：超时 + 主机白名单 + 可注入 fetch
lib/sources.js        OpenAlex / Crossref / arXiv 三源并发 + 合并去重 + 轮转
lib/undo.js           撤销栈：懒过期，窗口内保留正文
lib/samples.js        示例数据包：6 篇可抽取正文
lib/pdf.js            零依赖 PDF 文本提取（FlateDecode + 文本算子）
lib/textquality.js    正文可用性判定：控制符/私用区/常见文字占比，拦住字形码与二进制
lib/pdf-worker.mjs    PDF 解析子进程入口
lib/pdfrun.js         子进程封装：超时 SIGKILL + 可注入
lib/dict.js           词典管理：运行时匹配器 + 口径版本
lib/backup.js         每日备份：7 份保留，懒触发
lib/candidates.js     新词候选队列（插件不调 LLM）
lib/keys.js           论文三键与 DOI / arXiv 归一（index 与 migrate 共用）
lib/client.js         客户端：手写模块加载器格式，零构建；注册双槽位 + 排行视图
icon.svg  locale/     图标与文案
scripts/              一次性维护脚本：repair-corrupt-texts.mjs（清历史乱码正文，默认 dry-run）
test/                 816 单元 + 57 端到端（抽取 60 / 工具 37 / 迁移 42 / 排行 49 / 去重 37 / 状态 24 / 错误 23 / 导出 26 / 留存重算 29 / 导入 41 / 下钻 26 / 命令 28 / 闸门 27 / 多源 39 / 轮转 5 / 撤销 48 / 趋势 28 / 示例 39 / 限速 12 / PDF 41 / 共现 29 / 词典 35 / W2.0 33 / 候选 33 / 正文质量 25 / e2e 16+13+15+13）+ 验收批
```

**宿主侧刻意保持零依赖**：插件以符号链接方式安装时，裸包名（`@deepseek-ai/*`）在工作区路径下解析不到。客户端不受此限——它走 `__ModuleLoader__`，可以 `require('react')`。

## 数据通道

- 客户端：`fetch('/paper-algo-radar/state')`（同源，无需鉴权头）
- 宿主：`ctx.inject(['webServer'])` → `webServer.register({ kind: 'exact', path, handler })`
- 端点：`state` / `scan` / `search` / `register-one` / `remove` / `export`

## 安装

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
node "C:\Users\<user>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.mjs" `
  add "link:C:/Users/<user>/Documents/1_Mycode/dsh_plugin_design/paper-algo-radar"
```

再把 `dsh-paper-algo-radar` 加进 `package.json` 的 `dsh.profile.bundles`，**重启应用**。

## 测试

```powershell
node test\extract.test.mjs                                  # 抽取引擎：60 条，不需要宿主
node test\tools.test.mjs                                    # 工具契约：35 条，不需要宿主
node test\migrate.test.mjs                                  # 迁移器：42 条，含真实文件只读校验
node test\ranking.test.mjs                                  # 排行/论文/契约件/旧口径：49 条，不需要宿主
node test\dedupe.test.mjs                                   # 去重与原子写：37 条，不需要宿主
node test\status.test.mjs                                   # 加载期零副作用 + radar_status：24 条
node test\e2e-scan.mjs http://127.0.0.1:52699 <token>        # 端到端：16 条，走真实路由
```

合计 **816 条单元 + 57 条端到端**，外加验收批 **10 PASS / 0 FAIL / 9 SKIP**。端到端脚本会真实登记一篇「T-02 端到端验证论文」、补年份再登记一次、断言同一篇、确认返回体里没有正文，然后删掉自己——跑完不留脏数据。

| 工具 | 说明 |
|---|---|
| `radar_add` | **三种用法**：粘贴正文（title+text）/ 快速添加（`input` 给 DOI 或 arXiv）/ PDF（`pdfPath`）。出参 `{paper, created, hits[], total, chars, depth, warnings[], pdf?}`，**不含正文** |
| `radar_ranking` | 算法排行。`rankBy` / `type` / `q` + 分页；给出 `coverage` 与 `denominator` |
| `radar_papers` | 论文列表。q / field / 年份区间 / depth / hasText 筛选 + 分页，不含正文 |
| `radar_status` | 口径 / 规模 / 体积 / 旧口径提及数 / 已注册工具 / 迁移报告 |
| `radar_discover` | 关键词检索候选，**只列不登记**；自带三源并发 + 逐源状态 + `inLibrary` |
| `radar_add_batch` | 批量登记，逐条独立、单条失败不影响其余；上限 10 条 |
| `radar_export` | 导出 JSON / CSV 到文件；**只回路径，内容不进上下文** |
| `radar_reextract` | 用当前词典对留存正文重算；`all`/`stale`/`ids`，**默认 dryRun=true** |
| `radar_import` | 导入 JSON（自动识别导出/v0.2）；**默认 dryRun=true**，merge 按三键去重 |
| `radar_remove` | 删一篇；默认 dryRun，真删要审批，10 秒内可撤销 |
| `radar_clear` | 清空（保留词典）；需确认词 + 审批，10 秒内可撤销 |
| `radar_restore` | 撤销删除/清空 |
| `radar_algorithm` | 算法详情：章节/年份分布 + 命中论文与证据片段 |
| `radar_trends` | 按年份看若干算法的论文数；缺年份单独计数 |
| `radar_fields` | 领域分布 + 未分类篇数 |
| `radar_cooccurrence` | 同篇共现的算法对 + lift，可按领域过滤 |
| `radar_dictionary` | 词典管理：list / add / update / remove / moveAlias（改动会推口径版本） |
| `radar_text` | **仅 `textReadEnabled=true` 时注册**；读留存正文，单次 ≤8,000 字符，唯一正文出口 |
| `radar_candidates` | 词典外算法名的候选队列：add / list / approve / reject |
| `radar_samples` | 示例数据：load / clear / promote（默认不计入统计） |

契约件在 `lib/contract.js`：`paginate`（limit/offset/total/truncated）、`boundResult`（单次返回 ≤12,000 字符，超限显式标注）、`compareCodePoints`（取代 `localeCompare`）。

## 装法注意（踩过）

profile 里的插件必须是 **junction / symlink**，不能是副本：

```powershell
Get-Item "$HOME\.dsh\profiles\<profile>\node_modules\dsh-paper-algo-radar" | Select LinkType
# 期望 Junction 或 SymbolicLink；如果是空值，说明是副本，改代码不会生效
```

`Copy-Item -Recurse` 会把 junction **解引用成副本**——复制 DSH_HOME 之后必须重建联接，否则宿主一直跑旧快照，而且日志里毫无异常。

## 排障：面板报「接口 /xxx 没有响应（HTTP 404）」

这是**宿主还在运行旧版插件**的典型症状：插件代码更新了，但应用从上次启动时就把旧模块留在内存里，
新加的 HTTP 路由（如 `/trends`、`/cooccurrence`、`/dictionary`、`/candidates`、`/guide`）根本没注册，
宿主于是回了自己的空 404，前端解析空 body 就会报 JSON 解析错误。

**判断**：
```powershell
Get-Process -Name "DeepSeek Harness" | Select-Object Id,StartTime
# 对比 lib/index.js 的最后修改时间；进程比文件旧 = 跑的是旧代码
```

**处理**：完全退出应用再启动（不是关窗口）。重启后 `/state` 的 `tools` 数量应为 19（或 18，取决于
`textReadEnabled`），且包含 `radar_trends` / `radar_cooccurrence` 等新工具。

## 排障：面板里的正文 / 片段是乱码

症状：论文标题正常，但片段全是 `ä¸_`、私用区方块、`1⁄4` 之类的字符。

根因（v0.2 及更早）：`lib/pdf.js` 把「含 Tj/TJ 的流」一律当内容流，于是

1. 图片 / 字体等**二进制流**偶尔含 `Tj`，解出来是噪声；
2. **CID/Type0 字体（Identity-H）** 的内容流里是字形码，不是文字——本工具不解析 ToUnicode 映射。

两者都会产出「字符很多、没有一个词」的文本，而当时的闸门只检查长度 ≥ 300，于是以乱码入库，
排行与片段全部由它派生。

现在有三道闸：

| 闸 | 位置 | 行为 |
|---|---|---|
| 单流过滤 | `lib/pdf.js` | 每个流先过 `analyzeText`，不像正文的整段丢弃 |
| 全文闸门 | `lib/index.js` | 抽完仍不像自然语言 → `UNSUPPORTED_MEDIA`，提示改用粘贴 / OCR |
| 入库闸门 | `lib/index.js` `ingestPaper` | 任何来源（PDF / 粘贴 / 批量）都先判定，再清洗控制符 |

**已经入库的乱码正文不可恢复**（PDF 原件按设计不留），用维护脚本清理：

```bash
node scripts/repair-corrupt-texts.mjs            # 体检，不写任何东西
node scripts/repair-corrupt-texts.mjs --apply    # 清理：保留论文记录，清正文 + 派生提及
node scripts/repair-corrupt-texts.mjs --apply --mode delete-papers   # 连论文记录一起删
```

`--apply` 前**先退出宿主**（算法库常驻内存，边跑边改会被写回），并会自动备份 `store.json`。

## 已知问题（都在 W0_TASKS.md 里排了）

1. §12.1 的 A1 / A2 / A3 需要 v0.2 的样例正文，目前只有规则级测试，**这三条验收还没算过**。
2. 存储是**惰性打开**的（T-18 已完成）：第一次用到才读盘，加载期零副作用。
3. 现有 16 条提及标的是 `dictVersion:'v0.2-legacy'`，新引擎只影响新登记；口径刷新要等 W1.0 的重算。
4. 迁移结果只在内存里，落盘要等下一次写入（`migrationPending`）——这是刻意的，避免加载期写盘。
5. `radar_search` 仍是「检索 + 登记」一体，T-08 会拆开。
