# AI 交接说明

## 当前状态

仓库：`Evolution404/transmission-project-manager`
默认分支：`main`
当前云端发布施工分支：`ops/cloudflare-github-deploy-20260914`

后端可移植化已经通过 GitHub PR #1 合入 `main`：

- 原施工分支：`refactor/backend-runtime-portability-20260913`
- 合并前 HEAD：`1db5c1efea62a1e16be02c1107ed2820ebfa9f0a`
- PR #1 CI：PASS
- `main` merge commit：`7a49b44275038dddd3803cb17de9b7e4fe06ba33`
- 合并后的 `main` CI #31：PASS

因此“后端可移植化是否已经合入 main”已经不是待办，答案是**已完成**。

当前正在通过 PR #2 建立正式 Cloudflare 云端发布能力。PR #2：`ops: add protected Cloudflare production workflows`，分支 `ops/cloudflare-github-deploy-20260914`。接手时必须以 GitHub 上该 PR 最新 HEAD 和 CI 为准。

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

## GitHub / Cloudflare 设置仍未完成的部分

当前 GitHub 连接可以读写仓库、PR、Actions 结果，但**没有 GitHub Administration / Environment / Secrets 管理接口权限**：

- `main` 当前 GitHub branch endpoint 显示 `protected: false`；
- 读取 branch-protection 详情返回 integration 403；
- 当前连接无法创建/修改 GitHub Environment、Environment protection、Variables 或 Secrets；
- 当前连接也没有 Actions `workflow_dispatch` 的写操作能力。

因此不能把“workflow 代码已经存在”误写为“production Environment/Secrets 已经配置”或“已经正式发布”。

正式触发前，GitHub `production` Environment 至少需要实际确认：

- 部署分支限制：只允许 `main`；
- Required reviewer / 禁止自批 / 管理员绕过策略：按当前 GitHub 套餐实际可用能力启用并验证；
- Variable `PRODUCTION_DEPLOY_ENABLED`：平时建议 `false`，批准代码发布窗口时才设 `true`；
- Variable `PRODUCTION_MIGRATION_ENABLED`：平时必须 `false`，批准 migration 窗口时才临时设 `true`；
- Variable `PRODUCTION_CONFIG_JSON`：经过 P7 validator 验证的真实非敏感严格 JSON；
- Secret `CLOUDFLARE_API_TOKEN`：account-owned、最小权限、不得使用 Global API Key 或个人长期 Token。

Cloudflare Worker 侧必须真实存在永久 `AUTH_CREDENTIAL_PEPPER`。首次初始化管理员时再临时配置 `BOOTSTRAP_TOKEN`，完成后删除。

## 生产资源现状：不要猜

仓库里存在 `apps/api/wrangler.acceptance.jsonc`，其中记录过：

- Worker：`transmission-project-manager`
- account id：`642d30520d6c494dd418b1f4b3853aa6`
- 自定义域名：`project.980923.xyz`
- acceptance D1：`transmission-project-manager-acceptance`
- acceptance D1 id：`c1dbd68e-8626-4cb1-a7a8-f9fe07df705b`

但该文件明确属于 acceptance 配置，且没有 R2 绑定，不能直接当成新的正式生产配置。生产 Worker、D1、R2、域名、Secrets、migration 状态必须通过真实云端配置和发布证据确认。

## 下一步顺序

1. 等 PR #2 最新 GitHub CI 全绿；若失败，只在远端施工分支修复并重新由 Actions 验证。
2. PR #2 全绿后通过 GitHub 合入 `main`，再确认合并后的 `main` CI 全绿。
3. 在 GitHub UI/管理员接口实际建立并保护 `production` Environment，配置上述 Variables/Secret；不要把值提交进 Git。
4. 核对真实 Cloudflare Worker、D1、R2、自定义域名归属和资源 ID；空库也要留下空库证据。
5. 若正式 D1 需要 `0001`–`0012` migration，先完成备份/停写/目标 ID 核对，再手工运行 `Production D1 migration`；不得修改已冻结 migration。
6. 配置永久 `AUTH_CREDENTIAL_PEPPER`；首次初始化时临时配置 `BOOTSTRAP_TOKEN`。
7. 手工运行 `Production release`，输入准确的当前 `main` SHA 和发布记录引用；workflow 会自动验证真实 `/api/health`。
8. 发布后继续做登录、首管理员/bootstrap 关闭、核心业务 smoke、静态资源/附件、R2、Cron、D1 状态、自定义域名和 Cloudflare Logs/Workers Analytics/CPU 指标验收。
9. 把实际部署 SHA、Worker version/deployment ID、D1 migration 状态、R2/域名/Secrets 状态和真实验收结果写回 GitHub 文档或 release/PR 记录。

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
