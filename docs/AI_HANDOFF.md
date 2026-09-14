# AI 交接说明

## 当前状态

仓库：`Evolution404/transmission-project-manager`
默认分支：`main`
当前施工分支：`feat/notion-object-storage`
当前 `origin/main`：`fa9076e16d2a550478db9825829e1b2153b956b3`

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

- GitHub `production` Environment 已存在并仅允许 `main`；旧的 `PRODUCTION_DEPLOY_ENABLED`、`PRODUCTION_MIGRATION_ENABLED`、`PRODUCTION_CONFIG_JSON` 已全部删除，当前 Environment Variables=0。
- 长期 Secrets 目标为 3 个：`CLOUDFLARE_API_TOKEN`、`AUTH_CREDENTIAL_PEPPER`、`NOTION_API_TOKEN`。当前实际只有 `CLOUDFLARE_API_TOKEN` 已配置并实测有效；后两项仍需由用户在 GitHub `production` Environment 中录入，禁止从本机 Secret 文件自动外传。
- Cloudflare Account：`642d30520d6c494dd418b1f4b3853aa6`；Zone `980923.xyz` 为 active；`project.980923.xyz` 已绑定 Worker `transmission-project-manager`。
- 当前 Worker 实际仍绑定 acceptance D1 `transmission-project-manager-acceptance`（UUID `c1dbd68e-8626-4cb1-a7a8-f9fe07df705b`），不能冒充新的正式 production D1。
- 当前公网 `https://project.980923.xyz` 仍由旧 acceptance D1 承载，属于 schema squash 前的开发环境，不再执行历史升级；后续发布直接切换到新的单基线 production D1。
- Cloudflare R2 API 返回 `403 / 10042 Please enable R2 through the Cloudflare Dashboard`。用户决定当前生产不启用 R2，改用已有付费 Notion Workspace；R2 保留为未来可替换后端，因此 R2 未开通不再是当前发布硬阻塞。
- Notion Internal Integration 已创建并授权给唯一根页面 `Transmission Project Manager Storage`。Token 只允许存在于本机根 `.env` 或 GitHub `production` Secret，不得提交或打印；Notion 非敏感资源 ID 归入受审 production config。
- 本分支已新增 `NotionObjectStoreAdapter`、Notion/R2/Filesystem provider 选择、P7 双 provider 校验、`npm run notion:init` 与 `npm run notion:smoke`。真实 Notion `TPM Object Store` 已初始化，真实 `put → get → delete → get=null` smoke 已 PASS；生产 Data Source ID 已纳入受审 `wrangler.production.jsonc`。

## 下一步

1. 本分支最新完整 `npm run check` 已 PASS（Node 254/254、Web 64/64）；继续拆小提交并 push，由 GitHub CI 复现后再考虑合并。
2. 统一 Secret 配置代码已完成：本地目标仅保留一个 `.env`；GitHub production 已清空旧 Variables；正式 deploy 使用 `--secrets-file` 将 Worker Secrets 与代码同版本发布。由于安全边界阻止自动搬运真实 Secret，本机仍需用户自行执行一次 `npm run config:local-env:migrate`，GitHub 仍需补 `AUTH_CREDENTIAL_PEPPER` 与 `NOTION_API_TOKEN` 两个 Secret。
3. 独立正式 production D1 已重建为开发期单基线数据库，只应用 `0001_initial_schema.sql`；后续发布直接绑定该库，不复用或升级旧 acceptance D1。
4. 查清/关闭意外的 main→Cloudflare 自动部署链路后，再按受控 migration/release workflow 合并和发布。
5. 发布后真实验收 health、登录、核心业务、Notion 附件/备份、Cron、域名和 Cloudflare/Notion 错误指标。

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
