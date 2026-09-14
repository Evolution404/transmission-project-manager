# AI 交接说明

## 当前任务

项目：`Evolution404/transmission-project-manager`
本机：`/Users/zhangyuxi/Desktop/项目管理`
当前施工分支：`refactor/backend-runtime-portability-20260913`

本轮目标不是继续扩业务，而是按用户确认的方案重构后端部署架构：

1. 以 Cloudflare Workers Free / D1 Free / R2 为当前运行基线，持续压低单请求 CPU、D1 query 和数据扫描量。
2. Cloudflare 必须成为基础设施适配器，而不是业务核心依赖。
3. 同一业务代码必须逐步具备普通服务器运行路径，第一备用运行时为 `Node.js + SQLite + 本地文件系统`。
4. 后续可以再增加 PostgreSQL / S3 等 adapter，但当前不要提前引入无必要的基础设施复杂度。
5. 所有改动拆成小 commit，验证后立即提交/推送；不要积累大批混合改动。

业务事实以 `BUSINESS_BASELINE.md`、`DESIGN.md`、`DATA_MODEL.md` 为准；不得借架构重构回退“电压等级 → 线路 → 杆塔 → 需求定位”对象模型，也不得改写已冻结 migration `0009`–`0012`。

## Git / 分支现状

旧 WIP / perf / docs 分支已经收敛并删除。本地和远端当前只保留：

- `main`
- `refactor/backend-runtime-portability-20260913`

`main` 未合并本轮重构；未执行生产部署、未升级远端 D1。

当前施工分支最近已提交并推送：

- `139daa2 test: guard portable backend core`
- `ef2e7ef refactor: define portable backend ports`
- `8228d76 refactor: add Cloudflare storage adapters`
- `c9d560b refactor: add portable sqlite database adapter`
- `9a7184e refactor: add filesystem object store adapter`
- `b5fe6a4 refactor: add runtime persistence factories`

此前性能优化、master data 重构和文档收敛均已包含在该分支历史中。

## 已完成的可移植后端基础

### 1. 架构门禁

`tests/repository-guards.test.mjs` 已增加门禁：

- `domain/`
- `application/`
- `ports/`

不得直接依赖 `D1Database`、`D1PreparedStatement`、`R2Bucket`、`Fetcher`、`ExecutionContext`、Wrangler 或 Cloudflare runtime 类型。

原则：依赖方向只能是业务核心 → Port；基础设施 adapter → Port。不得把 `DatabasePort` 变成“换名字的 D1 裸 SQL”后继续让业务层到处写平台 SQL。

### 2. Ports

已建立：

- `DatabasePort` / `TransactionPort`
- `ObjectStorePort`
- `JobQueuePort`
- `SchedulerPort`
- `ClockPort`
- `PersistencePorts`

### 3. Cloudflare adapters

已建立：

- `D1DatabaseAdapter`
- `R2ObjectStoreAdapter`
- `runtime/cloudflare/persistence.ts`

### 4. Node / 普通服务器 adapters

已建立：

- `SqliteDatabaseAdapter`，基于 Node `node:sqlite`
- `FilesystemObjectStoreAdapter`
- `runtime/node/persistence.ts`

Cloudflare runtime 与 Node runtime 使用独立 TypeScript 类型边界，不要为了省事把 Node types 全局混进 Worker runtime，也不要反过来让 Node runtime 依赖 Workers 类型。

Node 原生 ESM 对模块扩展名更严格；Node runtime 路径已使用可被 Node 直接加载的显式 `.ts` import，并通过单独 `tsconfig.node-runtime.json` 校验。

### 5. 契约测试

已增加：

- `tests/database-adapters.test.mjs`
- `tests/object-store-adapters.test.mjs`
- `tests/runtime-persistence.test.mjs`

已验证：

- D1 与 SQLite 对上层暴露一致的基础 query / run / atomic batch 语义。
- SQLite batch 失败会回滚。
- `node:sqlite` 的 null-prototype row 已在 adapter 边界转为普通对象。
- R2 与本地文件存储暴露一致对象存储语义。
- 文件系统 adapter 阻止绝对路径、`..` 等目录穿越。
- Cloudflare 与 Node persistence factory 暴露相同能力。

## 当前未提交工作区：不要覆盖

在 `b5fe6a4` 之后已经完成第一块真实业务迁移，但尚未 commit/push。开始工作必须先运行：

```sh
git status --short --branch
git diff -- apps/api/src/p5.ts tests/repository-guards.test.mjs
git diff --no-index /dev/null apps/api/src/application/attachment-content.ts || true
```

当前预期未提交文件：

- `M apps/api/src/p5.ts`
- `M tests/repository-guards.test.mjs`
- `?? apps/api/src/application/attachment-content.ts`

这些修改的目标是：**P5 附件二进制内容不再直接操作 `c.env.FILES` / R2 binding，而是通过 `ObjectStorePort`。**

已完成实现：

- 新增 `application/attachment-content.ts`
  - `saveAttachmentContent()`
  - `loadAttachmentContent()`
  - `deleteAttachmentContent()`
- `p5.ts` 上传、元数据写入失败清理、下载均经 `ObjectStorePort`。
- 当前数据库仍保留列名 `r2_key`，这是现有 schema 兼容字段；不要为了字段命名在同一个 commit 顺手做 migration。

该未提交修改已经验证：

- `tests/repository-guards.test.mjs`：15/15 PASS。
- `tests/p5-delivery.test.mjs`：10/10 PASS，包括附件权限及上传下载回归。
- `npm run typecheck --workspace @tpm/api`：Cloudflare + Node 两个 runtime 均 PASS。

下一位 AI 第一件事：重新快速复核上述测试，确认工作区没有额外陌生修改，然后把这三处作为独立小提交提交并 push，例如：

`refactor: route attachment content through object store port`

不要把下一步 AttachmentRepository 一起塞进这个 commit。

## 下一步执行顺序

### A. 提交当前附件内容迁移

先复核专项测试，然后独立 commit + push。

### B. AttachmentRepository

下一独立 commit 只迁附件元数据访问：

- 定义业务语义接口，不让 `p5.ts` 继续直接拼附件元数据 SQL。
- D1/SQLite 共享同一 repository contract。
- 不要同时迁其他 P5 实施/结算逻辑。
- 测试先行；保留现有权限、幂等、事务失败清理语义。

### C. 继续按业务块迁移

优先选择边界清晰的模块，一块一 commit。建议顺序：

1. 附件元数据 repository。
2. Session/Auth 数据访问。
3. 基础台账 / Demand repository。
4. Reserve / Project repository。
5. P5/P8 执行业务 repository。
6. P6 backup / notification 后台任务。

不要一次重写整个 `p5.ts`、`p8.ts` 或 `app.ts`。

### D. Free 配额设计继续落实

当前架构目标：

- 普通同步 API D1 query 目标 `<= 5`，硬目标 `<= 10`。
- 禁止输入 N 增长导致 DB query 数线性增长。
- D1 单 SQL 绑定参数上限按 100 设计；有额外固定 bind 时不能再塞满 100 个 ID。
- Excel 保持浏览器 Web Worker 解析，禁止重新搬到 Cloudflare Worker。
- 大批量操作后续进入统一 Job + chunk 模型。
- `JobQueuePort` 已定义，但 Cloudflare Queue / Node DB job adapter 尚未实现。

后续复杂任务计划：HTTP 只创建 job，固定小 chunk 可幂等重试；Cloudflare 可用 Queue adapter，普通服务器用 DB-backed worker。不要让业务层 import Cloudflare Queue。

### E. Node 第二运行时最终验收

最终必须做到：

- 同一业务 API/application 层可由 Cloudflare runtime 和 Node runtime 装配。
- Node 运行时可以使用 SQLite + Filesystem 完成完整 E2E，而不是只有 adapter 单测。
- 再增加应用级 export/import，实际做 D1 → Node/SQLite 迁移演练。

## 测试基线

在本轮后端可移植性改造开始前，合并后的完整门禁曾通过：

- Node：146/146 PASS
- Vue：64/64 PASS
- TypeScript：PASS
- Vite production build：PASS
- Worker dry-run：PASS
- `npm run check`：约 62 秒

可移植性各小提交之后已经逐项跑专项契约测试和双 runtime typecheck，但**在当前附件未提交修改之后还没有重新跑一次完整 `npm run check`**。合并 `main` 前必须完整跑一次，并以实际结果为准更新文档。

## Git 工作纪律

- 不使用 `git reset`、`git clean`。
- 不覆盖任何未提交修改。
- 测试先于缺陷修复/高风险重构。
- 每个逻辑点单独 commit，验证通过后及时 push。
- 完成并进入后继提交链的临时分支及时删除；当前只保留 `main + 当前施工分支`。
- 不重新创建一堆阶段性 WIP 分支。
- 未经用户单独授权：不得部署、不得升级远端 D1、不得合并 `main`、不得创建收费资源。

## 当前明确禁止

- 不回退系统自维护 username/password 认证。
- 不恢复 Cloudflare Access / 邮箱登录。
- 不把 Argon2/PBKDF2 慢 KDF 放回服务端 Worker。
- 不修改已冻结的 `0009`–`0012` migration。
- 不为了“可迁移”现在就强行引入 PostgreSQL、Redis、Kafka 等复杂依赖。
- 不把所有业务 SQL 一次性机械替换为 `DatabasePort`；应建立语义 Repository/Application 边界。
- 不把本地 wall-clock 耗时误称为 Cloudflare CPU 时间；真实 10ms CPU 是否满足最终仍需云端指标验收。
