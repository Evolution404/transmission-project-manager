# AI 交接说明

## 当前基线

项目：`Evolution404/transmission-project-manager`
本地工作区：`/Users/zhangyuxi/Desktop/项目管理`

2026-09-13 已完成“电压等级 → 线路 → 杆塔 → 需求定位”基础台账对象化重构。功能验收分支：`wip/master-data-refactor-20260913`，已推送基线提交 `484cbaf`。文档审核已在独立分支 `chore/docs-audit-20260913` 完成，基于该已验证功能提交，只整理当前规范/运行手册，不混入新的业务实现。

当前业务主线和不能回退的关系见 `BUSINESS_BASELINE.md`。不要再从历史 WIP/阶段交接推导业务模型。

## 本轮基础台账重构已完成

### 数据库

- `VoltageLevel 1:N TransmissionLine 1:N TransmissionTower` 已落地。
- 默认电压等级包括 35kV、110kV、220kV、500kV、1000kV、±500kV、±800kV、±1100kV。
- `demands` 正式保存 `voltage_level_id`、`line_id`、`location_type`、`start_tower_id`、`end_tower_id`。
- `location_type` 仅允许 `whole_line / tower / tower_range`。
- 已应用迁移冻结到 `0012_master_data_write_guards.sql`；`0009`–`0012` 后续都只能追加新迁移，禁止回改。
- 被需求引用的线路不能换电压等级；线路存在需求后，整条线路上的杆塔身份/顺序/删除采用保守保护，包含区段内部杆塔。
- 未引用对象可删除；已引用对象只能停用。停用对象继续支持历史显示，新业务不可选择。

### API / 导入

- 基础台账写接口仅管理员可用，统一幂等键、版本守卫、原子审计和父级校验。
- 杆塔支持 1–20 行批量新增/维护；未引用杆塔可以在同一事务中交换顺序。
- 线路和杆塔列表按父级过滤并使用 cursor 分页，单页最大 100。
- 手工需求统一使用结构化 `POST /api/demands`，不再存在正式自由文本电压/线路创建入口。
- Excel 保留可读文字输入，但 validate/publish 都必须解析到已存在且启用的台账对象；未知或停用对象阻断发布，禁止自动创建线路/杆塔。
- Excel 杆段优先匹配完整杆塔号，再尝试拆分区段，因此杆塔号本身可包含连字符。
- 手工需求的标准物资校验/写入已改为集合查询和集合事务写入，避免物资条数线性放大 D1 invocation 查询次数。

### 前端

- `/master-data` 桌面端为左电压、中线路、右杆塔的三级 master-detail；移动端逐级进入并可返回。
- 支持电压等级、线路、杆塔启停，未引用删除，单塔新增和批量粘贴维护。
- 线路/杆塔只按选中父级加载并支持“加载更多”，不在页面初始化时全量加载。
- 手工需求为“电压等级 → 线路 → 位置类型 → 杆塔”级联选择，下游选择在父级变化时清空。
- 停用对象不出现在新业务可选项中。

### 开发 migration watcher

- 启动前对 migration 文件和 `tests/migrations.lock.json` 做 checksum 稳定检查。
- 实际执行的是临时目录中的不可变 migration 快照。
- 本地保存已执行 migration checksum ledger；已执行文件修改/删除会显式报错。
- SQL 和 checksum lock 都会触发检查。
- 已修复 `wrangler --json` stdout 被 Node stderr warning 污染导致 JSON 解析失败的问题。
- 已在本机真实重启验证：启动器发现并应用缺失的 `0012`，随后 `/api/health` 返回 schema ready。

## 测试结果

本轮 `npm run check` 因单次工具调用存在 300 秒上限，按完全等价阶段执行，覆盖没有跳过：

- TypeScript：PASS。
- Web production build：PASS。
- Worker `wrangler deploy --dry-run`：PASS。
- Vue/Vitest：16 个文件，64/64 PASS。
- Node/workerd+D1：17 个文件，139/139 PASS。
- 合计自动测试：203/203 PASS。

Node 全量过程中发现 4 个旧测试常量仍指向 migration `0008`，已分别在 `6b6ce69`、`484cbaf` 更新到 `0012` 并重跑对应测试全绿。生产代码没有因这两个测试修复提交再变化。

真实浏览器额外检查：基础台账在 1440px 桌面宽度下三栏同时可见；移动断点下只显示当前一级，可按“电压 → 线路 → 杆塔 → 返回”导航；未发现页面级横向溢出。

## 当前未做 / 不应误称已完成

- 本轮没有部署、没有合并 `main`、没有升级远端 D1。
- 真实 Cloudflare CPU/免费额度、正式 D1/R2、目标地区网络、真实通知投递、正式恢复和运维移交仍属于 P7。
- 当前历史业务数据仍按开发期规则可清理；账号、权限、审计等系统数据不能误删。
- 功能分支应先由用户验收，再决定是否合并/部署。

## 文档规则

文档入口统一见 `docs/README.md`。长期有效的业务事实只看：

1. `BUSINESS_BASELINE.md`
2. `DESIGN.md`
3. `DATA_MODEL.md`

工程与测试看：

4. `../AGENTS.md`
5. `TESTING.md`
6. `IMPLEMENTATION_PLAN.md`

历史 WIP、stash 恢复、阶段性 handoff 已从当前文档集删除；需要追溯时使用 Git 历史，不要重新创建一批按日期命名的重复交接文件。

## 下一步

优先顺序：

1. 用户验收 `wip/master-data-refactor-20260913` 的基础台账和需求级联交互。
2. 若验收发现缺陷，回到功能分支，先补回归测试再修复。
3. 文档分支已完成审核，是否合并由用户单独决定，避免文档清理与功能发布耦合。
4. 功能验收通过后，才进入远端 D1 migration、`main` 合并和正式发布流程；每一步按当次用户授权执行。
