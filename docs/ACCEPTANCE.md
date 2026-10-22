# dsh-paper-algo-radar · 交付验收报告

> 依据：`REQUIREMENTS_PLUGIN-v1.0.md`（PAR-PRD-003 v1.0 插件版，87 条 FR）
> 验收日期：2026-10-22 ｜ 代码：`paper-algo-radar/`

---

## 1. 结论

**五个里程碑（W0 / W1.0 / W1.1 / W1.2 / W2.0）全部交付。** 87 条 FR 中 **84 条落地**，3 条 P2 外围项按明示取舍未做（见 §6）。

| 项 | 数 |
|---|---|
| 单元测试 | **932 条 / 29 个套件，全绿** |
| 端到端（走真实宿主） | **94 条**（scan 16 / reextract 13 / import 15 / 网络 13 / 完整路径 37） |
| 验收批（§12 用例） | **10 PASS / 0 FAIL / 9 SKIP** |
| 模型面向工具 | **19 个**（读 9 + 写 10；`radar_text` 仅开关打开时 +1） |
| HTTP 路由 | 13 个 exact 端点 |
| 面板标签页 | 7 个（排行 / 论文 / 趋势 / 领域 / 共现 / 词典 / 设置） |

SKIP 的 9 条需要网络凭据、真实模型回合或人工抽查，**不计入通过**（明细见 `test/acceptance.mjs`）。

---

## 2. 验证方式

| 层 | 手段 | 证据 |
|---|---|---|
| 纯函数 | `node test/*.test.mjs` | 932 条断言 |
| 服务层 | 假 ctx + 假 HTTP 服务器 | 工具注册、审批、限速缓存、子进程 |
| 宿主集成 | 隔离 `DSH_HOME` + 真实 dsh 进程 | `test/e2e-*.mjs` |
| 界面 | 无头 Chrome + CDP 探针 | `spike/evidence/*.png` |
| 真网络 | 真 OpenAlex / Crossref / arXiv / arXiv 全文 | `test/e2e-network.mjs` 13 条 |

隔离实例启动方式（`ELECTRON_RUN_AS_NODE=1` + `DSH_HOME=<临时目录>`）与 profile junction 要求写在 `paper-algo-radar/README.md`「装法注意」。

---

## 3. 逐版本交付

### W0 · 骨架（28 条）
插件骨架、快照存储（三键去重 + fsync 原子写）、v0.2 迁移器、§8 R1–R8 抽取引擎、`radar_add` / `radar_ranking` / `radar_papers`、排行面板、回执卡片、导出。
**证据**：`test/{extract,migrate,ranking,dedupe}.test.mjs`；`spike/evidence/radar-w0-*.png`

### W1.0 · 可用（15 条）
正文留存 `texts/`（gzip + sha1）、原地重算（默认 dryRun）、导入（三种形态）、写能力开关 + 写审批、`/radar` 命令、算法下钻、快速添加（DOI / arXiv）、自带三源并发检索、系统提示段（FR-8.8，随 `writeEnabled` 切换并禁止 shell 绕道）。
**证据**：`test/{reextract,import,approval,command,algorithm,sources,prompt}.test.mjs`；`spike/evidence/w1-detail.png`

### W1.1 · 好看（36 条）
撤销 / 清空 / 恢复（10 秒窗口）、趋势、领域分布、示例数据包、空状态三入口、响应式（720px）、图表表格视图、检索限速与缓存、PDF 登记（子进程 + 超时强杀）。
**证据**：`test/{undo,trends,samples,throttle,pdf}.test.mjs`；`spike/evidence/w11-{trends,samples,narrow,undo}.png`

### W1.2 · 更可信（5 条）
共现分析（lift）、每篇封顶计数（保留 rawMentions）、双时间轴、词典管理（增删改 / 别名搬移 / 软删除 / 口径版本联动）、批量 PDF。
**证据**：`test/{cooccurrence,dict}.test.mjs`；`spike/evidence/w12-{cooc,dict}.png`

### W2.0 · 长期（3 条 + `radar_text`）
正文读取开关（`radar_text` 默认不注册）、每日自动备份（7 份 / 懒触发）、i18n 骨架、新词候选队列、设置页、面板内一次性引导。
**证据**：`test/{w20,candidates}.test.mjs`；`spike/evidence/w20-{guide,settings,final}.png`

---

## 4. 关键不变量（全部有测试）

| 不变量 | 验证位置 |
|---|---|
| 正文永不进入工具返回（除 `radar_text`，≤8,000 字符） | `extract` / `tools` / `export` / `w20` |
| 单次工具返回 ≤12,000 字符，超限显式标注 | `ranking` E19 |
| 正文只在 `texts/` 落盘，删论文同事务删正文 | `reextract` |
| 加载期零副作用（不读盘 / 不写盘 / 不探测） | `status` E21 |
| 破坏性操作默认 dryRun，无审批通道时失败关闭 | `approval` / `import` / `undo` |
| `writeEnabled=false` 时不注册写工具且写接口 403 | `approval` + 宿主实测 |
| 系统提示段随 `writeEnabled` 切换；写关闭时明令禁止 shell / 改 `store.json` 绕道 | `prompt` |
| 排序用码位比较，不用 `localeCompare` | `ranking` |
| 覆盖率分母跟随筛选，4 位小数 | `ranking` / 面板 |

---

## 5. 实况快照（隔离实例）

```
5 篇论文 · 13 个算法 · 124 次提及 · 4 篇仅摘要
词典 2026.10.1  工具 19 个  备份 1 份（保留 7）
候选待处理 0  正文读取关闭（radar_text 不注册）
```

---

## 6. 未做 / 部分做（明示取舍）

| 项 | 状态 | 理由 |
|---|---|---|
| FR-9.6 全量文案 i18n | ⚠️ 部分 | 主框架 25 键已外置到 `locale/*.json`；长文案拆完要动 ~40 处 JSX，收益低 |
| `ctx.configForms` 设置表单 | ❌ 未用 | 它是**客户端**设置服务；本插件配置走 `cordis.patch.yml`（零依赖），面板有只读设置页满足 FR-12.1/12.3 |
| 会话内注入式引导 | ❌ 改做面板版 | 宿主机制是 `ctx.systemPrompt.section({name, order, text})`，`order` 取自宿主枚举，且**没有真实模型回合无法验证它真进了提示词**；改在可控面做等价且可验证的引导 |

这三项都不影响 P0/P1 的任何能力，也不影响数据正确性。

---

## 7. 已知限制（使用者需要知道）

1. **PDF 提取器是最小实现**：支持 FlateDecode 与常见文本算子；**Type0/CID 字体、加密 PDF、对象流里的内容流不支持**，会返回 `UNSUPPORTED_MEDIA` 并说明原因，不会假装成功。
2. **v0.2 的老论文没有留存正文**（v0.2 根本不存正文），所以它们不能被重算；面板会显示「旧口径 N 篇 · 无正文」而不是「待重算」。
3. **导入不带来正文文件**：导出默认不含正文，导入后 `hasText` 保持本地实际状态。
4. **趋势/领域的「分母」在筛选时按已加载论文（≤60 篇）计算**，超大库会偏小，界面已标注。
5. 备份不含正文；迁移要连 `texts/` 目录一起拷。
