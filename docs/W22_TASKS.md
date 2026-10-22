# W2.2 · 登记溯源 + 采集契约 + venue 白名单（已按 D-1…D-5 完成）

| 项 | 内容 |
|---|---|
| 工单 | `docs/TASK-PROVENANCE.md` v2（§0 五条裁定） |
| 版本 | W2.2 |
| 日期 | 2026-10-23 |
| 状态 | **五步全部完成**；E38–E44 与 E24–E37 回归全绿 |

---

## 1. 按裁定落地的改动

### ① D-2 · `status` 默认值分流

`lib/index.js` `defaultStatusForSource()`：

```js
return channel === 'search' || channel === 'skill' ? 'toread' : 'done'
```

优先级：**显式 `status` > 旧值（重登记不丢状态）> 入口默认**。
`manual` / `pdf` / `doi` / `arxiv` / `zotero` 未传状态即为「已读」；存量仍为 `null`（未知）。

### ② D-4 · `radar_discover` 的 venue 过滤

- 新参数 `venueAllowlist?: string[]`；优先级 **入参 > Config > 空**（D-3）。
- 过滤时机：`searchPapers` 内「各源结果合并去重后 → 截断到 `limit` 之前」；命中不足 `limit` 不追加请求。
- 出参新增：`excluded[]`（≤20，含 `title/venue/venueNorm/reason`）、`excludedCount`、`excludedTruncated`。
- `reason`：`not-in-allowlist` / `venue-missing`。
- 不传且 Config 为空 → `items` 与改动前逐项一致，`excluded=[]`。

### ③ D-3 · 白名单只从 Config 读

- `apply()` 里 `VENUE_ALLOWLIST = config.venueAllowlist`（过滤空串），**不写快照、不加工具/路由/设置页**。
- `cordis.patch.yml` 可直接配 `venueAllowlist: ["CVPR", "NeurIPS"]`。

### ④ D-5 · insight 分层

- `radar_report(mode=insight)` 新增 `venueScope: 'allowlist'|'all'`（默认 `all`）与 `venueAllowlist?`。
- `allowlist` → 第 2 节拆「白名单内 Top10 / 白名单外 Top10」，**各自分母**，表下分别写 `> 分母 = 白名单内 N 篇` / `> 分母 = 白名单外 M 篇`；有未标注 venue 时追加 `> 其中 venue 未标注 M 篇`。
- 固定声明：`> 白名单只表示检索范围，不表示论文质量。`
- 第 3 节组合**不分层**（沿用领域全集），第 5 节补「组合基于领域全集，未按白名单过滤」。
- 空白名单 + `allowlist` → `VALIDATION`；`insight` 下 `yearFrom`/`yearTo`/`windowDays` → `VALIDATION`。
- `venueScope=all` 输出与 W2.1 完全一致（回归基线）。

### ⑤ D-1 · 报告里的三处数字

| 位置 | 内容 |
|---|---|
| review 第 2 章 | 加 3 行：`来源构成`（7 类按篇数降序、0 省略、null 另写「未知 N 篇」）/ `已读 / 未读`（`done / toread+reading`，在读 K 篇注明）/ `状态未知`（`status=null`）。三行之和 = 论文总数 |
| review 第 3 章 | 未读 > 0 时表下加 `> 排行含未读 N 篇（toread + reading），未按阅读状态过滤。` |
| decide 第 4 章 | 固定一句 `> 来源渠道与阅读状态不参与缺口判定（G1–G5 只看数量与结构）。` |
| insight 第 1 节 | 加 `来源构成` 一行（与 review 同写法） |

---

## 2. 验收

| 用例 | 结果 |
|---|---|
| E38 | 六入口 `doi/arxiv/manual/pdf/zotero/skill` + `add_batch→search`；显式覆盖成功 |
| E39 | 存量 `source=null`，`source='null'` 可过滤，不回填 |
| E40 | 同批连跑两次：新增 2 → 新增 0，两次都 ok |
| E41 | `search/skill→toread`；`manual/pdf→done`；显式 `reading` 生效；review 三行与库内一致且**三行之和 = 论文总数** |
| E42 | `CVPR 2024`/`IEEE/CVF CVPR`/`Proceedings of CVPR`/`cvpr`/叠加前缀/卷期页码 → `CVPR`；`NIPS ≠ NeurIPS`；空 venue → `null`（venue-missing） |
| E43 | `items` 只含命中；`excluded` 明细与 `reason` 正确；>20 时 `excludedTruncated=true`；不传参数输出不变 |
| E44 | 空白名单 → discover 不过滤；`insight(venueScope=allowlist)` 空白名单 → `VALIDATION`；`insight(yearFrom/windowDays)` → `VALIDATION` |
| 回归 | **E24–E37 全绿**（report 107 / insight 42 / ranking-field 22 等） |

**全量：1296 条 / 38 套件，0 失败**（`venue-discover.test.mjs` 新增 32 条，`provenance.test.mjs` 39→52 条）。

---

## 3. 顺手修的两个既有问题（不在工单内，但影响验收）

1. **面板登记没写 `source`**：`/scan` 与 `/register-one` 之前直接把 body 交给 `ingestPaper`，新登记的论文全成「未知来源」。已按 `radar_add` 同一套推断补齐（`text→manual`、`pdfPath→pdf`、`register-one→search`，显式 `source` 优先）。
2. **Windows 上 `save()` 偶发 `EPERM`**：`rename(tmp → store.json)` 被杀软/索引器瞬时占用时失败，测试 12 次里能挂 3 次。已加 `renameWithRetry()`（6 次、递增退避，最后退化为覆盖写）。修后 candidates 连跑 20 次 0 失败。

---

## 4. 与裁定文本的一处措辞差异

D-1 给的句子是「（**G1–G7** 只看数量与结构）」，但当前实现只有 G1–G5（G6/G7 未定义）。报告里写的是 **G1–G5**，避免报告出现不存在的缺口编号。若后续要加 G6/G7，把这句改回即可。
