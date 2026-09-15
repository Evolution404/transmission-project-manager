# AI 交接说明

## 当前施工状态

- 仓库：`Evolution404/transmission-project-manager`
- 默认分支：`main`
- 当前施工分支：`refactor/master-data-ux-hardening-20260915`
- 当前最新已验证代码基线：`106c1f7`（`refactor(api): isolate project delivery routes`）；其后的交接文档提交不改变该代码基线。
- 最近完整门禁基线：在 `106c1f7` 提交前同一代码状态执行 `npm run check`，Node **278/278 PASS**、Web/Vitest **114/114 PASS**，Cloudflare/Node/Web/shared TypeScript、Web production build、Worker dry-run、Node + SQLite + Filesystem 第二运行时均 PASS。
- 当前工作区**不是 clean**：保留尚未提交的 `apps/api/src/analysis-operations.ts` 与新增 `apps/api/src/analysis-calculations.ts`。这是正在进行的分析模块结构拆分 WIP，**尚未完成 typecheck / 回归 / 完整门禁，不得当作已完成成果**。
- 当前任务：继续纯结构性技术债清理，优先完成分析模块拆分；保持业务行为、接口 URL、权限、幂等、版本锁和事务边界不变。生产 schema 迁移仍另行设计、另行授权。
- 禁止 `reset/clean`，不要覆盖当前工作区；未经用户明确授权，不合并 `main`、不执行 production migration/reconciliation、不触发 Production release。

长期业务事实只看 `BUSINESS_BASELINE.md`、`DESIGN.md`、`DATA_MODEL.md`；测试门禁看 `TESTING.md`；生产步骤看 `PRODUCTION_RUNBOOK.md`。已完成阶段过程通过 Git 历史追溯，不再维护重复 WIP 文档。

## 本轮已完成并提交的结构重构

在原 M6 基础台账收口之后，继续完成了一轮后端职责拆分。以下提交均已 push 到当前施工分支：

- `dc81789`：统一 HTTP 幂等 mutation helper；
- `05f33a3`：从顶层 `app.ts` 拆出认证与管理路由，`app.ts` 收缩为装配根；
- `3dee0c9`：统一 API error response helper；
- `92e03c5`：把需求/项目执行聚合只读查询拆到 `project-execution-query.ts`，公共执行校验/权限辅助集中到 `project-execution-shared.ts`；
- `c3247a2`：把任务物资供应、实施、结算、结算撤销拆到 `project-task-progress.ts`；
- `106c1f7`：把项目级出库和执行任务定义/列表拆到 `project-delivery.ts`。

拆分后 `project-execution.ts` 从约 850 行收缩到约 **334 行**，当前只承担“需求补充 + 储备项目生命周期”；出库/任务定义、任务进度和聚合查询分别独立，并已有 repository/static guard 防止职责重新混回。

## 当前未提交 WIP：分析模块拆分

审计发现 `analysis-operations.ts` 同时混合三类职责：

1. 分析规则 / 计划 / 月报 / 里程碑及其计算；
2. 通知联系人 / 告警 / outbox / 通知投递；
3. 逻辑备份 / 校验 / 保留策略 / 系统定时任务。

当前正在做第一步：把纯分析计算从 HTTP/运维代码中抽到 `analysis-calculations.ts`。工作区已有：

- `apps/api/src/analysis-calculations.ts`：抽取 `currentRule`、框架进度、项目差距、里程碑到期判断、月份末日、BigInt 安全转换等纯计算/查询编排；
- `apps/api/src/analysis-operations.ts`：已开始改为导入上述计算函数，并删除原文件内对应重复实现。

**重要：这一 WIP 尚未验证。** 前一次抽取过程中已经主动发现并纠正过“用近似重写替代原算法”的风险。后续必须逐项对照原实现，尤其保持：

- 比例计算使用原 BigInt 四舍五入口径；
- `quarterStatus` 仍为 `upcoming / in_progress / ended`；
- `businessYear`、`annualTargetFen`、默认/自定义月度计划、`planSource` 等字段来源完全保持原 Repository 逻辑；
- ratio / gap 两种 lagging 边界比较符号保持原语义；
- 里程碑 month/day/unknown 精度和提醒边界不变。

完成该前置后，再拆：

1. 通知/告警 runtime 与 HTTP routes；
2. 备份/系统任务 runtime 与 HTTP routes；
3. 最后保留 `analysis-operations.ts` 只承载分析/计划/月报/里程碑 HTTP 层。

每一步先跑定向测试和 repository guards，完整 `npm run check` 全绿后独立小 commit + push；不要把当前两个 WIP 文件与无关修改混合提交。

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

随后结构重构最新完整门禁基线（`106c1f7` 对应代码状态）已提升为：

- Node：**278/278 PASS**；
- Web/Vitest：**114/114 PASS（19 个测试文件）**；
- Cloudflare API、Node runtime、Web、shared TypeScript：PASS；
- Web production build：PASS；
- Worker `wrangler deploy --dry-run`：PASS；
- Node + SQLite + Filesystem 第二运行时：PASS。

注意：当前未提交的 `analysis-calculations.ts` WIP **不包含在上述 278/278 结论中**。

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

1. 先保护现有未提交 WIP，运行 `git diff --check`，逐项对照 `analysis-calculations.ts` 与拆分前算法，修正任何语义漂移。
2. 先跑 `apps/api` typecheck + 分析/P6/repository guard 定向测试；通过后继续把通知/告警、备份/系统任务从 `analysis-operations.ts` 拆出。
3. 每个边界独立跑回归、独立小 commit、及时 push；最终跑完整 `npm run check`，并更新本文件的 HEAD/门禁数字。
4. 完成分析模块后，再审 `reserve-planning.ts`、`demand-import.ts`、`finance.ts`、`project-lifecycle.ts`、`MasterDataView.vue`、`packages/shared/src/index.ts`，只按真实职责边界拆，不为行数机械切文件。
5. 不合并 `main`、不发布生产，除非用户随后明确授权；生产 schema 迁移必须单独设计和审核。

## 必须继续保持的工程约束

- 当前开发阶段数据库只允许 `0001_initial_schema.sql` 一个基线；无明确兼容需求不得新增 `0002+`。
- 业务认证保持系统自维护 username/password；浏览器 Web Worker Argon2id，服务端 HMAC verifier + HttpOnly 会话。
- 业务核心保持 Database/ObjectStore 等 Port 边界，不重新绑定 D1/R2/Notion。
- Cloudflare Free 为部署基线，同时保持 Node + SQLite + Filesystem 第二运行时。
- Excel 解析继续在浏览器 Web Worker；同步 API 避免 N+1、超大参数和 Worker CPU 长任务。
- Secret 只存在受控本地 `.env` / GitHub Environment / Worker Secret，不进入仓库、PR、日志或普通文档。
