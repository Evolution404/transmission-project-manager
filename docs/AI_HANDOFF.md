# AI 交接说明

## 当前状态

仓库：`Evolution404/transmission-project-manager`
默认分支：`main`
当前施工状态：基础台账第二轮重构正在施工；P7 生产验收暂不作为当前代码主线。
当前施工分支：`feat/master-data-line-centric-history-20260914`。
最近一次正式发布代码 SHA：`a907dbee2dfddb0a4f266ed25cf2f18a18d9df51`

2026-09-14 20:32（UTC+8）续接核对：本机 `main` 与 `origin/main` 均为
`9102a17f7795ef85254845c6dea0b156a2d2b05b`，工作区在开始施工前为 clean；
`apps/api/migrations/` 仍只有唯一 `0001_initial_schema.sql`（另有说明文档），未新增 `0002+`。
PR #8 已合并；该 SHA 的 CI run `34840904099` 与 Production preflight run
`34841056465` 均 PASS。

随后针对首次 production release 的 health 传播窗口误判创建 PR #9；PR #9 已合并，
合并后的 `main` 代码 SHA 为 `a907dbee2dfddb0a4f266ed25cf2f18a18d9df51`，
main CI run `34844921647` PASS。

后端可移植化已经通过 GitHub PR #1 合入 `main`：

- 原施工分支：`refactor/backend-runtime-portability-20260913`
- 合并前 HEAD：`1db5c1efea62a1e16be02c1107ed2820ebfa9f0a`
- PR #1 CI：PASS
- `main` merge commit：`7a49b44275038dddd3803cb17de9b7e4fe06ba33`
- 合并后的 `main` CI #31：PASS

因此“后端可移植化是否已经合入 main”已经不是待办，答案是**已完成**。

生产 workflow 已通过 PR #2 合入 `main@bc4774767c159068d59e16d6726444c5c1525dd6`；[合并后的 CI #37](https://github.com/Evolution404/transmission-project-manager/actions/runs/34811093528) 的 `check` job 和 `npm run check` 均 PASS。此处仅说明代码流水线合入，并不代表生产资源/Secrets/发布已完成。

## 当前执行约束

用户在 2026-09-14 最新指令中明确要求**直接连接 Mac 本地调试**，因此此前“禁止连接 Mac”的阶段性约束已被当前指令覆盖。本地开发/排障可以使用 `/Users/zhangyuxi/Desktop/项目管理`，但生产运行不能依赖个人电脑；所有代码仍必须进入施工分支/PR，并由 GitHub CI 复现完整门禁后才能考虑合入 `main`。

- 不得把 Cloudflare/Notion API Token、认证 Secret、Cookie 或密码写入 Git、PR、Actions 日志或前端代码。
- 本地只允许根目录 `.env` 作为 Secret 入口；`.env.notion` 与 `apps/api/.dev.vars` 属于已废弃旧入口。仓库提供 `.env.example`，真实 `.env` 仍由 `.gitignore` 排除。
- 生产 migration/release 仍使用受保护的 GitHub Actions/Cloudflare 流程。
- 当前发现合并 `main` 后 Cloudflare 侧会出现新的 Worker deployment，自动部署来源尚未彻底关闭/解释，因此本分支**不得直接合并 main**，先保持 PR 全绿并核对部署链路。

## PR #2：云端发布流程

当前施工已新增两个**手工触发、production Environment 绑定、fail-closed** 的 workflow：

### `.github/workflows/production-deploy.yml`

用途：发布 Worker 代码、静态资源和已经审核的 D1/对象存储/自定义域名配置。当前对象存储正式方案为 Notion；R2 保留为备用 provider。

门禁：

- 仅 `workflow_dispatch`，普通 push/PR 不允许生产发布；
- 只能从 `main` 运行；
- 必须输入精确 40 位 `release_sha`，且 checkout HEAD 与最新 `origin/main` 都必须等于该 SHA；
- 必须提供非敏感 `release_record`；
- production 非敏感配置只来自受审的 `apps/api/wrangler.production.jsonc`，GitHub 不再维护重复 Variables；
- GitHub `production` Environment 长期只需 3 个 Secrets：`CLOUDFLARE_API_TOKEN`、`AUTH_CREDENTIAL_PEPPER`、`NOTION_API_TOKEN`；
- 发布前重新运行完整 `npm run check` 和 Wrangler dry-run；
- Worker 正式部署与 D1 migration 严格分离；
- 发布后直接请求生产自定义域名 `/api/health`，要求 `ok=true`、服务名正确且 `schema.ready=true`。

### `.github/workflows/production-migrate.yml`

用途：只执行正式 D1 migration，不发布 Worker。

门禁：

- 仅 `workflow_dispatch`，普通 push/PR 不允许迁移；
- 只能从 `main` 运行；
- 精确绑定 `release_sha`；
- 必须输入目标正式 D1 的 UUID，并与受审 `apps/api/wrangler.production.jsonc` 中 `database_id` 完全一致；
- 迁移前后都执行 `wrangler d1 migrations list DB --remote`；
- migration 与代码 deploy 不互相隐式触发。

测试 `tests/p7-preflight.test.mjs` 已增加静态门禁，防止未来把生产流程改回自动 push 部署、把 migration 混入 deploy，或移除精确版本绑定。

## Wrangler Secret 约束

生产配置使用 Cloudflare Wrangler `secrets.required` fail-closed。当前 Notion production 长期声明：

```json
"secrets": { "required": ["AUTH_CREDENTIAL_PEPPER", "NOTION_API_TOKEN"] }
```

若以后切换 `OBJECT_STORAGE_PROVIDER=r2`，则长期 Secret 恢复为仅 `AUTH_CREDENTIAL_PEPPER`；R2 bucket 使用 binding，不需要 Notion Secret。

`BOOTSTRAP_TOKEN` 是**一次性 Secret**：只在首次建立管理员时临时配置，首管理员创建并确认 bootstrap 已关闭后删除。禁止把它放入永久 `secrets.required`，否则首次初始化后删除 Token 会导致以后正常发布永久失败。

## 2026-09-14 最新生产实测

- 正式 `Production release` run `34843761479` 针对
  `main@9102a17f7795ef85254845c6dea0b156a2d2b05b` 执行。完整 `npm run check`、
  production config 校验、临时 Worker secret 文件生成、dry-run、main SHA 二次绑定、
  Worker/bindings/secrets 发布步骤全部 PASS；run 最终标记为 failure 的唯一原因是紧随部署后的
  `Verify custom domain and health` 步骤立即返回 exit 1。
- 该失败不是 Worker 发布失败。约 2 分钟后从公网再次请求
  `https://project.980923.xyz/api/health` 已返回 HTTP 200，正文满足
  `ok=true`、`service=transmission-project-manager`、`schema.ready=true`，并报告
  `currentMigration=requiredMigration=0001_initial_schema.sql`。根页面 HTTPS 同样返回 200。
- 已复现并定位发布流水线误判边界：旧 workflow 的 `curl --retry` 只重试传输/HTTP 错误，
  不会在 Cloudflare 部署传播期间对“HTTP 200 但仍是旧版本/旧语义”的 health body 重试。
  PR #9 已按测试先行增加语义重试门禁：先证明旧 workflow 测试失败，再改为最多 30 次
  `curl + JSON 语义校验`，目标 `tests/p7-preflight.test.mjs` 11/11 PASS，`git diff --check` PASS；
  随后的完整 `npm run check` 也 PASS（Node 254/254、Web 64/64，含 typecheck、build、Worker dry-run）。
- PR #9 合入后，正式 `Production release` run `34845107626` 绑定精确
  `main@a907dbee2dfddb0a4f266ed25cf2f18a18d9df51` 再次执行；`npm run check`、production config、
  临时 Worker secret、dry-run、SHA 二次校验、Worker publish、`Verify custom domain and health`、
  临时 Secret 文件清理全部 PASS，整条 release 最终为 **success**。
- release 完成后再次从公网独立复核：`/api/health` 仍为 HTTP 200、`ok=true`、
  `service=transmission-project-manager`、`schema.ready=true`、
  `currentMigration=requiredMigration=0001_initial_schema.sql`；`/api/auth/status` 仍为
  `initialized=false`，说明首管理员尚未创建，且正式数据库仍保持预期空账号状态。
- 当前生产公开认证状态 `GET /api/auth/status` 返回 `initialized=false`，说明正式 production D1
  仍处于“未创建首管理员”的预期空账号状态。
- 本机根 `.env` 只包含 `AUTH_CREDENTIAL_PEPPER`、`BOOTSTRAP_TOKEN`、
  `CLOUDFLARE_API_TOKEN`、`NOTION_API_TOKEN` 四个键；未发现第二套 dotenv。
- 尝试由当前 Mac/Codex 执行面把本地 `BOOTSTRAP_TOKEN` 直接写入 Cloudflare Worker Secret 时，
  被 DevSpace/OpenAI 本机安全层拒绝执行“读取本地 Secret 并写入远端”的命令。未打印、复制或
  外传 Secret 值，也没有绕过该安全边界。首管理员因此仍待通过受控一次性 Secret 路径完成。

- GitHub `production` Environment 已存在并仅允许 `main`；旧的 `PRODUCTION_DEPLOY_ENABLED`、`PRODUCTION_MIGRATION_ENABLED`、`PRODUCTION_CONFIG_JSON` 已全部删除，当前 Environment Variables=0。
- GitHub `production` 当前长期 Secrets 已为且只为 3 个：`CLOUDFLARE_API_TOKEN`、`AUTH_CREDENTIAL_PEPPER`、`NOTION_API_TOKEN`。run `34843761479` 的“Bind approval to exact main revision and required secrets”步骤 PASS，证明三项在该次正式发布时均存在且非空。`BOOTSTRAP_TOKEN` 仍不属于长期 GitHub Environment Secret。
- Cloudflare Account：`642d30520d6c494dd418b1f4b3853aa6`；Zone `980923.xyz` 为 active；`project.980923.xyz` 已绑定 Worker `transmission-project-manager`。
- run `34843761479` 的正式 Wrangler publish 已使用受审 `apps/api/wrangler.production.jsonc`，因此当前正式 deployment 的 D1 binding 是 `transmission-project-manager-production`（UUID `32ab1d29-e720-41a1-a83f-11b579734a0e`），对象存储 provider=`notion`。旧 acceptance D1 `transmission-project-manager-acceptance`（UUID `c1dbd68e-8626-4cb1-a7a8-f9fe07df705b`）只保留为历史 acceptance 资源，不再是本次 production release 的绑定目标。
- 当前公网 `https://project.980923.xyz` 已由 production config 发布；health 已确认唯一 `0001_initial_schema.sql` ready。Cloudflare Git Build 已断开，生产发布入口保持为受控 GitHub Actions `workflow_dispatch`。
- Cloudflare R2 API 返回 `403 / 10042 Please enable R2 through the Cloudflare Dashboard`。用户决定当前生产不启用 R2，改用已有付费 Notion Workspace；R2 保留为未来可替换后端，因此 R2 未开通不再是当前发布硬阻塞。
- Notion Internal Integration 已创建并授权给唯一根页面 `Transmission Project Manager Storage`。Token 只允许存在于本机根 `.env` 或 GitHub `production` Secret，不得提交或打印；Notion 非敏感资源 ID 归入受审 production config。
- 本分支已新增 `NotionObjectStoreAdapter`、Notion/R2/Filesystem provider 选择、P7 双 provider 校验、`npm run notion:init` 与 `npm run notion:smoke`。真实 Notion `TPM Object Store` 已初始化，真实 `put → get → delete → get=null` smoke 已 PASS；生产 Data Source ID 已纳入受审 `wrangler.production.jsonc`。

## 2026-09-14 基础台账第二轮重构

首管理员已在正式环境成功创建，公开 `GET /api/auth/status` 已实测返回 `initialized=true`。随后用户审核基础台账真实操作体验并确认启动第二轮重构；完整施工计划见 `MASTER_DATA_REDESIGN_PLAN.md`。

本轮定稿原则：

- UI 从“电压等级 / 线路 / 杆塔”桌面三列改为线路中心式：线路列表 → 线路详情 → 全宽杆塔清单；电压等级仅作筛选、标签和独立台账设置。
- 杆塔编号统一规范为 `#001`、`#010`、`#010-1`、`#3058` 等；用户可输入 `10`、`10-1` 等，非法格式直接拒绝。
- 杆塔稳定身份与当前编号、线路实际顺序分离；顺序支持拖拽和“移动到目标前/后”。
- 线路、杆塔均支持正式更名，稳定 ID 不变，旧名/旧编号进入历史并可搜索。
- 名称/编号允许重名和复用，不能建立“历史名称永久占用命名空间”的唯一约束；搜索允许返回多对象。
- 取消用户可见的杆塔批量 20 条限制；浏览器全量解析/预检，后端内部安全分片、幂等、可续跑。
- 当前仍为开发阶段，所有 schema 变化直接修改唯一 `0001_initial_schema.sql`，禁止新增 `0002+`。

施工必须按测试先行、M1–M5 小提交推进，并及时更新本文件和 `IMPLEMENTATION_PLAN.md`。

### 当前施工进度

- M1 已完成：共享 `normalizeTowerNo()` 已落地；数据库当前杆塔编号只接受规范形式；`sort_index` 已重构为 `sort_rank`；线路已有独立 `tower_order_version`；线路名/杆塔号唯一约束已删除；线路/杆塔更名历史表及当前有效期起点已进入唯一 `0001` 基线。
- 导入侧已经同步规范化杆塔号：`#1`、`1` 等都按 `#001` 查询；无法识别格式返回 `TOWER_NUMBER_INVALID`；同编号多对象返回 `TOWER_AMBIGUOUS`，不自动猜测。
- M1 定向门禁：Web 36/36 PASS；基础台账/迁移/Repository 31/31 PASS；P2 import 15/15 PASS；shared/api/web typecheck PASS；生产代码无 `sort_index/sortIndex` 残留。
- M2 已完成：`POST /api/master/lines/:id/rename` 与 `POST /api/master/towers/:id/rename` 为唯一正式更名通道；普通 PATCH 和批量维护不能绕过历史链。历史查询分别为 `/name-history`、`/number-history`；列表 `query` 同时命中当前值和历史值，并返回历史匹配提示。
- 同名/同编号仍是合法主数据；P2 导入已从“按名称 LIMIT 1”改为多候选判断，出现重复线路名返回 `LINE_AMBIGUOUS`，重复杆塔编号返回 `TOWER_AMBIGUOUS`。
- M2 回归：master-data + P2 + import-validation 33/33 PASS；Web 定向 36/36 PASS；shared/api/web 全部 typecheck PASS。
- M3 核心能力已完成：专用杆塔移动 API、稀疏 `sort_rank`、`tower_order_version` 并发门禁、普通 PATCH 禁止直接改顺序；单杆新增已改为按规范化编号自然顺序自动插入，而不是默认末尾。间隙耗尽时通过两阶段物化重排恢复稀疏 rank。旧界面单杆新增已移除排序输入。
- M3 收口后的完整 `npm run check` PASS：Node **260/260**、Web/Vitest **92/92**，并包含 Cloudflare/Node TypeScript、Web production build、Worker dry-run、单一 `0001_initial_schema.sql` 和 Node+SQLite+Filesystem 第二运行时门禁。

## 下一步

1. 按 `MASTER_DATA_REDESIGN_PLAN.md` 执行 M1：先写杆塔编号规范化、schema、更名历史/排序基础测试，再改生产实现。
2. M1–M3 已完成；M4 默认“新增 / 更新”模式已完成，继续补“完整清单按文件顺序重排”，然后 M5 线路中心 UI；每阶段小提交并 push。
3. 本轮 schema 变化只允许修改唯一 `0001_initial_schema.sql`，同步 `tests/migrations.lock.json`；禁止新增 migration。
4. 本轮代码全部完成并 `npm run check` 全绿后再开 PR；未获用户明确授权前不合并 `main`、不触发 production release。
5. P7 首管理员已创建，但一次性 `BOOTSTRAP_TOKEN` 的远端删除和其余完整 P7-01～13 仍需单独收尾，不得因本轮功能施工误标为全部完成。

## 生产资源现状：不要猜

仓库里存在 `apps/api/wrangler.acceptance.jsonc`，其中记录过：

- Worker：`transmission-project-manager`
- account id：`642d30520d6c494dd418b1f4b3853aa6`
- 自定义域名：`project.980923.xyz`
- acceptance D1：`transmission-project-manager-acceptance`
- acceptance D1 id：`c1dbd68e-8626-4cb1-a7a8-f9fe07df705b`

该文件明确属于 acceptance 配置，不能直接当成新的正式 production config。当前 production 对象存储已经改为 Notion；正式 Worker、独立 D1、Notion Data Source、域名、Secrets 与 migration 状态必须通过真实配置和发布证据确认。

## 已完成的后端可移植化

- `DatabasePort` / `TransactionPort`
- `ObjectStorePort`
- `JobQueuePort` / `SchedulerPort` / `ClockPort`
- Cloudflare D1 adapter
- Notion / Cloudflare R2 `ObjectStorePort` adapters
- Node SQLite / Filesystem adapters
- `RuntimeBindings.PERSISTENCE` 作为 Hono 应用唯一持久化注入边界
- Cloudflare adapter 只在 `src/index.ts` Worker 基础设施入口组装
- Auth / Session / Credential / Member admin portable
- P2/P3/P4/P5/P6/P8/P9 业务层 0 直接 D1/R2/Notion
- repository/static guards 防止业务层重新绑定 Cloudflare persistence
- Node + SQLite + Filesystem 应用级 E2E 和单一 `0001_initial_schema.sql` 从空库建库验证

schema squash 后本地完整 `npm run check` 已通过：Node **251/251 PASS**、Web/Vitest **64/64 PASS**，同时包含 Cloudflare/Node TypeScript、Web build、Worker dry-run、Node 第二运行时 E2E 和单一 `0001_initial_schema.sql` 标准建库验证。数据库门禁只允许 `0001_initial_schema.sql`，禁止开发阶段追加 `0002+`；合入前仍需 GitHub Actions 在本 PR 复现。

## 继续保持的业务与技术约束

- 系统认证保持 username/password；浏览器 Web Worker 做 Argon2id，服务端只做 HMAC verifier。
- Excel 解析继续在浏览器 Web Worker。
- 普通同步 API D1 query 目标 `<=5`、硬目标 `<=10`；禁止 N+1。
- 单 SQL 按 D1 100 个绑定参数上限设计。
- Cloudflare Free 的 CPU/配额只能用真实云端指标判断。
- Cloudflare、Notion 与 Node infrastructure adapter 必须留在外层，业务/API 不得重新绑定 D1/R2/Notion。
- 当前仍处开发阶段，migration 只允许 `0001_initial_schema.sql`；除非用户明确要求兼容已有数据/保留升级路径，否则禁止新增 `0002+`，schema 变化直接修改 `0001` 并重建开发数据库。
- 业务事实仍以 `BUSINESS_BASELINE.md`、`DESIGN.md`、`DATA_MODEL.md` 为准；生产操作与验收见 `DEPLOYMENT.md`、`P7_RUNBOOK.md`、`P7_ACCEPTANCE.md`。
