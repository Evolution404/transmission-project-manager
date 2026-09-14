# AI 交接说明

## 当前状态

仓库：`Evolution404/transmission-project-manager`
默认分支：`main`
当前云端配置记录分支：`ops/production-environment-handoff-20260914`

后端可移植化已经通过 GitHub PR #1 合入 `main`：

- 原施工分支：`refactor/backend-runtime-portability-20260913`
- 合并前 HEAD：`1db5c1efea62a1e16be02c1107ed2820ebfa9f0a`
- PR #1 CI：PASS
- `main` merge commit：`7a49b44275038dddd3803cb17de9b7e4fe06ba33`
- 合并后的 `main` CI #31：PASS

因此“后端可移植化是否已经合入 main”已经不是待办，答案是**已完成**。

生产 workflow 已通过 PR #2 合入 `main@bc4774767c159068d59e16d6726444c5c1525dd6`；[合并后的 CI #37](https://github.com/Evolution404/transmission-project-manager/actions/runs/34811093528) 的 `check` job 和 `npm run check` 均 PASS。此处仅说明代码流水线合入，并不代表生产资源/Secrets/发布已完成。

## 最高优先级约束：只做云上开发

用户已经明确要求：**禁止连接 Mac，禁止依赖任何本地电脑、本地 shell、本地 Wrangler、本地 SQLite 或本地测试环境。**

从现在起：

- 代码阅读、修改、分支、PR、合并、CI、发布记录只以 GitHub 远端为准。
- 自动测试和质量门禁只认 GitHub Actions。
- Cloudflare 发布只走 GitHub Actions / Cloudflare Git 集成或其他受保护的云端发布流程。
- 不得因为缺少本地环境要求用户恢复 Mac。
- 不得把 Secret 写入仓库、PR、Actions 日志或前端代码。
- 后续开发固定采用：`远端分支 → PR → GitHub CI → 合并 main → Cloudflare 云端验证`。

Mac 仅是历史施工环境，不再是开发、测试、发布或故障处理依赖。

## PR #2：云端发布流程

当前施工已新增两个**手工触发、production Environment 绑定、fail-closed** 的 workflow：

### `.github/workflows/production-deploy.yml`

用途：发布 Worker 代码、静态资源和已经审核的 D1/R2/自定义域名绑定。

门禁：

- 仅 `workflow_dispatch`，普通 push/PR 不允许生产发布；
- 只能从 `main` 运行；
- 必须输入精确 40 位 `release_sha`，且 checkout HEAD 与最新 `origin/main` 都必须等于该 SHA；
- 必须提供非敏感 `release_record`；
- GitHub `production` Environment Variable `PRODUCTION_DEPLOY_ENABLED` 必须显式为 `true`；
- `PRODUCTION_CONFIG_JSON` 必须存在并通过 `npm run p7 -- config`；
- `CLOUDFLARE_API_TOKEN` 必须存在；
- 发布前重新运行完整 `npm run check` 和 Wrangler dry-run；
- Worker 正式部署与 D1 migration 严格分离；
- 发布后直接请求生产自定义域名 `/api/health`，要求 `ok=true`、服务名正确且 `schema.ready=true`。

### `.github/workflows/production-migrate.yml`

用途：只执行正式 D1 migration，不发布 Worker。

门禁：

- 仅 `workflow_dispatch`，普通 push/PR 不允许迁移；
- 只能从 `main` 运行；
- 精确绑定 `release_sha`；
- `PRODUCTION_MIGRATION_ENABLED` 必须显式为 `true`；
- 必须输入目标正式 D1 的 UUID，并与 `PRODUCTION_CONFIG_JSON` 中 `database_id` 完全一致；
- 迁移前后都执行 `wrangler d1 migrations list DB --remote`；
- migration 与代码 deploy 不互相隐式触发。

测试 `tests/p7-preflight.test.mjs` 已增加静态门禁，防止未来把生产流程改回自动 push 部署、把 migration 混入 deploy，或移除精确版本绑定。

## Wrangler Secret 约束

生产配置使用 Cloudflare Wrangler 当前官方 `secrets.required` 机制，只长期声明：

```json
"secrets": { "required": ["AUTH_CREDENTIAL_PEPPER"] }
```

这样 `wrangler deploy` 会在永久认证 pepper 缺失时 fail-closed。

`BOOTSTRAP_TOKEN` 是**一次性 Secret**：只在首次建立管理员时临时配置，首管理员创建并确认 bootstrap 已关闭后删除。禁止把它放入永久 `secrets.required`，否则首次初始化后删除 Token 会导致以后正常发布永久失败。

## 2026-09-14 云端配置实测

- GitHub production Environment 已在仓库 Settings → Environments 创建（Environment ID `21869294751`）。
- Deployment branches/tags 限制为仅 `main`（1 branch、0 tags）。
- Environment Variables `PRODUCTION_DEPLOY_ENABLED=false`、`PRODUCTION_MIGRATION_ENABLED=false` 已在 GitHub UI 确认；两个开关保持关闭。
- 尚无 `PRODUCTION_CONFIG_JSON`，Environment Secret 列表仍为空，`CLOUDFLARE_API_TOKEN` 未配置。
- 仓库目前 0 collaborators，只有所有者可贡献。Required reviewers / Prevent self-review 未设成；页面仍显示管理员绕过选项已勾选，不能声称审核保护完成。
- main 的 Branch protection 页面显示尚无 classic rule；新规则表单未保存，因此 main 保护尚未建立。Actions 默认 `GITHUB_TOKEN` 为只读，且 Actions 创建或批准 PR 未启用。
- Cloudflare Dashboard `dash.cloudflare.com` 在本次云端浏览器中持续显示安全验证，刷新后仍无法进入；尚未核实正式 Worker/D1/R2/Zone/Secrets/migrations。公开自定义域名健康接口也未得到可验证响应。不得从历史 acceptance 文件推断生产资源。
- 本轮未创建/修改 Cloudflare 资源，未配置任何 Token/pepper，未运行 preflight、migration 或 production release，也未声称生产验收通过。

## 后续云端接续

1. 恢复 Cloudflare Dashboard 的受信访问，核对正式生产 Worker/D1/R2/Zone、数据和 migration；与 acceptance 环境严格区分。
2. 明确独立的生产审核者或可执行的审核安排，完成 Environment 审核保护和 main 分支保护；保持两个生产开关 `false`。
3. 根据真实资源填写 `PRODUCTION_CONFIG_JSON`，配置专用最小权限 Cloudflare CI Secret 和不变的生产认证 pepper；不得在仓库或日志暴露值。
4. 依现有 `production-preflight.yml` 做无变更预检，再根据正式 D1 备份/数据状态决定是否运行独立 migration；schema ready 后才运行 release。
5. 发布后做真实健康、登录、核心业务/R2/Cron、域名与 Cloudflare 指标验收，并将非敏感证据回填。

## 生产资源现状：不要猜

仓库里存在 `apps/api/wrangler.acceptance.jsonc`，其中记录过：

- Worker：`transmission-project-manager`
- account id：`642d30520d6c494dd418b1f4b3853aa6`
- 自定义域名：`project.980923.xyz`
- acceptance D1：`transmission-project-manager-acceptance`
- acceptance D1 id：`c1dbd68e-8626-4cb1-a7a8-f9fe07df705b`

但该文件明确属于 acceptance 配置，且没有 R2 绑定，不能直接当成新的正式生产配置。生产 Worker、D1、R2、域名、Secrets、migration 状态必须通过真实云端配置和发布证据确认。

## 已完成的后端可移植化

- `DatabasePort` / `TransactionPort`
- `ObjectStorePort`
- `JobQueuePort` / `SchedulerPort` / `ClockPort`
- Cloudflare D1 / R2 adapters
- Node SQLite / Filesystem adapters
- `RuntimeBindings.PERSISTENCE` 作为 Hono 应用唯一持久化注入边界
- Cloudflare adapter 只在 `src/index.ts` Worker 基础设施入口组装
- Auth / Session / Credential / Member admin portable
- P2/P3/P4/P5/P6/P8/P9 业务层 0 直接 D1/R2
- repository/static guards 防止业务层重新绑定 Cloudflare persistence
- Node + SQLite + Filesystem 应用级 E2E 和 P7-era → 0012 migration rehearsal

最近已经被 GitHub Actions 在 PR #1 和合并后 `main` 两次复现的完整门禁包括 Cloudflare/Node TypeScript、Web build、Worker dry-run、Node/Web tests、Node 第二运行时 E2E 和 migration rehearsal。

## 继续保持的业务与技术约束

- 系统认证保持 username/password；浏览器 Web Worker 做 Argon2id，服务端只做 HMAC verifier。
- Excel 解析继续在浏览器 Web Worker。
- 普通同步 API D1 query 目标 `<=5`、硬目标 `<=10`；禁止 N+1。
- 单 SQL 按 D1 100 个绑定参数上限设计。
- Cloudflare Free 的 CPU/配额只能用真实云端指标判断。
- Cloudflare 与 Node infrastructure adapter 必须留在外层，业务/API 不得重新绑定 D1/R2。
- migration `0009`–`0012` 已冻结，不得修改，只能追加。
- 业务事实仍以 `BUSINESS_BASELINE.md`、`DESIGN.md`、`DATA_MODEL.md` 为准；生产操作与验收见 `DEPLOYMENT.md`、`P7_RUNBOOK.md`、`P7_ACCEPTANCE.md`。
