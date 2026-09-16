# 实施计划与验收清单

版本：2026-09-15。长期业务事实见 `BUSINESS_BASELINE.md`，当前施工状态见 `AI_HANDOFF.md`。

## 1. 阶段总览

| 阶段 | 范围 | 当前状态 |
|---|---|---|
| P0 | 仓库、CI、基础架构、文档 | 已完成 |
| P1 / P1.2 | 系统自维护账号密码、权限、会话和成员管理 | 已完成 |
| P2 | 抽象需求、标准模板/Excel 导入、0..N 需求物资、物资字典 | 已完成 |
| P3 | 项目储备、需求来源、独立项目物资与修订历史 | 已完成 |
| P4 | 框架、协议、预算版本、预算发生与实际费用 | 已完成 |
| P5 | 项目级出库、多执行任务、供应/实施/结算三线、四状态回投 | 已完成 |
| P6 | 月报、分析、预警、年度事项、通知、对象存储逻辑备份 | 已完成 |
| 后端可移植化 | Database/ObjectStore 等 Ports；Cloudflare 与 Node 第二运行时 | 已完成 |
| 基础台账 M1–M5 | 线路中心 UI、编号规范化、更名历史、排序、大批导入 | 已完成并已在上一版本上线 |
| 基础台账 M6 | 物理杆塔/线路节点分离、同塔 N 回、配置对象、通用自定义字段 | **已合入 main 并发布生产** |
| 生产 schema 升级 | 既有生产 D1 → 当前 M6 schema | **已完成：按用户授权重建空 D1，仅保留 zhangsan 账号及原密码凭据，旧 D1 已删除** |
| P7 | 真实业务、恢复、性能、网络和运维移交 | 继续按真实环境逐项验收 |
| 全站 UI 重构 | 应用壳、项目/任务闭环、需求、资金、台账、分析、设置、认证视觉与全站验收 | **施工中**；项目/任务核心闭环、跨项目任务队列、原生控件硬门禁已落地，需求与资金正在迁移。当前长期 UI 规范统一维护在 `DESIGN.md` |

## 2. 当前业务主路径

```text
电压等级 → 线路 → 线路杆塔节点 ──→ 物理杆塔
                    ↓
               抽象需求
                    ↓
项目储备（需求来源 + 独立项目物资）
                    ↓
             一次项目级出库
                    ↓
              多个执行任务
                    ↓
      物资供应 / 实施 / 结算并行
                    ↓
          需求四状态与进度回投
```

线路节点与物理杆塔不是同一对象：一基物理塔可以关联多条线路节点；线路节点编号、更名历史、线路顺序和需求位置身份与物理资产属性分离。

## 3. M6 当前范围

### 数据模型

- `physical_towers`：真实物理杆塔资产。
- `line_tower_positions`：线路上的稳定位置/编号节点；通过 `physical_tower_id` 指向物理塔。
- `line_tower_position_no_history`：线路节点编号历史。
- `demands.start_tower_position_id / end_tower_position_id`：需求保存稳定线路位置节点，不保存物理塔 ID。
- 班组、杆塔类型为稳定配置对象。
- 自定义字段采用定义 + 值集合版本 + 真值 + 类型化索引，不为长尾属性持续加表列。

### API / 并发

- 普通线路节点 PATCH 不允许更名、跨线路、改顺序或隐式 rebind。
- 更名、顺序移动、物理塔 rebind 均走专用 API。
- 物理塔本体有自己的 `version`；自定义字段集合有独立 `custom_field_value_sets.version`。
- 配置 CRUD、自定义字段值写入继续使用幂等键、版本检查、原子 batch 和审计事件。
- 已使用字段定义不能直接删除；需要退出使用时停用。

### UI

- 台账设置：电压等级 / 班组 / 杆塔类型 / 自定义字段。
- 杆塔行：线路节点编辑、物理塔编辑、重新关联物理塔、自定义字段、更名/历史、删除明确分离。
- 新增/批量导入默认不猜同塔；用户显式选择已有物理塔或事后 rebind。

## 4. 当前门禁

完成本轮前必须同时通过：

- `git diff --check`；
- API/Node/Web TypeScript；
- 基础台账、需求导入、备份/恢复、migration 定向回归；
- Vue/Vitest 全量；
- Node tests 全量；
- Web production build；
- Worker `wrangler deploy --dry-run`；
- Node + SQLite + Filesystem 第二运行时；
- 单一 `0001_initial_schema.sql` checksum / migration guard；
- repository/static guards。

M6 基础台账定向结果：基础台账 API **25/25 PASS**；相关 Web **30/30 PASS**。M6 收口时完整 `npm run check` 为 Node **270/270**、Web **114/114（19 文件）**。

全站 UI 重构当前施工分支 `refactor/ui-redesign-20260916` 最近一次完整 `npm run check` 已 PASS：Node **295/295**、Web **135/135（25 文件）**，Cloudflare/Node/Web/shared TypeScript、Web production build、Worker dry-run、Node+SQLite+Filesystem 第二运行时和全部静态门禁均 PASS。

远端证据：PR #12 与后续 `main` CI 均 PASS；生产重建 run `34952233283`、正式 release run `34952547151`、旧 D1 删除 run `34953255900` 均 PASS。当前 production schema 已为当前唯一 `0001_initial_schema.sql` 基线。

## 5. 技术债清理范围

- 删除只适用于旧 `transmission_towers` schema 的一次性生产 reconciliation 脚本及测试。
- 删除已完成且内容已并入长期规范的阶段性 `MASTER_DATA_REDESIGN_PLAN.md`。
- 更新备份/恢复覆盖，使自定义字段定义、版本、真值和索引都进入 manifest/恢复表序列。
- 清理生产源码和文档中的旧 `transmission_towers`、`start_tower_id/end_tower_id`、物理塔 `custom_values_json` schema 残留；负向 migration 断言除外。
- 原阶段编号 API 模块已改为业务语义模块，并把台账配置、物理杆塔、结构化需求、输电网台账路由拆开。
- 后续已继续完成 HTTP/API 职责收口：顶层 `app.ts` 只做装配；幂等 helper 和 API error builder 已集中；项目执行域拆为“储备生命周期 / 项目交付 / 任务进度 / 聚合查询”四个清晰边界。
- `project-execution.ts` 已由约 850 行降至约 334 行；其职责回混已有 repository/static guard。
- `analysis-operations.ts` 的混合职责已经完成拆分：`analysis-calculations.ts` 承载纯分析计算/查询编排，`analysis-operations.ts` 仅保留分析/计划/月报/里程碑 HTTP，`notification-operations.ts` 承载通知/告警/outbox，`backup-operations.ts` 承载逻辑备份，`system-tasks.ts` 承载定时任务编排。最新已验证代码提交为 `8c8f7ef`。
- 分析计算抽取前已逐项对照旧实现并由测试锁定 BigInt 四舍五入、季度状态、默认/自定义计划、ratio/gap lagging 边界和里程碑提醒语义；分析/P6、通知仓储、备份仓储和 repository guards 定向合计 **53/53 PASS**。
- 当前最新完整门禁基线为 Node **293/293 PASS**、Web **114/114 PASS**，双运行时 typecheck、Web build、Worker dry-run 全绿。
- 后续候选热点仍包括 `reserve-planning.ts`、`demand-import.ts`、`finance.ts`、`project-lifecycle.ts`、`MasterDataView.vue`、`packages/shared/src/index.ts`；按职责耦合收益排序拆分，禁止仅按文件行数机械拆分。

## 6. 当前生产状态

- 2026-09-15 用户明确允许清空除 `zhangsan` 账号/密码外的生产数据，因此没有做旧业务数据的原位兼容迁移，而是创建全新 D1 并应用当前单一 `0001_initial_schema.sql`。
- 当前 production D1：`transmission-project-manager-production-20260915` / `913b6387-46b0-40c6-b0b1-11f070b99f08`。
- 新 D1 上业务数据为空，仅保留 `zhangsan` 账号及原密码验证数据；旧 D1 已在切换验收成功后删除。
- 生产 Notion 对象存储已通过 run `34953724187` 核对：active 对象索引为 0，没有应用可见的旧附件/备份对象需要清理；Notion FileUpload 物理删除能力仍以平台 API 为边界。
- Cloudflare Worker 已通过正式 `Production release` 发布，公网 health 与认证初始化状态通过复核。
- 以后若生产已经产生正式业务数据，默认走统一 `Production promote`：先只读评估并自动搬运结构兼容的数据；结构变化时在临时 SQLite 中转换到当前 `0001` 新模型并校验；无法确定性转换则在生产变更前停止并由用户决定。只有用户再次明确授权删除时才允许清空数据。
- 当前标准化发布重构只在施工分支完成并测试，**尚未合并 `main`、尚未再次触发生产发布**；不要把“流程代码已完成”写成“线上已切换到新流程”。

## 7. 本轮完成标准

1. 目标行为有自动测试；
2. 定向与完整 `npm run check` 全绿；
3. migration lock、共享类型、备份表清单和长期文档同步；
4. 旧模型/死代码/重复文档完成扫描并合理删除；
5. 修改拆成可审查的小 commit，并按当次任务约定 push 到施工分支或 `main`；
6. PR 远端 CI 全绿；
7. 工作区 clean；
8. 不把“代码收口”误写为“生产已升级”；生产迁移和发布另行授权。
