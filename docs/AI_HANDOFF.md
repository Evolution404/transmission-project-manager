# AI 交接说明

## 当前施工状态

- 仓库：`Evolution404/transmission-project-manager`
- 默认分支：`main`
- 当前施工分支：`refactor/master-data-ux-hardening-20260915`
- 当前最新已验证代码基线：`8c8f7ef`（`refactor(api): isolate backup and system tasks`）；其后的交接文档提交不改变该代码基线。
- 最近完整门禁基线：在 `8c8f7ef` 对应代码状态执行 `npm run check`，Node **279/279 PASS**、Web/Vitest **114/114 PASS（19 个测试文件）**，Cloudflare/Node/Web/shared TypeScript、Web production build、Worker dry-run、Node + SQLite + Filesystem 第二运行时均 PASS。
- 当前分析模块结构拆分已完成并提交，原 `analysis-operations.ts` / `analysis-calculations.ts` WIP 已收口；本轮文档提交后工作区应保持 clean。
- 当前任务：继续纯结构性技术债清理时，从 `reserve-planning.ts`、`demand-import.ts`、`finance.ts`、`project-lifecycle.ts`、`MasterDataView.vue`、`packages/shared/src/index.ts` 中按真实职责耦合收益选择下一处，保持业务行为、接口 URL、权限、幂等、版本锁和事务边界不变。生产 schema 迁移仍另行设计、另行授权。
- 禁止 `reset/clean`，不要覆盖当前工作区；未经用户明确授权，不合并 `main`、不执行 production migration/reconciliation、不触发 Production release。

长期业务事实只看 `BUSINESS_BASELINE.md`、`DESIGN.md`、`DATA_MODEL.md`；测试门禁看 `TESTING.md`；生产步骤看 `PRODUCTION_RUNBOOK.md`。已完成阶段过程通过 Git 历史追溯，不再维护重复 WIP 文档。

## 本轮已完成并提交的结构重构

在原 M6 基础台账收口之后，继续完成了一轮后端职责拆分。以下提交均已 push 到当前施工分支：

- `dc81789`：统一 HTTP 幂等 mutation helper；
- `05f33a3`：从顶层 `app.ts` 拆出认证与管理路由，`app.ts` 收缩为装配根；
- `3dee0c9`：统一 API error response helper；
- `92e03c5`：把需求/项目执行聚合只读查询拆到 `project-execution-query.ts`，公共执行校验/权限辅助集中到 `project-execution-shared.ts`；
- `c3247a2`：把任务物资供应、实施、结算、结算撤销拆到 `project-task-progress.ts`；
- `106c1f7`：把项目级出库和执行任务定义/列表拆到 `project-delivery.ts`；
- `43696aa`：逐项核对原算法后，把分析纯计算抽到 `analysis-calculations.ts`；
- `a8e3514`：把通知联系人、告警评估、outbox 与通知投递拆到 `notification-operations.ts`；
- `8c8f7ef`：把逻辑备份拆到 `backup-operations.ts`，把定时调度与系统任务 HTTP 拆到 `system-tasks.ts`。

拆分后 `project-execution.ts` 从约 850 行收缩到约 **334 行**，当前只承担“需求补充 + 储备项目生命周期”；出库/任务定义、任务进度和聚合查询分别独立，并已有 repository/static guard 防止职责重新混回。

## 分析模块拆分已完成

审计发现 `analysis-operations.ts` 同时混合三类职责：

1. 分析规则 / 计划 / 月报 / 里程碑及其计算；
2. 通知联系人 / 告警 / outbox / 通知投递；
3. 逻辑备份 / 校验 / 保留策略 / 系统定时任务。

本轮先逐项对照拆分前 `analysis-operations.ts`，确认计算函数保持原实现语义，再做后续职责迁移。已确认并由回归覆盖：

- 比例计算使用原 BigInt 四舍五入口径；
- `quarterStatus` 仍为 `upcoming / in_progress / ended`；
- `businessYear`、`annualTargetFen`、默认/自定义月度计划、`planSource` 等字段来源完全保持原 Repository 逻辑；
- ratio / gap 两种 lagging 边界比较符号保持原语义；
- 里程碑 month/day/unknown 精度和提醒边界不变。

当前职责边界为：

1. `analysis-calculations.ts`：分析规则读取、框架进度、项目差距、里程碑到期、月份末日和 BigInt 安全转换等计算/查询编排；
2. `analysis-operations.ts`：仅保留分析看板、储备分析、规则、计划、框架进度、项目差距、月报和里程碑 HTTP 层，约 **299 行**；
3. `notification-operations.ts`：通知联系人、告警评估、outbox 租约/结果回写和通知投递；
4. `backup-operations.ts`：逻辑备份创建、分块推进、完整性校验、保留策略以及下一待处理备份步进；
5. `system-tasks.ts`：Asia/Shanghai 定时调度编排和 `/system/tasks/run`，只调用分析/通知/备份模块，不直接触达备份仓储。

repository/static guard 已新增职责回混门禁；通知、备份、系统任务迁移前后接口 URL、权限、幂等键、版本/租约约束、审计写入和事务边界均保持不变。

## M6 已完成业务改动

### 1. 物理杆塔与线路杆塔节点分离

当前模型已从“线路直接拥有一基杆塔”收口为：

```text
physical_towers
    ↑ 1:N
line_tower_positions
    N:1 → transmission_lines
```

- `physical_towers` 表示真实物理杆塔资产；包含资产编号、杆塔类型、运维班组、启停、版本。
- `line_tower_positions` 表示某条线路上的稳定节点/当前杆塔编号、排序、同塔位置标签；同一物理塔可以被多个线路节点引用，支持双回、三回、四回及更多同塔线路。
- 需求位置已使用 `start_tower_position_id / end_tower_position_id`，不再把物理塔 ID 当线路位置 ID。
- 已有线路节点可通过专用 `POST /api/master/towers/:id/rebind-physical` 重新关联到另一个物理塔；普通 PATCH 不允许偷偷改变同塔关系。
- 新增线路节点默认创建独立物理塔；批量导入不按编号猜同塔关系。同塔必须由用户显式关联。

### 2. 配置对象与通用自定义字段

管理员配置已扩展为：电压等级、班组、杆塔类型、自定义字段定义。

自定义字段实现使用：

- `custom_field_definitions`：字段定义；
- `custom_field_value_sets`：对象级自定义字段集合版本，独立于业务对象本体版本；
- `custom_field_values`：业务真值；
- `custom_field_index`：文本/整数/日期/布尔等标量索引；
- `custom_field_multi_select_index`：多选项倒排索引。

当前支持定义到 `physical_tower`、`transmission_line`、`line_tower_position`、`demand`、`project`、`project_task`。字段键、对象类型、数据类型创建后不可改变；语义变化时新建字段并停用旧字段。已被业务值引用的字段定义不能直接删除，避免级联丢历史数据。

### 3. 管理界面

- “台账设置”扩展为电压等级 / 班组 / 杆塔类型 / 自定义字段四类配置。
- 线路杆塔节点操作明确拆分为：编辑线路节点属性、编辑物理杆塔、重新关联物理杆塔、自定义字段、杆塔更名、编号历史。
- 物理塔属性与自定义字段值分别使用独立版本保存，避免一次请求混合两个并发域。
- 保留上一轮已完成的线路中心 UI、手机杆塔卡片、触屏上移/下移、危险删除二次确认和业务时区历史展示。

### 4. 技术债清理

- 旧 `ops/production/master-data-schema-reconcile.sql` 已删除；它只能重建旧 `transmission_towers` 模型，继续保留存在误用风险。
- 对应 `tests/schema-reconcile.test.mjs` 已删除。
- `PRODUCTION_RUNBOOK.md` 已改为 fail-closed：当前开发基线一旦和既有生产 D1 不一致，必须先单独设计并审核显式生产迁移；不得把改写后的同名 `0001` 或已删除的一次性 reconcile 脚本直接用于生产。
- 已完成阶段性的 `MASTER_DATA_REDESIGN_PLAN.md` 已删除，内容并入三份长期业务/数据模型文档和本轮审计文档。
- 备份表集合已加入自定义字段定义、版本集合、业务值和两类索引；P6 恢复夹具已开始同步新模型。

## 当前验证结果

本轮已通过：

- `apps/api` TypeScript：PASS；
- `apps/web` TypeScript：PASS；
- migration + master-data repository 定向：PASS；
- 基础台账 API：**25/25 PASS**；
- MasterData/Demands/tower-import Web 定向：**30/30 PASS**。

M6 最终完整 `npm run check` 已 PASS：

- Node：**270/270 PASS**；
- Web/Vitest：**114/114 PASS（19 个测试文件）**；
- Cloudflare API、Node runtime、Web、shared TypeScript：PASS；
- Web production build：PASS；
- Worker `wrangler deploy --dry-run`：PASS；
- Node + SQLite + Filesystem 第二运行时：PASS；
- 单一 `0001_initial_schema.sql` checksum / migration guard、repository/static guards：PASS。

随后分析模块结构拆分最新完整门禁基线（`8c8f7ef` 对应代码状态）已提升为：

- Node：**279/279 PASS**；
- Web/Vitest：**114/114 PASS（19 个测试文件）**；
- Cloudflare API、Node runtime、Web、shared TypeScript：PASS；
- Web production build：PASS；
- Worker `wrangler deploy --dry-run`：PASS；
- Node + SQLite + Filesystem 第二运行时：PASS。

分析拆分定向回归还单独通过 API 双运行时 typecheck，以及分析/P6、通知仓储、备份仓储、repository guards 共 **53/53 PASS**。

## 当前生产边界

生产环境在本轮开始前已经有可用的上一版本；当前施工分支尚未合并或发布。

本轮修改了唯一开发基线 `apps/api/migrations/0001_initial_schema.sql`，而生产 D1 之前已经执行过同名 `0001`。因此：

1. 不得把 Wrangler migration 文件名状态当成“生产 schema 已兼容”；
2. 不得直接对生产运行当前改写后的 `0001`；
3. 不得恢复已删除的旧 reconcile 脚本；
4. 合并/发布前必须另开生产数据迁移设计，明确旧生产 schema → 当前物理塔/线路节点/需求位置/自定义字段 schema 的数据映射、停写、备份、对账和回退；
5. 未经用户明确授权，只做本地代码、测试、文档和远端施工分支/PR，不操作正式 D1。

生产发布继续通过 GitHub `production` Environment 与受控 Cloudflare workflow；长期 Secret 和具体资源以当前受审 production config / GitHub Environment / Cloudflare 实际状态为准，不从历史文档猜测。

## 接下来执行顺序

1. 接手先确认分支仍为 `refactor/master-data-ux-hardening-20260915`、工作区 clean、HEAD 已包含本轮文档提交；禁止 `reset/clean` 覆盖他人修改。
2. 下一轮从 `reserve-planning.ts`、`demand-import.ts`、`finance.ts`、`project-lifecycle.ts`、`MasterDataView.vue`、`packages/shared/src/index.ts` 中按真实职责耦合收益继续审查，只在收益明确时拆分，不为行数机械切文件。
3. 继续测试先行；每个职责边界先加/调整 guard 或行为回归，再修改实现，小 commit、及时 push，最终完整 `npm run check`。
4. 不合并 `main`、不发布生产，除非用户随后明确授权；生产 schema 迁移必须单独设计和审核。

## 必须继续保持的工程约束

- 当前开发阶段数据库只允许 `0001_initial_schema.sql` 一个基线；无明确兼容需求不得新增 `0002+`。
- 业务认证保持系统自维护 username/password；浏览器 Web Worker Argon2id，服务端 HMAC verifier + HttpOnly 会话。
- 业务核心保持 Database/ObjectStore 等 Port 边界，不重新绑定 D1/R2/Notion。
- Cloudflare Free 为部署基线，同时保持 Node + SQLite + Filesystem 第二运行时。
- Excel 解析继续在浏览器 Web Worker；同步 API 避免 N+1、超大参数和 Worker CPU 长任务。
- Secret 只存在受控本地 `.env` / GitHub Environment / Worker Secret，不进入仓库、PR、日志或普通文档。
