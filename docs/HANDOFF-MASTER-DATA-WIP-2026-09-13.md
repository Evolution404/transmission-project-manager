# 2026-09-13 基础台账对象化重构 WIP 交接

项目：`Evolution404/transmission-project-manager`
本地：`/Users/zhangyuxi/Desktop/项目管理`
线上稳定主线：`main`
当前 main HEAD：`a9f1908ffdf64a07b520a4e89b1c50a79f8531a8`

## 用户最终决定

当前历史业务数据可以删除，不需要兼容旧业务数据。账号、成员、权限等系统数据保留。

正式主模型必须改为：

```text
voltage_levels
  1 -> N transmission_lines
        1 -> N transmission_towers

demands
  -> voltage_level_id
  -> line_id
  -> location_type
  -> start_tower_id / end_tower_id
  -> demand_materials 0..N
```

所有新增业务中的电压等级必须来自后台字典下拉；线路、杆塔必须来自台账对象并级联选择。现有 `voltage_raw / line_name / section_text` 如继续保留，只能作为对象自动生成的显示快照，不能再由用户自由输入成为正式事实。

## 已独立完成并推送 main 的登录修复

提交：`a9f1908 fix: improve password manager login semantics`

已为真实原生用户名/密码 input 增加稳定 `id/name/autocomplete` 语义，并改成标准 form submit。验证：Web typecheck PASS、LoginView 5/5 PASS、Vite build PASS。

## 当前本机 WIP

禁止 reset / clean / 覆盖这些改动。主要文件：

- `apps/api/migrations/0009_master_grid_assets.sql`
- `apps/api/migrations/0010_master_grid_relations.sql`
- `apps/api/src/p9.ts`
- `apps/api/src/p2.ts`
- `apps/api/src/app.ts`
- `apps/api/src/schema.ts`
- `packages/shared/src/index.ts`
- `apps/web/src/views/MasterDataView.vue`
- `apps/web/src/views/DemandsView.vue`
- `apps/web/src/App.vue`
- `apps/web/src/router.ts`
- `apps/web/tests/DemandsView.test.ts`
- `tests/final-business-flow.test.mjs`
- `tests/p2-import.test.mjs`

## 已实现

`0009` 创建 `voltage_levels`；`0010` 创建 `transmission_lines`、`transmission_towers`，并给 demands 增加对象关联字段。默认电压等级已包含 35/110/220/500/1000kV、±500/±800/±1100kV。当前 schema readiness 要求 `0010_master_grid_relations.sql`。

`p9.ts` 已实现 master voltage/line/tower 的 GET/POST/PATCH，以及对象化 `POST /api/demands`。支持 `whole_line / tower / tower_range`，并校验线路所属电压、杆塔所属线路和杆塔顺序。

已新增 `/master-data` 基础台账页面，包含电压等级、线路、杆塔维护；写权限仅 admin。

`DemandsView.vue` 正在切换为“电压等级 -> 线路 -> 范围类型 -> 杆塔”的级联选择，初始物资继续支持 0..N 任意条。

`p2.ts` 已开始把 Excel 中的电压/线路/杆段映射到基础台账对象；不存在的对象应阻断正式发布，不能再把自由文本直接写进正式需求。

## 当前测试状态

最近实际运行：
- `tests/final-business-flow.test.mjs`：7/7 PASS
- `tests/p2-import.test.mjs`：13/13 PASS
- `LoginView.test.ts`：5/5 PASS
- Web typecheck：PASS

完整门禁尚未跑完，因为 WIP 未收口。

## 迁移注意事项

开发 migration watcher 存在一个已确认的边界：新建 `0009` 时，监听器在文件还没写完就执行并记录为已应用，后续继续编辑同一个 migration 不会再次执行。

当前处理方式已经固定为：
- `0009` 冻结为当时实际已应用的内容，仅负责创建 `voltage_levels`；
- 其余线路、杆塔、需求对象关系和默认电压等级放到 `0010`；
- 本地 D1 当前已经应用到 `0010`。

后续严禁再修改已应用的 0009/0010 内容。必须修 `scripts/dev/api-dev.mjs` watcher：只对稳定完成的新 migration 执行；已存在 migration 内容变化应显式报错。随后更新 `tests/migrations.lock.json` 的 0009/0010 checksum，并补对应 repository guard。

## 下一步顺序

1. 完整审查 `p9.ts` 的幂等、版本冲突、停用对象、唯一性和关联校验。
2. 补 master data 后端集成测试：admin 写权限、重复名称/编码、停用状态、线路-电压、杆塔-线路、杆塔区间顺序、三种 location type。
3. 收口 P2 Excel：未知电压/线路/杆塔必须 error；只有映射到正式台账对象的行才能发布。
4. 全项目搜索所有电压等级新增/编辑入口，全部改为字典下拉，禁止自由文本。
5. P6 备份加入 `voltage_levels/transmission_lines/transmission_towers`，同步 restore 顺序。
6. 修 migration watcher，更新 migration checksum lock。
7. 更新 `DATA_MODEL / DESIGN / TESTING / AI_HANDOFF / NEXT_AI` 最终文档。
8. 因历史业务数据允许删除，正式切换前清理验收环境旧业务数据，但保留账号、成员、权限等系统数据；清理要按 FK 顺序设计。
9. 全部门禁绿后，先升级远端 D1 到 0010，再合并/发布代码，最后验证 `https://project.980923.xyz/api/health` 的 `schema.ready=true`。

## 线上状态

线上地址：`https://project.980923.xyz`。

线上稳定代码目前只到 main 的登录修复 `a9f1908`；基础台账 WIP 尚未上线。WIP 未完成前不要升级线上 D1 到 0010，也不要把半成品直接 merge main。

继续遵守既有最终业务基线：抽象需求 + 0..N 需求物资、项目需求来源与项目物资分离、项目级一次出库、多执行任务、供应/实施/结算三线并行、四状态反馈、框架/协议/预算发生线不变；不得恢复旧 `demand_allocations / release_lines` 作为新功能主路径。
