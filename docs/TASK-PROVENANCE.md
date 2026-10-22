# 开发工单 · W2.2 登记溯源 + 定时采集 + venue 白名单（v2，含 5 条疑问裁定）

> 自足工单。按本文执行即可；细节查 PRD 指定小节。
> **前置**：W2.1（report / insight / BUG-1）已完成，本批不修改它们的既有行为。
> **v2 变更**：开发在第 ③④ 步前提的 5 个问题已裁定（D-1…D-5，见 §0），① ② 已实现部分**只需按 D-2 补一处**，不要重做。

| 项 | 内容 |
|---|---|
| 仓库 | `C:\Users\26580\Documents\1_Mycode\dsh_plugin_design`（`paper-algo-radar/`） |
| 需求 | `docs/REQUIREMENTS_PLUGIN-v1.0.md` §7 FR-14 / 15 / 16、§8 R14、§12.2 E38–E44 |
| 裁定依据 | `docs/FEATURE_PROVENANCE.md` §12（D-1…D-5） |
| 版本 | W2.2 |
| 顺序 | ① 补 D-2 改动 → ② ③ venue 白名单与 discover → ④ insight 分层 |
| 边界 | 只加字段不加表；不加依赖；不动 `writeEnabled` 分组；不调模型；**不新增工具、不新增 HTTP 路由、不写配置** |

---

## 0. 五条裁定（照此执行，不要再问，也不要自行扩展）

| 编号 | 问题 | 裁定 |
|---|---|---|
| **D-1** | 报告里的来源分布、已读未读放哪 | `review` 第 2 章「数据画像」表加 3 行（来源构成 / 已读未读 / 状态未知）；第 3 章表下加 1 句「含未读 N 篇」；`decide` 第 4 章加 1 句；`insight` 第 1 节加 1 行。**不加章节、不改顺序、不改既有列** |
| **D-2** | `status` 四态怎么折两列 | `done`=已读；`toread`+`reading`=未读（在读并入未读，不重复计数）；`null`=未知，单列第三行。**默认值分流**：`search`/`skill`→`toread`，其余入口→`done` |
| **D-3** | `venueAllowlist` 谁写入 | 只从 `Config` 读（`cordis.patch.yml` / 宿主设置页）。**不写快照、不加工具、不加路由、不改设置页**。优先级：入参 > Config > 空（不启用） |
| **D-4** | E43 返回什么 | `items` 只含命中项；未命中进 `excluded[]`（≤20，含 `title/venue/venueNorm/reason`）+ `excludedCount` + `excludedTruncated`。过滤在**合并去重后、截断前**；命中不足 `limit` 就少给，**不追加请求** |
| **D-5** | `insight` 分层边界 | venue 空/归一失败 → 白名单外（`venue-missing`），表下注明未标注 M 篇；空白名单 + `venueScope=allowlist` → `VALIDATION`（不降级）；**时间窗本批不做**，`yearFrom/yearTo/windowDays` 在 `insight` 下 → `VALIDATION`；第 3 节组合不分层 |

---

## 第一步 · FR-14 登记溯源（**①② 已实现，只补 D-2**）

### 已完成，不要重做
- `papers.source` 枚举 + `null`（存量不推断、不回填）
- `radar_add` / `radar_add_batch` 的 `source?` 显式覆盖与入口推断（`zotero` / `skill` 只能显式传）
- `radar_papers(source=…)` 过滤；`radar_status` 来源分布计数

### 唯一改动点（D-2）
`defaultStatusForSource()` 现在对非采集入口返回 `null`，改为：

```js
// search / skill → 'toread'；其余入口 → 'done'；显式传值仍优先
```

改完补 E41 证据。**只改这一处**，`source` 相关逻辑不动。

### 报告落点（D-1，属第三步之后一起做也行，但别忘）
- `review` 第 2 章表加 3 行 —— 列与原表一致（`指标 | 值 | 来源 | 空值`）：

  | 指标 | 值 | 空值 |
  |---|---|---|
  | 来源构成 | `pdf 40 · doi 12 · search 9 · …`（7 类按篇数降序，为 0 省略；`null` 另写「未知 N 篇」） | `—` |
  | 已读 / 未读 | `D / U`（`U = toread + reading`；在读 K 篇在括号注明） | `0 / 0` |
  | 状态未知 | `X 篇`（`status=null`，不计入前两行） | `0` |

- `review` 第 3 章表下（未读 > 0 时）：`> 排行含未读 N 篇（toread + reading），未按阅读状态过滤。`
- `decide` 第 4 章口径附录（固定一句）：`> 来源渠道与阅读状态不参与缺口判定（G1–G7 只看数量与结构）。`
- `insight` 第 1 节领域画像：来源构成一行（同 review 写法）。

## 第二步 · FR-15 采集契约（已实现，补证据即可）

- 定时采集（`source=search|skill`）默认 `status=toread`。
- 幂等：同一批重复运行新增数为 0（三键已实现，**加测试证明**）。
- 文档化链路（写 README 或 PRD 附录，不改逻辑）：
  `宿主定时任务 → 检索 skill/插件 → radar_discover → radar_add_batch(source, fields, status)`
- **不注册定时器、不常驻后台**（FR-10.5）。

## 第三步 · FR-16 venue 白名单（未开工）

### 3.1 配置（D-3）
- 在插件 `Config` schema 加 `venueAllowlist: string[]`，默认 `[]`。
- **不写快照**（`store.json` 不加 `settings`）、**不加写工具**、**不加 HTTP 路由**、设置页如需显示只读即可。
- 读取顺序：`args.venueAllowlist` ?? `config.venueAllowlist` ?? `[]`。空数组 = 不启用过滤。

### 3.2 归一（FR-16.1）
`normalizeVenue()`：剥离年份（`2024` / `(2024)`）、卷期（`Vol. 12` / `No. 3`）、`Proceedings of` / `Proc. of` / `IEEE` / `IEEE/CVF` 前缀，去多余空白与标点，统一大写比较。**归一后精确相等，不做模糊/前缀匹配。**
归一失败（空、纯空白、剥完为空串）→ 返回 `null`，原因码 `venue-missing`。

### 3.3 `radar_discover` 过滤（FR-16.2 / D-4）
- 入参 `venueAllowlist?: string[]`；缺省取配置；两者皆空 → 不过滤。
- 时机：**各源结果合并去重后 → 过滤 → 截断到 `limit`**。命中不足 `limit` 不补请求。
- 出参：
  ```js
  { items: [...命中项], sources: [...],
    excluded: [{ title, venue, venueNorm, reason }],  // ≤20
    excludedCount: 0,            // 被滤总数
    excludedTruncated: false }
  ```
  `reason`：`not-in-allowlist`（归一后不在白名单）/ `venue-missing`（venue 空）。
- 不传且配置为空 → `excluded: []`, `excludedCount: 0`，输出与改动前**逐项一致**。

### 3.4 venue 归一带来的边界
- `NeurIPS` / `NIPS` 历史改名**不做别名合并**（归一不等于建同义词表）；用户要匹配就把两种写法都写进白名单。
- 白名单项本身也要先归一（用户写 `CVPR 2024` 应视为 `CVPR`）。

## 第四步 · FR-16.3 insight 分层（P1，未开工）

- `radar_report(mode=insight)` 加 `venueScope: 'allowlist'|'all'`，默认 `all`。
- `all` → 第 2 节单表，**与 W2.1 完全一致**（回归基线）。
- `allowlist` → 第 2 节拆「白名单内 Top10」+「白名单外 Top10」，各 ≤10 行，第 2 节总长仍 ≤80 行。
- **分母各自算**：表下分别写 `> 分母 = 白名单内 N 篇` / `> 分母 = 白名单外 M 篇`，不得混用。
- venue 空 → 白名单外；若该层有未标注篇，表下加 `> 其中 venue 未标注 M 篇`。
- 固定声明（第 2 节表下）：`> 白名单只表示检索范围，不表示论文质量。`
- 第 3 节组合**不按 venue 分层**，沿用领域全集；第 5 节补一句「组合基于领域全集，未按白名单过滤」。
- 参数校验：
  - `venueScope=allowlist` 但白名单为空 → `VALIDATION`（不降级为 `all`、不出空报告）
  - `insight` 下传 `yearFrom`/`yearTo`/`windowDays` → `VALIDATION`（Q17，时间窗本批不做）
  - 领域 <5 篇仍按 W2.1 降级为只出第 1、5 节

---

## 自测

| 用例 | 期望 |
|---|---|
| E38 | 六种入口各登 1 篇 → `source` 分别为 `doi/arxiv/manual/pdf/zotero/search`；传 `skill` 覆盖成功 |
| E39 | 存量论文 `source=null`，显示「未知」，不报错、不回填 |
| E40 | 同批 `add_batch` 连跑两次 → 第二次新增 0、更新 N |
| E41 | `search/skill` → `toread`；`pdf/manual` 未传 → `done`；显式 `reading` 覆盖成功；`review` 第 2 章「已读/未读/未知」三行与库内分别相等，**三行之和 = 论文总数** |
| E42 | `CVPR 2024` / `IEEE/CVF CVPR` / `Proceedings of CVPR` → `CVPR` 且命中；`venue=null` 不命中，reason=`venue-missing` |
| E43 | `discover(venueAllowlist=[…])` → `items` 只含命中；`excluded` 明细正确、`excludedCount` 等于被滤数（>20 时 `excludedTruncated=true`）；不传参数时输出与改动前逐项一致 |
| E44 | 空白名单：`discover` 不过滤（空 ≠ 全不命中）；`insight(venueScope=allowlist)` → `VALIDATION`；`insight(yearFrom=…)` → `VALIDATION` |
| 回归 | E24–E37 全绿（不得破坏 W2.1 的报告与 insight） |

## 回报格式

```
1. FR-14：D-2 改动位置 + E38/E39/E41 输出
2. FR-15：幂等测试结果（两次 add_batch 的新增数）
3. FR-16：normalizeVenue 归一用例表 + E42/E43/E44 输出
4. insight：venueScope=allowlist 的输出节标题与两表分母 + 空白名单/时间窗的 VALIDATION 实际返回
5. 回归：E24–E37 通过数
6. 未做 / 有疑问：逐条列，不要自行扩展范围
```

## 如果发现需求有洞

先停下来说，不要自己补。**但先对照 §0 的 D-1…D-5**——那 5 条已经定过，不要重复提问。
新问题属于需求侧（如 venue 别名合并、白名单从哪导入），改 PRD，不要实现里打补丁。

## 参考

- 需求：PRD §7 FR-14/15/16、§8 R14、§12.2 E38–E44、§16 Q14/Q17
- 裁定：`docs/FEATURE_PROVENANCE.md` §12
- 报告结构：`docs/REPORT_TEMPLATE_SPEC.md` §1.2 / §1.3 / §2.4 / §2.5ter
