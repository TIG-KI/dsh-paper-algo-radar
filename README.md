# paper-algo-radar（论文算法雷达）

DSH 插件：把读过的论文转成「算法 × 章节 × 年份 × 领域」的结构化记录，给出排行、趋势、共现与领域分布。
正文只留在本机（gzip 落盘），模型侧只拿回执与摘要——**不回显正文**是硬约定。

| 项 | 现状 |
|---|---|
| 版本 | `0.2.0`（包名 `dsh-paper-algo-radar`） |
| 里程碑 | W0 / W1.0 / W1.1 / W1.2 / W2.0 全部交付；87 条 FR 落地 84，3 条 P2 明示未做 |
| 单元测试 | **859 条 / 27 套件**，`node --test` 全绿，不碰网络、不需要宿主 |
| 端到端 | **94 条**（scan 16 / reextract 13 / import 15 / 网络 13 / 完整路径 37），需真实宿主 |
| 验收批 | **10 PASS / 0 FAIL / 9 SKIP**（SKIP = 需网络凭据或人工抽查，不计入通过） |
| 模型面向工具 | 19 个（读 9 + 写 10；`radar_text` 仅在 `textReadEnabled` 打开时 +1） |
| HTTP 路由 | 13 个 exact 端点；面板 7 个标签页（排行 / 论文 / 趋势 / 领域 / 共现 / 词典 / 设置） |

## 仓库结构

```
paper-algo-radar/        插件本体（可独立安装，宿主侧零运行时依赖）
  lib/                   20 个宿主模块 + client.js（客户端，零构建）+ pdf-worker.mjs
  test/                  27 个单元套件（.test.mjs）+ 5 个 e2e 脚本 + 验收批
  scripts/               维护脚本（repair-corrupt-texts.mjs：清历史乱码正文，默认 dry-run）
  locale/ icon.svg       文案与图标
  package.json           dsh manifest：manifestVersion / bundle.patch / client.inject / engines
  cordis.patch.yml       bundle 安装时的插入行（writeEnabled 总开关）
  README.md              插件细节：模块职责、19 个工具、装法与排障
docs/                    PRD、W0/W1 任务清单、交付验收报告
spike/evidence/          验收截图（docs/ACCEPTANCE.md 引用的证据）
MANIFEST.txt             v0.2.0 交付包 SHA256 清单（历史留档）
```

## 环境要求

- Node **≥ 22.19.0**（`engines.node`）
- DSH **≥ 0.2.1-rc.2**（`engines.dsh`）
- 插件宿主侧**零外部依赖**，只用 Node 内建模块

## 跑测试

```bash
cd paper-algo-radar

# 单元 + 函数级：27 套件 / 859 断言，不需要宿主、不需要网络
node --test test/*.test.mjs

# 验收批（§12 用例的可本地执行部分）：PASS / FAIL / SKIP 三态
node test/acceptance.mjs

# 需要真实网络：快速添加（arXiv / DOI）与三源检索
node test/e2e-network.mjs
```

走真实宿主路由的 e2e 要连宿主地址与访问 token（token 即 Web GUI `/?token=...` 里那个）：

```bash
node test/e2e-scan.mjs      http://127.0.0.1:49440 <token>
node test/e2e-reextract.mjs http://127.0.0.1:49440 <token>
node test/e2e-import.mjs    http://127.0.0.1:49440 <token>
node test/e2e-journey.mjs   http://127.0.0.1:49440 <token>
```

走宿主路由的 e2e 会真实写库，脚本自己负责收尾（scan / reextract / journey 都带删除步骤，
import 那条只验证"导出→再导入→库不变"），**跑完不留脏数据**。

## 数据落在哪

```
~/.dsh/plugin-data/paper-algo-radar/
  store.json       库快照（原子写：fsync + rename）
  store.json.bak   上一次快照
  texts/           留存正文（gzip + sha1，供原地重算用）
  backups/         每日备份，保留 7 份（懒触发，不起定时器）
  exports/         导出产物（JSON / CSV）
```

## 本机安装与开发回环

本机（macOS）的安装链是：**workspace → `~/.dsh/plugins-local` → profile 的 `file:` 依赖**。

- profile 注册：`~/.dsh/profiles/desktop/package.json` 里
  `"dsh-paper-algo-radar": "file:/Users/<user>/.dsh/plugins-local/dsh-paper-algo-radar"`
  （`<user>` 换成本机用户名）
- 本仓库 `paper-algo-radar/` 与 `~/.dsh/plugins-local/dsh-paper-algo-radar/` 是**两份独立拷贝**
  （inode 不同），改工作区代码不会自动生效。

所以开发回环是三步：

```bash
# 1) 同步到安装位：不要 --delete；--inplace 保住与 node_modules 的硬链接
rsync -a --inplace --exclude '.DS_Store' paper-algo-radar/ \
  ~/.dsh/plugins-local/dsh-paper-algo-radar/

# 2) 完全退出宿主再启动（关窗口不算）：新 HTTP 路由是启动时注册的
# 3) 验证：/paper-algo-radar/state 的 tools 数量应为 19（textReadEnabled=false 时 18）
```

改完重启仍是旧行为，通常是宿主还拿着旧模块：先确认进程启动时间晚于 `lib/index.js` 的修改时间；
profile 里再跑一次 `pnpm install` 可刷新 `node_modules`（pnpm 对 `file:` 依赖会硬链接，
安装位与 `node_modules` 里**部分文件共享 inode**，所以原地改写能透传、但编辑器/`git checkout`
这类"写临时文件再改名"的操作会把硬链接断掉，此时必须重装）。

> Windows 上还有一段历史的踩坑记录（junction 被 `Copy-Item -Recurse` 解引用成副本，
> 导致宿主一直跑旧快照且日志无异常），见 `paper-algo-radar/README.md` 的「装法注意」。

## 版本控制约定

- 分支：`main`；基线 tag `v0.2.0-baseline`（对应 `chore: 初始化仓库` 那个提交）
- 提交信息用前缀：`feat` / `fix` / `test` / `docs` / `chore`（一个提交一件事）
- `.gitattributes` 把文本换行归一为 LF；`.gitignore` 排除 `.DS_Store`、`node_modules/`、日志
- 合入前最低门槛：`node --test test/*.test.mjs` 全绿（改到验收条款时再加 `node test/acceptance.mjs` 无 FAIL）

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/REQUIREMENTS_PLUGIN-v1.0.md](docs/REQUIREMENTS_PLUGIN-v1.0.md) | PRD（PAR-PRD-003 v1.0，87 条 FR） |
| [docs/W0_TASKS.md](docs/W0_TASKS.md) / [docs/W1_TASKS.md](docs/W1_TASKS.md) | 任务拆解与完成状态 |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) | 交付验收报告：指标、验证方式、不变量、未做项 |
| [paper-algo-radar/README.md](paper-algo-radar/README.md) | 插件细节：模块职责、19 个工具、数据通道、装法与排障 |

## 已知限制

- 3 条 P2 外围项按明示取舍未做，明细见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) §6。
- 验收批里的 9 条 SKIP 需要网络凭据、真实模型回合或人工抽查，**不算已通过**。
- 插件只登记「已出现过的算法名」；词典外的算法名进候选队列，需要人复核后再转正（插件不调 LLM）。

## 许可证

[MIT](LICENSE) © 2026 TIG-KI

