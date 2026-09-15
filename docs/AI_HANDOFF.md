# AI 交接说明

## 当前施工状态

- 仓库：`Evolution404/transmission-project-manager`
- 默认分支：`main`
- 当前分支：`main`；M6、后端职责拆分和分析模块拆分均已合入并发布生产。
- 最近完整代码门禁基线：Node **279/279 PASS**、Web/Vitest **114/114 PASS（19 个测试文件）**，Cloudflare/Node/Web/shared TypeScript、Web production build、Worker dry-run、Node + SQLite + Filesystem 第二运行时均 PASS；合入/生产切库期间的 `main` CI 也持续全绿。
- 2026-09-15 用户明确授权保留 `zhangsan` 账号及原密码凭据、清空其余生产数据并发布。生产 D1 已重建为当前单一 `0001_initial_schema.sql` 基线，只保留 `zhangsan`，旧 D1 已删除。
- 当前生产 D1：`transmission-project-manager-production-20260915`，UUID `913b6387-46b0-40c6-b0b1-11f070b99f08`；生产域名仍为 `project.980923.xyz`，对象存储仍为 Notion。
- 当前任务：后续继续纯结构性技术债清理时，从 `reserve-planning.ts`、`demand-import.ts`、`finance.ts`、`project-lifecycle.ts`、`MasterDataView.vue`、`packages/shared/src/index.ts` 中按真实职责耦合收益选择下一处，保持业务行为、接口 URL、权限、幂等、版本锁和事务边界不变。
- 禁止 `reset/clean`；后续任何新的生产数据清理、migration 或 release 仍需用户当次明确授权。

长期业务事实只看 `BUSINESS_BASELINE.md`、`DESIGN.md`、`DATA_MODEL.md`；测试门禁看 `TESTING.md`；生产步骤看 `PRODUCTION_RUNBOOK.md`。已完成阶段过程通过 Git 历史追溯，不再维护重复 WIP 文档。

## 本轮已完成并提交的结构重构

在原 M6 基础台账收口之后，继续完成了一轮后端职责拆分。以下提交最终均已合入 `main`：

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

## 当前生产状态

2026-09-15 已完成一次经用户明确授权的生产重建与发布：

1. `main@e288eda682c8982da814603135e203442b1b885f` 切换 production config 到新 D1；
2. 临时受控 GitHub Actions run `34952233283` 创建新 D1、应用当前唯一 `0001_initial_schema.sql`，仅搬运 `members` 数据后删除除 `zhangsan` 外的所有账号，并确认需求/项目/线路业务数据为 0；
3. `Production release` run `34952547151` 完整 PASS，正式 Worker publish、新 D1 binding、现有 Worker Secrets 和公网 health 校验均成功；
4. 独立公网复核 `/api/health` 为 `schema.ready=true`、`currentMigration=requiredMigration=0001_initial_schema.sql`，`/api/auth/status` 为 `initialized=true`，匿名受保护 API 返回 401；
5. 临时清理 run `34953255900` 在再次验证新 D1 后删除旧 D1 `32ab1d29-e720-41a1-a83f-11b579734a0e`；一次性 reset/delete workflow 随后从仓库删除。
6. 生产 Notion 对象存储清理核对 run `34953724187` PASS：专用 data source 中 `State=active` 的对象索引页原本即为 **0**，复核后仍为 0；没有应用可见的旧附件/备份对象残留。Notion FileUpload 历史物理删除仍受平台公开 API 能力限制。

本轮所有临时 destructive workflow 均在完成后从仓库删除，不作为日常运维入口保留。

生产现在不再存在“旧同名 0001 与 M6 schema 不一致”的发布阻断。后续生产发布仍统一走 GitHub `production` Environment 与受控 Cloudflare workflow；长期 Secret 和具体资源以当前受审 production config / GitHub Environment / Cloudflare 实际状态为准。

## 接下来执行顺序

1. 接手先确认分支为 `main`、工作区 clean、HEAD 已包含本轮生产重建/发布收尾文档；禁止 `reset/clean` 覆盖他人修改。
2. 下一轮从 `reserve-planning.ts`、`demand-import.ts`、`finance.ts`、`project-lifecycle.ts`、`MasterDataView.vue`、`packages/shared/src/index.ts` 中按真实职责耦合收益继续审查，只在收益明确时拆分，不为行数机械切文件。
3. 继续测试先行；每个职责边界先加/调整 guard 或行为回归，再修改实现，小 commit、及时 push，最终完整 `npm run check`。
4. 新一轮生产变更仍需用户当次明确授权；不要因为本轮已经重建过 D1 就把后续 destructive reset 当作常规发布步骤。

## 必须继续保持的工程约束

- 当前开发阶段数据库只允许 `0001_initial_schema.sql` 一个基线；无明确兼容需求不得新增 `0002+`。
- 业务认证保持系统自维护 username/password；浏览器 Web Worker Argon2id，服务端 HMAC verifier + HttpOnly 会话。
- 业务核心保持 Database/ObjectStore 等 Port 边界，不重新绑定 D1/R2/Notion。
- Cloudflare Free 为部署基线，同时保持 Node + SQLite + Filesystem 第二运行时。
- Excel 解析继续在浏览器 Web Worker；同步 API 避免 N+1、超大参数和 Worker CPU 长任务。
- Secret 只存在受控本地 `.env` / GitHub Environment / Worker Secret，不进入仓库、PR、日志或普通文档。
