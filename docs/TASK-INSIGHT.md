# 开发工单 · BUG-1 + 领域洞察报告（insight）

> 给实现者：这是一份**自足**的工单。你不需要通读 1100 行 PRD，按本文执行即可；
> 需要细节时再查下面列出的具体小节。

| 项 | 内容 |
|---|---|
| 仓库 | `C:\Users\26580\Documents\1_Mycode\dsh_plugin_design`（`paper-algo-radar/`） |
| 基线 | `docs/REQUIREMENTS_PLUGIN-v1.0.md`（FR-13.14 / 13.15、§8 R13-RI、E33–E37） |
| 顺序 | **第一步修 BUG-1，第二步做 insight**（顺序不能反） |
| 边界 | 只读实现；不改快照结构、不加依赖、不调模型、不动 `writeEnabled` 分组 |

---

## 第一步 · 修 BUG-1（`radar_ranking` 的 `field` 失效）

### 现象
- `radar_ranking(field:"空气质量预测")` 与 `field:"命名识别"` 输出**完全相同**；
- 覆盖率分母恒为全库（74），不是领域篇数；
- 代码位置：`paper-algo-radar/lib/index.js` 的 `buildRankingTool`（约 1133–1206 行），
  `execute` 里**从未读取 `args.field`**。

### 修复要求
1. `field` 过滤生效：按 `paper.fields` 过滤论文，再聚合算法计数（与 `radar_papers` 的 field 过滤同一套语义）。
2. **覆盖率分母 = 该领域论文数**（不是 `state.paperCount`）。
3. `firstYear` / `lastYear` **也要在领域内重算**（否则年份区间会混入别的领域）。
4. `q` / `type` 过滤与 `denominator` 现有语义保持不变。
5. 领域过滤不要影响 `stale` / `onlyCurrentDict` 的既有行为。

### 硬验收（E35）
- 两个不同 `field` 的输出**必须不同**；
- 分母 = 该领域篇数；
- **同一领域、同一算法，`radar_ranking(field)` 的篇数必须与 `radar_matrix` 的 cells 逐项相等**。

> 最后这条是交叉校验，能同时抓住"过滤没生效"和"过滤生效但分母算错"两类错误。

---

## 第二步 · 实现 `mode=insight`

### 前置约束（RI）
- `mode=insight` **必须**给 `field`；缺 `field` → `VALIDATION`；`scope` 固定为领域。
- 领域 **< 5 篇**：只出第 1、5 节，不出排行与组合。

### 五节结构（字段级细节见 `docs/REPORT_TEMPLATE_SPEC.md` §2.5bis）

| 节 | 内容 | 关键口径 |
|---|---|---|
| 1 领域画像 | 篇数、占全库比例（给分母）、时间跨度、摘要级占比、算法种数 | — |
| 2 算法热度 Top10 | # / 算法（类型·分类）/ 论文数 / 提及数 / **领域内覆盖率** / 首见年 | 分母 = 领域篇数；Top1 与全库不同时显式指出差异 |
| 3 算法组合 Top10 | # / 组合 / 同现篇数 / lift / 同现率 | 最小同现 **3 篇**；排序：篇数 desc → lift desc |
| 4 组合证据 | Top3 组合各 3 篇同现论文（按 `hitCount` 降序）+ 每篇每算法 1 条片段 | 片段只读已存 `snippets`；**不渲染正文**；声明「片段不保证相邻」 |
| 5 口径与局限 | 复用 review 第 9 章同源表 + 三条固定项 | 样本量 / 库内偏差 / 共现语义 |

### 两条必须写进报告正文的声明（不是建议，是需求）
- 「**共现只说明两个算法在同一篇论文中出现过，不说明它们如何结合**」——第 3、4 节各一条。
- 「**库内热度只反映已登记论文，不等于领域全局现状**」——第 1、5 节各一条。

### 数据来源
- 热度：`radar_matrix(field=…)` 的 cells + `radar_ranking(field=…)`（依赖第一步修好）。
- 组合：`radar_cooccurrence(field=…, minPapers=3)`。
- 片段：`radar_paper(id)` 返回的 `snippets`（已存，不重抽）。

### 不要做的事
- 不判断"哪个算法更先进"（无质量信号）
- 不推荐具体论文（需外部检索）
- 不把共现写成"组合方式"结论
- 不因为 `decide` 也走 `radar_report` 就顺手改它的规则（那是另一个待办）

---

## 交付与自测

| 步 | 自测 |
|---|---|
| 1 | E35：两个领域输出不同；与 `matrix` 逐项相等 |
| 2 | E33：5 节齐全、分母正确、Top1 差异被指出 |
| 3 | E34：组合表同现 ≥3、排序正确、有「共现≠结合」 |
| 4 | E36：<5 篇领域降级；E37：缺 `field` 报 `VALIDATION` |
| 5 | 回归：E24–E32 全绿（改了 `radar_report`，必须回归） |
| 6 | E26/E28 仍成立（同参数 sha256 相同；生成前后库不变） |

## 回报格式

```
1. BUG-1：改了哪几行、E35 的输出（两个领域的 Top1 与分母）
2. insight：跑了哪个领域、5 节是否齐全、组合 Top3 是什么
3. 测试：新增/修改了哪些测试、通过数
4. 未做 / 有疑问的：逐条列，不要自行扩展范围
```

## 如果发现需求有洞

**先停下来提，不要自己补。** 例如：字段不够、某节规则自相矛盾、`matrix` 与 `ranking` 的聚合方式不一致。
这些属于需求侧问题，改 PRD 而不是在实现里打补丁。

## 参考（按需查阅，不必全读）

- 需求：`docs/REQUIREMENTS_PLUGIN-v1.0.md` §7 FR-13.14/13.15、§8 R13-RI、§12.2 E33–E37
- 字段级：`docs/REPORT_TEMPLATE_SPEC.md` §0 公共约定、§2.5bis insight
- 决策背景：`docs/FEATURE_INSIGHT.md`
