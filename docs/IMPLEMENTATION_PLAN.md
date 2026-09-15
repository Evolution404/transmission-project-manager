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
| 基础台账 M6 | 物理杆塔/线路节点分离、同塔 N 回、配置对象、通用自定义字段 | **当前施工，功能已落地，待完整门禁/提交/远端 CI** |
| 生产 schema 升级 | 既有生产 D1 → 当前 M6 schema 的显式数据迁移 | **未设计/未授权，当前发布阻断项** |
| P7 | 真实业务、恢复、性能、网络和运维移交 | 继续按真实环境逐项验收 |

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

本轮定向结果：基础台账 API **25/25 PASS**；相关 Web **30/30 PASS**。最终完整 `npm run check` 已 PASS：Node **270/270**、Web **114/114（19 文件）**，Cloudflare/Node/Web/shared TypeScript、Web production build、Worker dry-run、Node+SQLite+Filesystem 第二运行时和全部静态门禁均 PASS。

## 5. 技术债清理范围

- 删除只适用于旧 `transmission_towers` schema 的一次性生产 reconciliation 脚本及测试。
- 删除已完成且内容已并入长期规范的阶段性 `MASTER_DATA_REDESIGN_PLAN.md`。
- 更新备份/恢复覆盖，使自定义字段定义、版本、真值和索引都进入 manifest/恢复表序列。
- 清理生产源码和文档中的旧 `transmission_towers`、`start_tower_id/end_tower_id`、物理塔 `custom_values_json` schema 残留；负向 migration 断言除外。
- `p9.ts`、`MasterDataView.vue`、`packages/shared/src/index.ts` 仍偏大；本轮优先完成最终领域边界后再做无行为变化拆分，不在功能未收口时做混合巨型重构。

## 6. 生产发布阻断

本轮修改了开发阶段唯一 `0001_initial_schema.sql`，但既有 production D1 已运行过早期同名 `0001`。因此代码通过并不代表可以发布。

在生产发布前必须另行完成：

1. 盘点当前 production D1 的真实 schema 和数据量；
2. 停写并完成可恢复备份/Time Travel 证据；
3. 设计旧 `transmission_towers` → `physical_towers + line_tower_positions` 的确定性映射；
4. 迁移 demand 端点到 `*_tower_position_id`；
5. 建立配置/自定义字段新表，不丢既有数据；
6. 外键检查、数量/业务对账、应用 smoke；
7. 明确失败回退步骤；
8. 用户审核并明确授权后，才通过受控云端流程执行。

禁止直接重放当前 `0001`，也禁止恢复旧 reconcile 脚本临时顶上。

## 7. 本轮完成标准

1. 目标行为有自动测试；
2. 定向与完整 `npm run check` 全绿；
3. migration lock、共享类型、备份表清单和长期文档同步；
4. 旧模型/死代码/重复文档完成扫描并合理删除；
5. 修改拆成可审查的小 commit 并 push 当前施工分支；
6. PR 远端 CI 全绿；
7. 工作区 clean；
8. 不把“代码收口”误写为“生产已升级”；生产迁移和发布另行授权。
