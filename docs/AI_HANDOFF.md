# AI 交接说明

## 当前任务

仓库：`Evolution404/transmission-project-manager`
本机：`/Users/zhangyuxi/Desktop/项目管理`
施工分支：`refactor/backend-runtime-portability-20260913`
最后已推送 HEAD：`2e937f9 refactor: reuse portable idempotency replay in p4`

当前工作不是扩业务，而是把既有后端从 Cloudflare 绑定中抽离：

- Cloudflare Workers Free + D1 + R2 继续作为当前部署基线；
- 同一业务核心同时支持 `Node.js + SQLite + Filesystem` 第二运行时；
- 业务/API 层不得重新直接依赖 D1/R2/Queue；
- 按业务语义抽 Repository/Port，不做机械 SQL 包装；
- 所有改动小 commit，专项测试通过后立即 commit + push。

业务事实以 `BUSINESS_BASELINE.md`、`DESIGN.md`、`DATA_MODEL.md` 为准。已冻结 migration `0009`–`0012` 不得修改。

## 绝对约束

- 不使用 `git reset` / `git clean`，不覆盖已有工作区修改。
- 未经用户明确授权，不部署、不升级远端 D1、不合并 `main`、不创建收费资源。
- 保持系统自维护 username/password；不得恢复 Cloudflare Access/邮箱认证。
- 浏览器继续负责 Argon2id；不得把慢 KDF 放回 Worker。
- Cloudflare runtime 与 Node runtime 保持独立类型边界。
- Excel 继续在浏览器 Web Worker 解析；复杂批任务后续走统一 Job/chunk，不把大计算塞进 Worker。

## 已完成的可移植化

基础设施已完成：

- `DatabasePort` / `TransactionPort`
- `ObjectStorePort`
- `JobQueuePort` / `SchedulerPort` / `ClockPort`
- D1 / R2 adapters
- SQLite / Filesystem adapters
- Cloudflare / Node persistence factories
- Cloudflare 核心依赖静态门禁

业务迁移已完成：

- Session / Auth / Credential / Member admin
- P5 附件内容与附件元数据
- P9 基础台账与结构化需求
- P2 导入、校验、发布、需求查询：`p2.ts` 已 0 直接 D1 引用
- P3 项目储备全读写链路：`p3.ts` 已 0 直接 D1 引用，并有静态防回退门禁
- P4 第一阶段：财务项目、框架、协议、框架/协议历史查询已进入 `FinanceQueryRepository`
- P4 幂等 replay 已复用 `SqlIdempotencyRepository`

P3 完整收口提交：`e34bde3 refactor: finish portable p3 project persistence`。

## 最近完整门禁

在 `e34bde3` 后执行过完整 `npm run check`：

- Node：210/210 PASS
- Web/Vitest：64/64 PASS
- TypeScript：PASS
- Web production build：PASS
- Worker `wrangler deploy --dry-run`：PASS

这只是本地/合成门禁，没有真实部署。

随后 P4 查询迁移和幂等 replay 已分别通过：

- `tests/p4-finance.test.mjs`：11/11 PASS
- `tests/finance-query-repository.test.mjs`：2/2 PASS
- repository guards：PASS
- Cloudflare + Node 双 runtime typecheck：PASS

P4 之后尚未重新跑完整 `npm run check`。

## 当前未提交工作区：不要覆盖

当前预期只有 3 个未跟踪文件：

- `apps/api/src/ports/finance-write-repository.ts`
- `apps/api/src/repositories/sql-finance-write-repository.ts`
- `tests/finance-write-repository.test.mjs`

目标：迁移 P4 framework/agreement create/update 写事务，使：

- 主表写入/版本 guard；
- immutable `framework_versions` / `agreement_versions`；
- audit；
- idempotency

保持同一原子 batch，stale version 不留下“幽灵历史版本”。

这 3 个文件已经写入实现，但**实现后的测试尚未运行，路由尚未切换，也尚未 commit/push**。

下一位 AI 第一件事必须先运行：

```sh
git status --short --branch
git diff --check
node --test tests/finance-write-repository.test.mjs
```

若仓储契约全绿，再把 `/frameworks`、`/agreements` create/update 路由切到 repository，随后跑：

```sh
node --test tests/finance-write-repository.test.mjs tests/finance-query-repository.test.mjs tests/p4-finance.test.mjs tests/repository-guards.test.mjs
npm run typecheck --workspace @tpm/api
git diff --check
```

全绿后作为独立小 commit 提交并 push。

## 后续顺序

P4 按以下顺序继续，一块一 commit：

1. Framework / Agreement 写事务（当前 WIP）。
2. 项目绑定 Framework。
3. Budget 查询、create/update/confirm/history。
4. Financial entry list/create/reverse。
5. Finance summary。
6. 清理 P4 旧 D1 helper，令 `p4.ts` 达到 0 直接 D1 引用并增加静态门禁。
7. 跑完整 `npm run check`。

P4 完成后再迁 P5/P8 执行业务，最后处理 P6 backup/notification 后台任务，并补 Node + SQLite + Filesystem 应用级 E2E / 数据迁移演练。

## 免费额度与架构边界

- 普通同步 API D1 query 目标 `<= 5`，硬目标 `<= 10`。
- 禁止输入 N 增长导致查询数线性增长；优先集合查询与批量写。
- D1 单 SQL 绑定参数按上限 100 设计。
- 本地 wall-clock 不能当作 Cloudflare CPU；10ms CPU 最终只能用真实部署指标验收。
- `JobQueuePort` 已有，Cloudflare Queue / Node DB-backed job adapter 尚未完成。

完整业务和运维基线不要复制到本文件，分别查阅 `BUSINESS_BASELINE.md`、`DATA_MODEL.md`、`DEPLOYMENT.md`、`P7_ACCEPTANCE.md`。
