# 需求增量包 · 来源追踪 + 定时采集 + 顶会白名单

| 项 | 内容 |
|---|---|
| 文档 | FEATURE_PROVENANCE（增量需求） |
| 版本 | v1.0-draft |
| 日期 | 2026-10-23 |
| 基线 | [REQUIREMENTS_PLUGIN-v1.0.md](C:/Users/26580/Documents/1_Mycode/dsh_plugin_design/docs/REQUIREMENTS_PLUGIN-v1.0.md) |
| 已确认决策 | 来源只记**渠道大类**；调度由**宿主定时任务**驱动；顶会判定用**用户维护的 venue 白名单** |
| 状态 | **已回灌 PRD（2026-10-23）**：FR-14 / 15 / 16、§8 R14、E38–E44、W2.2 版本行已并入主文档。**2026-10-23 追加**：开发第 ③④ 步前的 5 条疑问已裁定（§12 D-1…D-5）并二次回灌 |
| 目标链路 | 定时任务 → 检索 skill/插件 → `radar_add_batch` → 来源可查 → 顶会热点可看 |

---

## 1. 问题

| 现状 | 后果 |
|---|---|
| 论文没有来源字段 | 分不清哪篇是 Zotero 同步、哪篇是检索插件拉来的、哪篇手录 |
| 定时采集无法追踪 | 跑完不知道"这轮新增了什么、来自哪个渠道" |
| `discover` 只认识 venue 名字、不认识等级 | 无法只看顶会/顶刊 |
| 自动采集会产生大量"仅摘要 + 未读"论文 | **排行会被未读论文污染**（PRD 开放问题 1） |

## 2. 三条硬约束（先读）

1. **插件不自己定时**（FR-10.5 / §13.1）：定时由宿主任务唤起会话，插件只提供幂等登记与查询。
2. **来源分类是"渠道"，不是"质量"**：`search` 表示"经检索进来"，不代表它好或差。
3. **自动采集默认不污染统计**：定时入来的论文默认 `status=toread`，报告必须分列"已读 / 未读"，排行是否计入由开关决定（默认**计入**，保持现行为；报告显式标注）。

## 3. 来源模型

### 3.1 字段

`papers.source`：枚举 + 可空

| 值 | 含义 | 谁写入 |
|---|---|---|
| `manual` | 粘贴正文 / 手录 | 默认（`text` 入口） |
| `doi` | DOI 快速添加 | 默认（`input` 是 DOI） |
| `arxiv` | arXiv id / 链接 | 默认（`input` 是 arXiv） |
| `pdf` | 本地 PDF | 默认（`pdfPath`） |
| `zotero` | 从 Zotero 库取来再登记 | **调用方显式传** |
| `search` | 经 `radar_discover` 候选批量登记 | 默认（`add_batch`） |
| `skill` | 经其他 skill / 外部工具检索后登记 | **调用方显式传** |
| `null` | 早于本功能的历史数据 | 存量迁移 |

### 3.2 判定规则（默认推断 + 显式覆盖）

1. 调用方传了 `source` → **以传入为准**（否则 `zotero` 与 `skill` 永远无法区分）。
2. 未传 → 按入口推断：`input` 形态（DOI/arXiv）/ `text` / `pdfPath`。
3. `add_batch` 未传 → `search`。
4. 存量 74 篇 → `null`，界面显示「未知（早于来源追踪）」，**不猜**。

## 4. 定时采集契约（不新增插件定时器）

```
宿主定时任务（cron）
  └─ 唤起会话 → 运行检索 skill/插件
       └─ radar_discover(query, venueAllowlist, yearFrom…)
            └─ 筛选（规则或人工）
                 └─ radar_add_batch(items, source='skill'|'search', fields=[…])
```

插件侧只保证三件事：

| 保证 | 做法 |
|---|---|
| 幂等 | 三键去重：重复跑不新增（已实现） |
| 可查 | `radar_papers(source=…)` + `readAt` 时间窗 |
| 不自动重算 | 重算照旧需人工（diff 预览） |

**建议的定时任务参数**（写进文档，不强制）：只拉近 N 天 + 白名单 venue，避免无上限膨胀。

## 5. venue 白名单

### 5.1 配置项（D-3 修正）

`venueAllowlist: string[]`，**只存在于插件 `Config`**（`cordis.patch.yml` 的 `config` / 宿主设置页），**不进快照**；插件不提供写入口，也不新增 HTTP 路由。

生效优先级：**工具入参 `venueAllowlist` > `Config.venueAllowlist` > 空（不启用过滤）**。

### 5.2 规范化（必须，否则匹配不上）

`normalizeVenue()` 规则：

| 输入 | 归一 |
|---|---|
| `CVPR 2024` / `IEEE/CVF CVPR` / `Proceedings of CVPR` | `CVPR` |
| 全大写/全小写混写 | 统一大写比较 |
| 带年份、卷期、`Proceedings of`、`IEEE` 前缀 | 剥离 |

匹配为**归一后精确相等**；不做模糊匹配（宁可漏，不可错）。

### 5.3 用途

1. `radar_discover` 支持 `venueAllowlist` 过滤（不传则不过滤）；
2. 报告与 `insight` 可按「白名单内 / 白名单外 / 未匹配」分层；
3. **白名单只表示"顶会范围"，不表示论文质量**——报告正文必须写这一句。

## 6. insight 扩展（热点检索的落点）

`insight` 增加一个可选维度：

| 参数 | 作用 |
|---|---|
| `venueScope: 'allowlist' \| 'all'` | 白名单内 / 白名单外各一张 Top10；默认 `all`（W2.1 行为） |

> **时间窗本批不做（D-5）**：`insight` 传 `yearFrom / yearTo / windowDays` 一律 `VALIDATION`。原设想"近 90 天热点"会同时改第 2、3 节分母与 <5 篇降级门槛，且无验收用例，见 PRD §16 Q17。

第 2 节（算法热度）按 venue 分层展示：白名单内 / 白名单外各一张 Top10（行数各 ≤10，总长仍 ≤80 行）。

## 7. FR 增量

| 编号 | 需求 | 优先级 | 版本 | 来源 |
|---|---|---|---|---|
| FR-14.1 | `papers.source` 字段（7 类 + null）；存量写 null，界面显示「未知（早于来源追踪）」 | **P0** | W2.2 | 新增 |
| FR-14.2 | `radar_add` / `radar_add_batch` 支持 `source?` 显式覆盖；未传时按入口推断（§3.2） | **P0** | W2.2 | 新增 |
| FR-14.3 | `radar_papers` 支持 `source` 过滤；`radar_status`/报告增加来源分布（报告落点见 D-1） | P1 | W2.2 | 新增 |
| FR-14.4 | **`status` 默认按来源分流**（采集→`toread`，其余→`done`）；报告分列「已读 / 未读 / 未知」，排行默认仍计入（标注口径，D-2） | **P0** | W2.2 | 新增 |
| FR-15.1 | 采集幂等保证：同一批重复运行新增数为 0；文档化「宿主定时任务 → discover → add_batch」契约 | **P0** | W2.2 | 新增 |
| FR-16.1 | `venueAllowlist` 配置项（只读，不进快照）+ `normalizeVenue()` 归一（§5.1 / §5.2，D-3） | **P0** | W2.2 | 新增 |
| FR-16.2 | `radar_discover` 支持 `venueAllowlist` 过滤；未命中进 `excluded[]` 并计数，不静默丢弃（D-4） | **P0** | W2.2 | 新增 |
| FR-16.3 | `insight` 支持 `venueScope`，热度按白名单分层；**不含时间窗**（D-5 / Q17） | P1 | W2.2 | 新增 |

**优先级会计**：新增 6 条 P0，P0 将从 46/101 → **52/109 ≈ 48%**，红线问题进一步恶化。**§16-Q11 的归约束动作必须与本批一起做**，否则这条线彻底失效。

## 8. 用户故事增量

#### US-40 看清每篇从哪来（W2.2 / P0）
**作为**研究者，**我想**知道某篇论文是通过 Zotero、检索插件还是手录进来的，**以便**判断这批数据该怎么用。

- Given 一篇经 Zotero 登记的论文，Then `source=zotero`
- Given 存量 74 篇，Then 显示「未知（早于来源追踪）」，**不显示猜测值**
- Given 按 `source=zotero` 过滤，Then 只返回 Zotero 来源的论文

#### US-41 定时采集不污染排行（W2.2 / P0）
**作为**研究者，**我想**让定时任务自动登记的论文默认标记为"待读"，**以便**自动拉进来的东西不冒充我读过的。

- Given 定时任务批量登记（`source=search|skill`），Then 每篇 `status=toread`
- Given 手录 / 上传 PDF 未传 status，Then `status=done`（人工登记即视为已处理，D-2）
- Given 报告，Then 分列「已读 / 未读 / 未知」三行，三行之和 = 论文总数
- Given 同一批重复运行，Then 新增数为 0（幂等）

#### US-42 只看顶会（W2.2 / P0）
**作为**研究者，**我想**只检索白名单里的会议期刊，**以便**追热点时不被水会淹没。

- Given 白名单 `[CVPR, NeurIPS, ICML]`，When `discover(venueAllowlist=…)`，Then 只返回归一后匹配的候选
- Given `CVPR 2024` 与 `IEEE/CVF CVPR`，Then 都归一到 `CVPR` 并能命中
- Given 未匹配的候选，Then 标注「不在白名单」，不静默丢弃

#### US-43 看白名单内的热点（W2.2 / P1）
**作为**研究者，**我想**把领域热度拆成"顶会里的"和"其余文献里的"两半，**以便**知道主流会议在推什么、和整体是否一致。

- Given `insight(field=…, venueScope=allowlist)`，Then 第 2 节出「白名单内 / 白名单外」两张 Top10，各自分母为本层篇数
- Given 报告正文，Then 有一句「白名单只表示检索范围，不表示论文质量」
- Given 白名单为空却传 `venueScope=allowlist`，Then `VALIDATION`，不出空报告
- Given 传 `yearFrom/windowDays`，Then `VALIDATION`（时间窗本批不做，Q17）

## 9. 验收增量

| 编号 | 用例 | 预期 |
|---|---|---|
| E38 | 分别用 DOI / arXiv / 正文 / PDF / Zotero / 检索登记各 1 篇 | `source` 分别为 `doi/arxiv/manual/pdf/zotero/search`；显式传 `skill` 时覆盖成功 |
| E39 | 存量库 | 74 篇 `source=null`，界面显示「未知」，不报错、不猜测 |
| E40 | 同一批 `add_batch` 连续跑两次 | 第二次新增 0、更新 N（幂等） |
| E41 | 状态默认与分列 | `search/skill` → `toread`；`pdf/manual` 未传 → `done`；显式 `reading` 覆盖成功；报告三行（已读/未读/未知）与库内分别相等且合计 = 总数 |
| E42 | 白名单归一 | `CVPR 2024`、`IEEE/CVF CVPR`、`Proceedings of CVPR` 归一为 `CVPR` 且命中；`venue=null` 不命中，原因 `venue-missing` |
| E43 | `discover(venueAllowlist=[…])` | `items` 只含命中项；未命中进 `excluded[]` + `excludedCount`（`excluded ≤20`，超出 `excludedTruncated=true`）；不传参数 `excluded=[]` 且结果与改动前逐项一致 |
| E44 | 空配置与非法参数 | 空 `venueAllowlist` → `discover` 不过滤（空 ≠ 全不命中）；`insight(venueScope=allowlist)` 空白名单 → `VALIDATION`；`insight(yearFrom=…)` → `VALIDATION` |

## 10. 风险与开放问题

| 风险 | 对策 |
|---|---|
| 定时采集把库灌成"摘要级海洋" | 默认 `status=toread` + 报告分列 + G1 缺口会立刻报警 |
| venue 名不规范导致漏配 | 归一表 + 「不在白名单」显式标注（不静默） |
| 白名单被当成质量评分 | 报告固定声明「范围 ≠ 质量」 |
| 定时任务跑飞（重复/超量） | 幂等 + 建议只拉近 N 天 + 单次上限 |
| 自动采集的合规/版权 | 只存元数据与统计；正文仍受 P-6 约束 |

**开放问题**

| # | 问题 | 建议 |
|---|---|---|
| V1 | 排行是否默认排除 `toread`？ | 默认**计入**（保持现行为），但报告必须标注「含未读 N 篇」；后续可加开关 |
| V2 | 白名单是否支持通配（`CVPR*`）？ | 暂不支持，只有归一后精确匹配；需要时再加 |
| V3 | 定时任务的前置条件：正文抓不到时是否仍登记？ | 仍登记（摘要级），由 G1 缺口提示补全文 |

## 11. 回灌清单

1. §9.2 `papers` 增加 `source`；`status` 说明补「定时采集默认 `toread`」
2. §7 新增 FR-14 / FR-15 / FR-16 三组（8 条）
3. §10.1 `radar_add` / `radar_add_batch` 入参加 `source?`；`radar_papers` 加 `source?`；`radar_discover` 加 `venueAllowlist?`
4. §10.1 新增设置项与 `insight` 的 `venueScope`
5. §8 新增 R14「来源与采集口径」（推断规则、幂等、只看渠道不看质量）
6. §12.2 加 E38–E43
7. §14 新增 **W2.2** 行（本批 + FR-13.13）
8. §16 加 V1–V3
9. §7.0 合计与 P0 比例更新（52/109）

> 本文件未改动 PRD、未改动代码。

---

## 12. 开发疑问裁定（2026-10-23，5 条）

> 开发在第 ③④ 步前停下提问，属正确行为。以下为需求侧裁定，已回灌 PRD / 报告规范，**实现侧不得自行补**。

### D-1 · 报告里的「来源分布」「已读未读」放哪

**「不改 W2.1 报告结构」= 不改章节数、章节顺序、既有列**，不是"不许加内容"。落点固定：

| 报告 | 加什么 | 加在哪 |
|---|---|---|
| `review` | 来源构成 / 已读未读 / 状态未知 三行 | 第 2 章「数据画像」表（已有 9 行 → 12 行） |
| `review` | `> 排行含未读 N 篇…` | 第 3 章表下（未读 > 0 时） |
| `decide` | `> 来源渠道与阅读状态不参与缺口判定…` | 第 4 章口径附录（一句话） |
| `insight` | 来源构成一行 | 第 1 节领域画像 |

**否决**：新开第 11 章、把来源塞进附录、`decide` 加整表（决定型报告不看数据构成，加了是噪音）。

### D-2 · `status` 四态怎么折成「已读 / 未读」

| 存储值 | 报告列 | 说明 |
|---|---|---|
| `done` | **已读** | — |
| `toread` | **未读** | 排队中 |
| `reading` | **未读** | 在读算未读，**并入不单列**（否则"读了一半"既不算读也不算没读，数字对不上） |
| `null` | **未知** | 存量，单列第三行，不进前两行、不回填 |

**顺带定死默认值**：`search`/`skill` → `toread`；其余入口 → `done`。
理由：只给自动采集设默认，会让手录论文永远是 `null`，半年后库里一半「未知」，这条统计就废了。人工登记意味着你至少看过标题摘要——记 `done` 比记 `未知` 诚实。

> 这一条是对已实现代码的小改动：`defaultStatusForSource` 从 `null` 改为 `done`。只影响未传 `status` 的手动入口。

### D-3 · `venueAllowlist` 谁写入

**只从 `Config` 读，不给写入口。** 不新增 `radar_set_allowlist` 之类的工具，不新增 HTTP 路由，不改设置页，**不写快照**。

- 配置来源：`cordis.patch.yml` 的 `config`（宿主管理），默认 `[]`。
- 定时采集要换白名单：在 `radar_discover(venueAllowlist=[…])` 传参，**入参优先级高于配置**。
- 空数组 = 不启用过滤（≠ 全部不命中）。

**顺带修正一处文档错误**：PRD §9.8 原写「快照内 `settings` 与 Config 一一对应」，与实现不符（`store.json` 无 `settings` 字段）。已改为"配置不进快照"。若照原文实现，就得凭空造一个配置写入面——那才是真正的越界。

### D-4 · E43 到底返回什么

选 **(b) 只返回命中 + `excluded` 明细**，不选全量返回、也不选纯计数。

| 方案 | 判定 |
|---|---|
| (a) 全量返回 + 逐条标注 | ✗ `limit` 会被未命中项占满，`discover` 直接不可用 |
| (b) 命中进 `items`，未命中进 `excluded` | ✓ 可用且可排查"为什么这篇没进来" |
| (c) 只返回命中 + 一个计数 | ✗ 数字对不上时无从查起，等于把问题丢回给人 |

契约：`excluded[{title, venue, venueNorm, reason}]`（≤20 条）+ `excludedCount`（总条数）+ `excludedTruncated`。
**过滤时机**：合并去重后、截断到 `limit` 前。命中不足 `limit` 就少给，**不追加请求**（否则一次 discover 变成不确定次网络调用）。
不传 `venueAllowlist` → `excluded=[]`，输出与改动前逐项一致。

### D-5 · `insight` 分层边界

| 边界 | 裁定 |
|---|---|
| `venue` 为空 / 归一失败 | 归**白名单外**，原因 `venue-missing`；表下注「其中 venue 未标注 M 篇」。**不设第三层**——三层没人能据此做决定 |
| 白名单为空 + `venueScope=allowlist` | **`VALIDATION`**，不降级为 `all`。这是配置错误，不是数据条件；给出空报告或悄悄当 `all`，都会让人以为"顶会里没东西" |
| FR-16.3 的「时间窗」 | **本批删掉**。`insight` 传 `yearFrom/yearTo/windowDays` → `VALIDATION`。`windowDays` 属于"最近新增"语义，`insight` 没这一节；`yearFrom/yearTo` 会改第 2、3 节分母和 <5 篇降级门槛，且无验收用例 → 记为 Q17 |
| 第 3 节组合 | **不按 venue 分层**（同现样本会被切碎），沿用领域全集，第 5 节声明 |

---

## 13. 本次裁定的回灌清单（已完成）

| # | 位置 | 改动 |
|---|---|---|
| 1 | §7 FR-14.3 / 14.4 | 报告落点、`status` 四态映射与默认值分流 |
| 2 | §7 FR-16.1 / 16.2 / 16.3 | 配置只读 + 优先级、`excluded` 契约、空 venue 归属、去时间窗 |
| 3 | §8 R14 | 规则 4 改写；新增 9（归一失败≠命中）/ 10（配置只读）/ 11（可审计） |
| 4 | §9.8 | `settings` → 配置不进快照（修错） |
| 5 | §10.1 | `radar_discover` 出参加 `excluded*`；`radar_add`/`add_batch` 补 `status` 默认与出参；`radar_report` 标 `insight` 拒时间窗 |
| 6 | §12.2 | E41 / E43 重写，新增 E44 |
| 7 | §16 | Q14 收口，新增 Q17 |
| 8 | REPORT_TEMPLATE_SPEC | §1.2 三行、§1.3 一句、§2.4 一句、新增 §2.5ter |
