# W2.1 · 研究报告生成（radar_report）

| 项 | 内容 |
|---|---|
| 版本 | 插件 `0.2.0` + W2.1 增量 |
| 日期 | 2026-10-23 |
| 依据 | REQUIREMENTS §7 FR-13 / §8 R13、`REPORT_TEMPLATE_SPEC.md`、`DECISIONS_REPORT.md`（P-10 / P-11） |
| 状态 | **已完成 5 步交付**，3 处口径判断需确认（见 §6） |

---

## 1. 交付物

| 文件 | 变更 |
|---|---|
| `lib/report.js` | **新增**（约 690 行）：纯渲染层，10 章 / 5 章骨架、缺口规则、格式化、400 行预算 |
| `lib/index.js` | 新增 `collectReportData` / `generateReport` / `buildReportTool`；`buildState` 支持 `paperFilter`（scope）与多标签聚合；`POST /report` 路由；`/radar report` 命令注入 |
| `lib/contract.js` | `READ_TOOL_NAMES += radar_report`（**读组**，不受 `writeEnabled` 约束） |
| `lib/command.js` | `/radar report [review|decide] [--days N] [--field 名] [--years A-B]` |
| `lib/client.js` | `ReportPanel`（双入口：工具栏 + 口径页脚）+ 面板样式 |
| `test/report.test.mjs` | **新增** 107 条验收断言 |
| `test/e2e-report.mjs` | **新增** 21 条端到端（真实宿主） |

工具总数 **21**（读 11 + 写 10；`radar_text` 仍只在 `textReadEnabled` 打开时 +1）。

---

## 2. 五步交付与验证

| 步 | 内容 | 验证 |
|---|---|---|
| 1 | 生成 + 落盘（E24 空报告） | `report.test` [1]：空库出 `2/9/10` 三章、数据画像全 0、附录空表 |
| 2 | 两套骨架（review 10 章） | `report.test` [2]：章标题、6 列表头、覆盖率分母、类型三行、两张时间线表、附录 A/B |
| 3 | 缺口规则（decide 5 章） | `report.test` [3][4]：不命中写「未发现缺口」；20 篇 fixture 让 **G1–G5 全部命中**，严重度与三段结构逐项断言 |
| 4 | 参数化 + 只读（E26/E28/E30） | `report.test` [5][7][8] + `e2e-report` [4][5]：两次 sha256 相同、`store.json`/`texts/` 哈希不变、`writeEnabled=false` 仍注册可用 |
| 5 | 润色占位块（E29） | `report.test` [11]：`narrative=1` 每章末插 `<!-- radar:insight section=N -->` + 占位文案，头部标 P-10；`narrative=0` 无 |

额外覆盖：E27（40 字符探针 × 20 条，review/decide 均无泄漏）、E32（附录预算与截断说明）、scope=`field`/`yearRange`、`path` 越界拒绝、同名 `-2` 不覆盖、`/radar report` 五种子命令参数。

**实跑数字**：`test/report.test.mjs` **107 passed**；`test/insight.test.mjs` **42 passed**；`test/ranking-field.test.mjs` **22 passed**；`test/e2e-report.mjs` **31 passed**；全量单元 **1212 条 / 36 套件全绿**。

---

## 3. 关键口径落点（容易错的三个，都有专门断言）

1. **类型分布分母**：`DL + ML + MATH` 三行之和，不是论文数（多标签）。实测 5 篇 → 分母 10。
2. **领域分布分母**：论文数；「未分类」单列最后一行；合计可大于分母。
3. **最近 N 天用 `readAt`**：重算只动 `updatedAt`，不影响「新增」语义；报告里写明这一点。
4. **覆盖率分母跟随 scope**：`scope=field` 时分母是该领域篇数（实测 5 篇 → `分母 = 5 篇（scope 内）`）。

---

## 4. 只读与上下文边界

| 约束 | 落点 |
|---|---|
| 不改库 / `texts/` / 配置 | 只 `writeFile` 到 `exports/reports/`；E28 逐文件哈希验证 |
| 内容不进上下文 | 工具与接口只返回 `{path, bytes, sections, mode, scope, generatedAt, narrative}`；断言 `content`/`text` 字段不存在 |
| 不调模型 | 无网络、无模型句柄；`narrative=1` 只插占位块（P-10） |
| 不重新抽取 | 不读正文；片段只输出定位符（编号 + 字符数） |
| 触发备份 | 不触发（报告路径不经过 `/state`） |

---

## 5. 空态与降级（§5 / FR-13.7）

| 条件 | review | decide |
|---|---|---|
| 0 篇 | 头 + 数据画像 + 可信度 + 附录（空表），首行声明数据不足 | 口径附录 + 未评估项 |
| 1–4 篇 | 同上（声明 `< 5 篇`） | 全部五章（G1/G2 仍可命中） |
| ≥5 篇 | 全部十章 | 全部五章 |

> 降级阈值用 **scope 内篇数**（不是全库篇数）：`scope=field` 只有 3 篇时不出结论章。

---

## 6. 需要确认的 3 处（我做了判断，但可能不是你想要的）

### ① R13.5「证据片段」与 E27「40 字符探针」冲突 → 我选择只给定位符

- R13.5：片段 ≤3 条/算法、每条 ≤200 字符、只读已存 `snippets`
- E27：报告里不能出现 40 字符的正文片段
- 两者不可同时成立：200 字符的片段必然包含 40 字符子串
- **我的实现**：排行表下只写 `LSTM 片段 #1（164 字符）、片段 #2（160 字符）`——保留回指（FR-13.6 的「片段编号」），不含片段正文。E27 因此稳过。
- **若要片段正文**：E27 需改成「不含整段正文（片段区除外）」，我可以把片段以引用块加回来。

### ② G4 的触发条件多了「库 ≥ 5 篇」

- D1 §3 只写「最新年 < referenceYear − 2」
- FEATURE_REPORT §5 写「库 ≥ 5 篇且最新论文年 < referenceYear − 2」
- **我按 FEATURE_REPORT 实现**（更保守，避免 2 篇的库就断言"时间断层"）。若要严格照 D1，删掉一个条件即可。

### ③ 严重度映射的来源

- D1 §2.1 写「严重度：高/中/低（见 §3 规则）」，但 §3 表格**没有严重度列**
- 实际映射取自 FEATURE_REPORT §5：G1 高 / G2 中 / G3 中 / G4 中 / G5 低
- 已按此实现并写进断言；若口径不同，只需改 `lib/report.js` 的 `GAP_DEFS`

### 另外两处我主动修的小偏差（不改也行，说明一下）

- **领域分布文案**：D1 要求「故合计大于论文数」，但单标签库下合计**等于**论文数，照抄会自相矛盾。改为「合计**可能**大于论文数（分母=N）」。
- **附录双上限冲突**：D1 §0.4 同时要求「全文 ≤400 行」与「附录排行 ≤200 行」，两张 200 行的表必然破 400。实现为：附录 A/B 共享动态预算（`400 − 已用`），截断时写「（已截断：显示前 N / 共 M）」；单章 ≤80 行对附录豁免（附录有自己的行数上限）。

---

## 7. 复现

```powershell
# 单元（不需要宿主）
node test/report.test.mjs

# 端到端（需要隔离实例；token 在 web*.out.log 里）
node test/e2e-report.mjs http://127.0.0.1:52699 "<token>"
```

```powershell
# 面板：工具栏「生成报告」或页脚「生成报告」→ 同一面板
# 命令：/radar report decide --days 7
# 工具：radar_report({ mode: 'decide', scope: 'field', field: '空气质量', generatedAt: '2026-10-23T00:00:00+08:00' })
```


---

## 8. 追加 · BUG-1：`radar_ranking` 的 `field` 失效（已修）

### 根因
`buildRankingTool.execute` **从未读取 `args.field`**，`RANKING_PARAMETERS` 里连该参数都没声明。所以两个不同领域输出相同、覆盖率分母恒为全库。

### 改动（`lib/index.js`）

| 行 | 改动 |
|---|---|
| 561 | 新增 `fieldsOfPaper()`：领域标签归一（去空白、去「未分类」、全空记「未分类」），**matrix 与 ranking 共用** |
| 1103 | `RANKING_PARAMETERS` 补 `field` |
| 1171 | `execute` 读取 `field`，聚合前注入 `paperFilter` |
| 1200 | `paperCount` / `mentionCount` 另取全库基线（库规模语义不随 scope 收窄） |
| 1232 | `countPapersMatching()` 支持领域限定（`field + type/q` 分母不漏） |
| — | `radar_papers` 的 field 过滤也改用 `fieldsOfPaper()`，三处语义统一 |

`firstYear` / `lastYear` 由 `buildState` 在过滤后的提及上重算，天然落在领域内。

### 验收（E35，`test/ranking-field.test.mjs` 22 条）

7 篇库、两个领域各 4 篇（含 1 篇跨领域）：

```
领域A: 分母=4（全库 7）Top1=CNN 2篇/2次 覆盖50%
领域B: 分母=4（全库 7）Top1=SVM 4篇/4次 覆盖100%
```

- 两领域输出不同 ✓；分母 = 领域篇数 ✓
- 与 `radar_matrix` 的 cells **逐项相等**（A/B 两个领域都校验）✓
- LSTM 在领域A 的首见 2020、最近 2021（没有混入领域B 的 2016）✓

---

## 9. 追加 · `mode=insight`（领域洞察）

### 参数
`mode=insight` **必须给 `field`**（缺 → `VALIDATION`），`scope` 固定为领域（RI-1）。文件名 `radar-report-insight-field-<slug>-<stamp>.md`。

### 五节（≥5 篇时）
| 节 | 内容 | 口径 |
|---|---|---|
| 1 领域画像 | 篇数 / 占全库比例（给分母）/ 时间跨度 / 摘要级 / 算法种数 | 含「库内热度 ≠ 全局现状」声明 |
| 2 算法热度 Top10 | 领域内覆盖率分母 = 领域篇数 | 同时写全库分母；Top1 与全库不同时显式指出 |
| 3 算法组合 Top10 | 同现篇数 / lift / 同现率；最小同现 3 篇 | 排序：篇数 desc → lift desc；含两条声明 |
| 4 组合证据 | Top3 组合各 3 篇同现论文（`hitCount` desc）+ 每篇每算法 1 条片段 | 片段 ≤200 字符、只读已存 `snippets`；「不保证相邻」 |
| 5 口径与局限 | review 第 9 章同源表 + 本领域样本量 / 库内偏差 / 共现语义 | 单张表，不重复表头 |

**< 5 篇降级（E36）**：只出第 1、5 节，不排行、不组合、不报错。

### 两处口径由需求方裁定（本实现的依据）
1. **同现率**：文档只给列名未给分母 → 取 **同现篇数 ÷ min(两算法各自篇数)**。
   理由：FEATURE_INSIGHT 的解读句「同现率高但篇数少 → 可能是惯例搭配」只有在按两者自身篇数归一化时才成立。
   报告里也写明了这个定义：`> 同现率 = 同现篇数 ÷ min(两算法各自篇数)`。
2. **E27 与 FR-13.15 的冲突**：§4 要求渲染 ≤200 字符片段，E27 用 40 字符探针断言「报告里没有正文片段」。
   处理：**E27 只覆盖 review/decide**；insight 按 FR-13.15 渲染片段。E27 用例未改，仍在 review/decide 上全绿。

### 入口
- 工具：`radar_report({ mode:'insight', field:'空气质量预测' })`
- 面板：报告面板新增「洞察（5 节）」按钮 + 领域输入
- 命令：`/radar report insight --field 空气质量预测`

### 验收（`test/insight.test.mjs` 42 条）
E33（五节 / 分母 / Top1 差异）、E34（同现 ≥3 / 排序 / 「共现 ≠ 结合」/ 同现率公式）、E36（降级）、E37（缺 field）、RI-5（18 条片段 = 3×3×2、≤200 字符）、RI-7（与 matrix 逐项相等）、RI-9（两条固定声明）、E26（两次 sha256 一致）、E28（store/texts 不变）、工具与命令入口。

### 端到端
`test/e2e-report.mjs` 增加 insight 段（31 条）：HTTP `POST /report {mode:'insight'}`、缺 field 400、五节、两条声明、同现 ≥3、两次 sha256 一致。
