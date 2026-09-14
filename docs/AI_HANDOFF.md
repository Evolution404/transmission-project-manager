# AI 交接说明

## 当前状态

仓库：`Evolution404/transmission-project-manager`
本机：`/Users/zhangyuxi/Desktop/项目管理`
施工分支：`refactor/backend-runtime-portability-20260913`
最新代码提交：`2c5a6ba test: exercise node application runtime`

本轮“后端可移植化”代码施工已经完成，当前目标是保持分支 **merge-ready**。Cloudflare Workers Free + D1 + R2 仍是当前部署基线；同一 Hono 业务应用已经能够通过注入 `PersistencePorts` 在 `Node.js + SQLite + Filesystem` 上运行。

未经用户明确授权：**不要部署、不要升级远端 D1、不要合并 `main`、不要创建收费资源。**

业务事实以 `BUSINESS_BASELINE.md`、`DESIGN.md`、`DATA_MODEL.md` 为准。已冻结 migration `0009`–`0012` 不得修改。

## 已完成的可移植化

基础设施与运行时边界：

- `DatabasePort` / `TransactionPort`
- `ObjectStorePort`
- `JobQueuePort` / `SchedulerPort` / `ClockPort`
- Cloudflare D1 / R2 adapters
- Node SQLite / Filesystem adapters
- `RuntimeBindings.PERSISTENCE` 作为 Hono 应用唯一持久化注入边界
- Cloudflare adapter 只在 `src/index.ts` Worker 基础设施入口组装；业务/认证模块不得直接 import Cloudflare persistence factory
- Node runtime typecheck 已覆盖真实 `app.ts`、认证和 P2/P3/P4/P5/P6/P8/P9，而不是只覆盖 repository

业务/API 层：

- Auth / Session / Credential / Member admin：portable
- 顶层 schema readiness / settings / dictionary：portable；旧 `src/db.ts` 已删除
- P2 导入、校验、发布、需求查询：`p2.ts` 0 直接 D1
- P3 项目储备：`p3.ts` 0 直接 D1
- P4 财务：`p4.ts` 0 直接 D1
- P5 历史兼容执行链路 + 附件：`p5.ts` 0 直接 D1/R2
- P6 分析、报告、里程碑、预警、outbox、逻辑备份：`p6.ts` 0 直接 D1/R2
- P8 最终业务主链路：出库 → 任务 → 供应 → 实施 → 结算 → 四状态反馈，`p8.ts` 0 直接 D1
- P9 基础台账与结构化需求：0 直接 D1
- 对上述边界均有 repository/static guards 防止回退

## 第二运行时已验证

`tests/node-runtime-app.test.mjs` 使用真实 Hono `app`，环境中**不提供 DB/FILES bindings**，只注入 `createNodePersistence()`：

- 使用真实 `0001`–`0012` migrations 创建文件型 SQLite；
- `/api/health` schema readiness 正常；
- bootstrap / HttpOnly session 正常；
- settings 写入与 Idempotency-Key replay 正常；
- 基础台账真实 HTTP 写入/读取正常；
- P6 backup chunk 真实写入 Filesystem ObjectStore；
- 关闭并重新打开同一 SQLite 文件后，会话和业务数据仍可继续使用。

`tests/node-runtime-migration-rehearsal.test.mjs` 还验证：

- 先建立 P7-era（0001–0007）SQLite 和历史成员/需求/项目事实；
- 再顺序升级 0008–0012；
- 来源追溯、旧 `demand_allocations`、setting 等事实保持；
- 升级后的数据库可以直接由 Node Hono app 启动并读取旧 P5 lifecycle。

## 最新完整门禁

在代码提交 `2c5a6ba` 后执行 `npm run check`，全部通过：

- Node：**254/254 PASS**
- Web/Vitest：**64/64 PASS**
- Cloudflare TypeScript：PASS
- Node 完整 app TypeScript：PASS
- Web production build：PASS
- Worker `wrangler deploy --dry-run`：PASS
- Node SQLite + Filesystem application E2E：PASS
- P7-era → 0012 Node migration rehearsal：PASS
- `git diff --check`：PASS

这些仍是本地/合成门禁：没有真实部署，没有升级远端 D1，没有合并 `main`。P7 的真实 Cloudflare、真实数据、真实通知、真实恢复和运维移交验收仍是独立的生产准备任务，不属于本轮代码可移植化阻塞项。

## merge-ready 检查

接手先执行：

```sh
git status --short --branch
git fetch origin main
git diff --check
git log --left-right --cherry-pick --oneline origin/main...HEAD
```

如果要判断冲突，使用只读 `git merge-tree`；不要为了检查而 merge/rebase/reset。

只有用户明确授权后才可以把该分支合并到 `main`。合并前至少保证：

1. 工作区干净且分支已 push；
2. `npm run check` 全绿；
3. 与最新 `origin/main` 无未处理冲突；
4. 不伴随生产部署或远端 D1 migration。

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

## 继续保持的约束

- 不使用 `git reset` / `git clean`。
- 系统认证保持 username/password；浏览器 Web Worker 做 Argon2id，服务端不得执行慢 KDF。
- Excel 解析继续在浏览器 Web Worker。
- 普通同步 API D1 query 目标 `<=5`、硬目标 `<=10`；禁止 N+1。
- 单 SQL 按 D1 100 个绑定参数上限设计。
- 本地 wall-clock 不能代替 Cloudflare Free 10ms CPU 的真实部署指标。
- Cloudflare 与 Node 基础设施 adapter 必须留在外层，业务/API 不得重新绑定 D1/R2。
