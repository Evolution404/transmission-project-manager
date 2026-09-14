# AI 交接说明

## 当前任务

仓库：`Evolution404/transmission-project-manager`
本机：`/Users/zhangyuxi/Desktop/项目管理`
施工分支：`refactor/backend-runtime-portability-20260913`
最新 P4 代码提交：`2b0e9b2 refactor: remove direct d1 from p4 finance`

当前工作不是扩业务，而是把既有后端从 Cloudflare 绑定中抽离：

- Cloudflare Workers Free + D1 + R2 继续作为当前部署基线；
- 同一业务核心同时支持 `Node.js + SQLite + Filesystem` 第二运行时；
- 业务/API 层不得重新直接依赖 D1/R2/Queue；
- 按业务语义抽 Repository/Port，不做机械 SQL 包装；
- 所有改动小 commit，专项测试通过后及时 commit + push。

业务事实以 `BUSINESS_BASELINE.md`、`DESIGN.md`、`DATA_MODEL.md` 为准。已冻结 migration `0009`–`0012` 不得修改。

## 绝对约束

- 不使用 `git reset` / `git clean`，不覆盖已有工作区修改。
- 未经用户明确授权，不部署、不升级远端 D1、不合并 `main`、不创建收费资源。
- 保持系统自维护 username/password；不得恢复 Cloudflare Access/邮箱认证。
- 浏览器继续负责 Argon2id；不得把慢 KDF 放回 Worker。
- Cloudflare runtime 与 Node runtime 保持独立类型边界。
- Excel 继续在浏览器 Web Worker 解析；复杂批任务后续走统一 Job/chunk，不把大计算塞进 Worker。

## 已完成的可移植化

基础设施：

- `DatabasePort` / `TransactionPort`
- `ObjectStorePort`
- `JobQueuePort` / `SchedulerPort` / `ClockPort`
- D1 / R2 adapters
- SQLite / Filesystem adapters
- Cloudflare / Node persistence factories
- Cloudflare 核心依赖静态门禁

业务迁移：

- Session / Auth / Credential / Member admin
- P5 附件内容与附件元数据
- P9 基础台账与结构化需求
- P2 导入、校验、发布、需求查询：`p2.ts` 0 直接 D1
- P3 项目储备全读写链路：`p3.ts` 0 直接 D1，并有静态防回退门禁
- P4 财务全链路：`p4.ts` 0 直接 D1，并有静态防回退门禁

P4 本轮已完成：

1. Framework / Agreement create/update 原子写事务 → `FinanceWriteRepository`。
2. 项目绑定 Framework → portable query/write repository。
3. Budget list/create/update/confirm/history → `FinanceBudgetRepository`；列表改为集合查询，消除路由 N+1。
4. 协议同框架/有效期校验 → 通用 `FinanceQueryRepository`。
5. Financial entry list/create/reverse → `FinanceEntryRepository`；keyset 分页避免 `limit+1=101` 形成 101 个绑定参数。
6. Finance summary → `FinanceSummaryRepository` 只读取资金事实；80%/90% 告警和进度计算仍留在业务层。
7. 删除 P4 旧 D1 helper；`tests/repository-guards.test.mjs` 已增加 P4 禁止直接 D1 的静态门禁。

关键提交：

- `8785ae8 refactor: port p4 framework agreement writes`
- `e4b4e94 refactor: port p4 project framework binding`
- `5addb1b refactor: port p4 budget persistence`
- `ded7710 refactor: centralize finance allocation validation`
- `a87212e refactor: port p4 financial entries`
- `2b0e9b2 refactor: remove direct d1 from p4 finance`

## 最新完整门禁

在 P4 完整收口后已执行 `npm run check`，全部通过：

- Node：221/221 PASS
- Web/Vitest：64/64 PASS
- TypeScript：PASS
- Web production build：PASS
- Worker `wrangler deploy --dry-run`：PASS

P4 定向门禁也通过：

- finance query/write/budget/entry/summary repository tests：PASS
- `tests/p4-finance.test.mjs`：11/11 PASS
- repository guards：PASS，包含 P4 0 直接 D1 门禁
- Cloudflare + Node 双 runtime typecheck：PASS
- `git diff --check`：PASS

这些仍只是本地/合成门禁，没有真实部署、没有远端 D1 升级。

## 当前工作区

P4 代码已全部提交并 push。接手时先运行：

```sh
git status --short --branch
git diff --check
```

不要假设工作区一定为空；若有用户或其他 AI 的未提交修改，必须保留并绕开。

## 后续顺序

P4 已完成，不要重复迁移。下一阶段按顺序：

1. P5/P8 执行业务：继续把仍直接依赖 D1/R2 的执行、供应、实施、结算等业务读写迁到 portable repositories；保持任务供应/实施/结算三线独立及需求四状态事实不变。
2. P6 backup / notification 后台任务：把 runtime-specific 的备份、通知、调度依赖收口到已有 `ObjectStorePort` / `JobQueuePort` / `SchedulerPort` 等边界。
3. 补 Node + SQLite + Filesystem 应用级 E2E 和数据迁移演练，证明第二运行时不只是 repository 单测可用。
4. 最后再做整体文档收口和远端/生产验收准备；未经授权仍不得部署、升级 D1 或合并 `main`。

每完成一个业务块：test-first → 定向回归 → repository guards → 双 runtime typecheck → `git diff --check` → 小 commit + push。阶段收口后再跑完整 `npm run check`。

## 免费额度与架构边界

- 普通同步 API D1 query 目标 `<= 5`，硬目标 `<= 10`。
- 禁止输入 N 增长导致查询数线性增长；优先集合查询与批量写。
- D1 单 SQL 绑定参数按上限 100 设计。
- 本地 wall-clock 不能当作 Cloudflare CPU；10ms CPU 最终只能用真实部署指标验收。
- `JobQueuePort` 已有，Cloudflare Queue / Node DB-backed job adapter 尚未完成。

完整业务和运维基线不要复制到本文件，分别查阅 `BUSINESS_BASELINE.md`、`DATA_MODEL.md`、`DEPLOYMENT.md`、`P7_ACCEPTANCE.md`。
