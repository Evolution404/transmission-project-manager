# AI 交接说明

## 当前状态

仓库：`Evolution404/transmission-project-manager`
施工分支：`refactor/backend-runtime-portability-20260913`
前一 merge-ready 基线：`cae0004 docs: mark backend portability merge ready`；接手时以 GitHub 上该分支最新远端 HEAD 为准。

本轮后端可移植化已经完成，当前分支为 **merge-ready**。最近一次完整门禁结果：Node **254/254 PASS**、Web/Vitest **64/64 PASS**、Cloudflare/Node TypeScript PASS、Web build PASS、Worker `wrangler deploy --dry-run` PASS。

最近一次与 `origin/main` 对比为 `0 / 93`：`main` 没有当前分支缺失的新提交，当前分支领先 93 个提交，因此具备 fast-forward 合并条件。

## 下一位 AI 的最高优先级约束：只做云上开发

用户已经明确要求：**下一位 AI 不要连接 Mac，也不要依赖任何本地电脑。**

从本交接开始：

- 不连接 `/Users/zhangyuxi/Desktop/项目管理`，不要调用 Mac、本地 shell、本地文件系统、本地 Wrangler、本地 SQLite 或任何用户电脑能力。
- 只以 GitHub 远端仓库为代码事实来源；代码阅读、修改、分支、PR、合并、CI、发布记录均在 GitHub 完成。
- 自动测试和质量门禁只认 GitHub Actions / 远端 CI 结果，不再把“某台 Mac 本地通过”作为后续开发或发布前提。
- Cloudflare 发布优先通过 GitHub Actions / Cloudflare Git 集成 / GitHub 中已配置的 Cloudflare 凭据完成，不依赖用户电脑上的 Wrangler 登录态。
- 后续所有开发继续走远端分支 + PR + CI；不要因为缺少 Mac 而要求用户恢复本地环境。
- 如果现有 GitHub Actions 尚未具备 Cloudflare 正式发布能力，第一项云上工作就是完善/启用受保护的发布 workflow 和所需 GitHub Environment/Secrets，而不是回到本地发布。
- 不得把 Secret 写入仓库、PR、Actions 日志或前端代码。

Mac 只代表历史施工环境，**从现在起不是开发、测试、发布或故障处理依赖**。

## 下一步任务：GitHub 合并并发布 Cloudflare

用户已要求下一位 AI 接手后直接从 GitHub 继续，并发布 Cloudflare。建议按以下顺序执行：

1. 仅通过 GitHub 检查 `refactor/backend-runtime-portability-20260913` 的最新远端 HEAD、CI 状态和 `main` 差异。
2. 确认最新 GitHub CI 全绿；若 CI 尚未覆盖 `npm run check`，先在 GitHub Actions 补齐对应门禁。
3. 通过 GitHub PR / merge 操作将该 merge-ready 分支合入 `main`。不要在本地 merge/rebase。
4. 检查 GitHub 中 Cloudflare 发布 workflow、Environment protection、Secrets 和目标资源配置。
5. 在 GitHub 触发 Cloudflare 发布；生产部署仍以 Cloudflare Workers Free + D1 + R2 为当前基线。
6. 若生产 D1 需要 migration，只通过受控 GitHub/Cloudflare 发布流程执行，并先完成远端备份/预检；不得修改已冻结的 `0009`–`0012`，只能追加新 migration。
7. 发布后以真实 `/api/health`、登录、核心业务 smoke、静态资源、自定义域名和 Cloudflare 日志/指标验收。
8. 把实际部署 commit SHA、Worker version、D1 migration 状态、R2/域名/Secrets 配置状态和验收结果写回 GitHub 文档或 release/PR 记录。

注意：本轮之前没有正式发布、没有远端 D1 升级。不要把本地/合成测试误写成生产验收。

## 已完成的可移植化

基础设施与运行时边界：

- `DatabasePort` / `TransactionPort`
- `ObjectStorePort`
- `JobQueuePort` / `SchedulerPort` / `ClockPort`
- Cloudflare D1 / R2 adapters
- Node SQLite / Filesystem adapters
- `RuntimeBindings.PERSISTENCE` 作为 Hono 应用唯一持久化注入边界
- Cloudflare adapter 只在 `src/index.ts` Worker 基础设施入口组装
- Node runtime typecheck 已覆盖真实 `app.ts`、认证和 P2/P3/P4/P5/P6/P8/P9

业务/API 层：

- Auth / Session / Credential / Member admin：portable
- 顶层 schema readiness / settings / dictionary：portable；旧 `src/db.ts` 已删除
- P2：0 直接 D1
- P3：0 直接 D1
- P4：0 直接 D1
- P5：历史兼容执行链路 + 附件，0 直接 D1/R2
- P6：分析、报告、里程碑、预警、outbox、逻辑备份，0 直接 D1/R2
- P8：项目级出库 → 任务 → 供应 → 实施 → 结算 → 四状态反馈，0 直接 D1
- P9：基础台账与结构化需求，0 直接 D1
- repository/static guards 已防止业务层重新绑定 Cloudflare persistence

## 第二运行时已验证

`tests/node-runtime-app.test.mjs` 已验证真实 Hono app 在仅注入 `Node + SQLite + Filesystem` 时可以完成：

- `0001`–`0012` migrations；
- health/schema readiness；
- bootstrap / HttpOnly session；
- settings 幂等；
- 基础台账 HTTP 写入/读取；
- P6 backup 写入 Filesystem；
- SQLite 文件重开后的会话和业务数据持久化。

`tests/node-runtime-migration-rehearsal.test.mjs` 已验证 P7-era（0001–0007）SQLite 顺序升级 0008–0012 后仍能由 Node app 启动，并保留历史来源、旧 `demand_allocations`、setting 和 P5 lifecycle 事实。

Node 第二运行时的意义是保留未来迁往普通服务器的能力；当前正式发布仍以 Cloudflare 为基线。

## 最新完整门禁

最近一次完整 `npm run check`：

- Node：**254/254 PASS**
- Web/Vitest：**64/64 PASS**
- Cloudflare TypeScript：PASS
- Node 完整 app TypeScript：PASS
- Web production build：PASS
- Worker dry-run：PASS
- Node SQLite + Filesystem application E2E：PASS
- P7-era → 0012 migration rehearsal：PASS
- `git diff --check`：PASS

后续不再要求下一位 AI 在 Mac 上重跑这些测试；应由 GitHub CI 复现并作为唯一持续门禁。

## 关键提交

- `be92c60 refactor: remove direct d1 from p8 business flows`
- `c09a35d refactor: port p5 legacy execution flows`
- `932da02 refactor: port p6 operation journal`
- `38fdba3 refactor: port p6 analysis persistence`
- `b4ee403 refactor: port p6 notification persistence`
- `f2b6699 refactor: port p6 backup persistence`
- `c5d3185 refactor: remove direct cloudflare persistence from p6`
- `637b8cc refactor: inject portable api persistence`
- `2c5a6ba test: exercise node application runtime`
- `cae0004 docs: mark backend portability merge ready`

## 继续保持的业务与技术约束

- 系统认证保持 username/password；浏览器 Web Worker 做 Argon2id，服务端不得执行慢 KDF。
- Excel 解析继续在浏览器 Web Worker。
- 普通同步 API D1 query 目标 `<=5`、硬目标 `<=10`；禁止 N+1。
- 单 SQL 按 D1 100 个绑定参数上限设计。
- Cloudflare Free 的 10ms CPU 必须用真实云端指标判断，不使用本地 wall-clock 替代。
- Cloudflare 与 Node 基础设施 adapter 必须留在外层，业务/API 不得重新绑定 D1/R2。
- 已冻结 migration `0009`–`0012` 不得修改，只能追加后续 migration。
- 后续任何改动都应在 GitHub 分支/PR 中小步提交，由 GitHub CI 验证后再合并和发布。

业务事实仍以 `BUSINESS_BASELINE.md`、`DESIGN.md`、`DATA_MODEL.md` 为准；生产操作与验收见 `DEPLOYMENT.md`、`P7_RUNBOOK.md`、`P7_ACCEPTANCE.md`。
