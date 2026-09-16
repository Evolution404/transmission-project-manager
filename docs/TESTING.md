# 测试策略与开发门禁

版本：2026-09-15。适用于所有业务功能、基础台账、认证、后端可移植化、数据迁移、缺陷修复和正式环境准备。

## 1. 核心规则：测试先于生产代码

每个新功能、高风险重构或缺陷修复都遵循：

1. 先明确业务不变量和验收场景。
2. 先新增/更新自动测试；缺陷必须先用回归测试复现旧问题。
3. 再修改生产代码直到定向测试通过。
4. 运行完整 `npm run check`；如果工具存在单次时长上限，可按完全等价阶段/文件组执行，但必须覆盖全部测试文件。
5. 更新共享类型、migration lock 和长期文档。
6. `git diff --check`、密钥/真实数据检查后再提交并推送。

禁止用 `.skip`、`.only`、`test.todo` 或删除断言来“修绿”。前端隐藏按钮不算权限测试；本地 workerd 通过不等于真实 Cloudflare CPU/配额/网络通过。

## 2. 统一门禁

仓库根目录：

```sh
npm run check
```

等价组成：

- 所有工作区生产代码 TypeScript 检查；
- Vue 测试代码类型检查；
- Web production build；
- Worker `wrangler deploy --dry-run`；
- 全部 `tests/*.test.mjs` Node/workerd+D1 测试；
- 全部 `apps/web/tests/*.test.ts` Vue/Vitest 行为测试。

`refactor/master-data-ux-hardening-20260915` 最近一次完整门禁（2026-09-15，物理杆塔/线路节点与配置模型收口）：

- TypeScript（Cloudflare API + Node runtime + Web + shared）：PASS；
- Web production build：PASS；
- Worker `wrangler deploy --dry-run`：PASS；
- Vue/Vitest：**114/114 PASS（19 个测试文件）**；
- Node：**270/270 PASS**；
- Node + SQLite + Filesystem 第二运行时：PASS；
- migration checksum/单基线与 repository/static guards：PASS。

本轮继续在既有基础台账门禁上新增/强化：物理杆塔与线路杆塔节点分离、同一物理塔被多条线路节点复用、专用物理塔 rebind、需求端点使用稳定 `tower_position_id`、班组/杆塔类型/自定义字段配置 CRUD、自定义字段独立版本和类型化索引、已使用字段禁止误删，以及备份/恢复覆盖新增配置和值表。`MasterDataView.test.ts` 当前 **16/16 PASS**。
本轮代码与清债快照 `c87fc04` 已由 PR #12 GitHub CI run `34941209241` 重新执行完整 `npm run check` 并 PASS；这才是当前 SHA 的远端门禁证据。

## 3. 迁移与仓库守卫

主要文件：`tests/repository-guards.test.mjs`、`tests/migrations.test.mjs`、`tests/schema-readiness.test.mjs`、`tests/migration-watcher.test.mjs`。

必须保持：

- `tests/migrations.lock.json` 锁定当前开发基线 checksum。
- 当前开发阶段只允许 `0001_initial_schema.sql` 单一可重建基线，历史数据迁移也不得新增 `0002+` migration。发布工具必须测试“可自动搬运 / 需要显式转换 / 无法迁移需用户决定”三种路径；只有用户明确宣布进入运行阶段/正式维护升级链后才允许推进 migration 版本。
- 空库可按顺序应用全部 migration，重复 apply 不破坏当前 schema。
- schema readiness 必须指向最新 migration；数据库落后时业务接口统一 fail-closed 为 `SCHEMA_OUTDATED`。
- 本地开发启动器先验证 migration 文件与 checksum lock 稳定，再从不可变临时快照执行。
- 本地 checksum ledger 记录已执行 migration；已执行文件变化必须报错。
- `wrangler --json` 的机器可读 stdout 与 stderr 诊断分离，warning 不能污染 JSON 解析。
- migration 不得包含真实账号、固定生产密码、Secret 或真实业务数据。

## 4. 认证、成员和权限

主要测试：`authentication.test.mjs`、`production-authentication.test.mjs`、`admin-concurrency.test.mjs`、`member-atomicity.test.mjs`。

覆盖：

- 一次性 bootstrap、账号创建、登录、首次强制改密、退出、管理员重置密码、停用撤销会话；
- 浏览器 Argon2id 公共参数与服务端 HMAC verifier 边界；
- 数据库只保存 verifier 和 session token hash，不保存明文密码或浏览器派生凭据；
- 未知账号与错误密码统一响应、失败登录锁定；
- 角色和 `all/framework/project` 业务范围；
- 最后一个启用管理员在并发降权下仍受保护；
- stale version、幂等重放和失败事务不会留下孤立 scope/audit/idempotency；
- production 不信任 Cloudflare Access、开发身份头或客户端角色字段。

## 5. 基础台账与需求位置

主要测试：`master-data.test.mjs`、`demand-import.test.mjs`、`MasterDataView.test.ts`、`DemandsView.test.ts`。

必须覆盖：

- 管理员才可写电压等级、线路节点、物理杆塔、班组、杆塔类型和自定义字段配置；读取按既有业务权限开放。
- 电压等级唯一性、线路/杆塔父级关系、启停状态、稳定 ID 与版本冲突；线路名称和杆塔编号允许重名。
- `VoltageLevel 1:N TransmissionLine 1:N LineTowerPosition` 严格成立；`LineTowerPosition N:1 PhysicalTower`，同一物理塔允许被多条线路节点引用。
- `tower_no` 必须规范为 `#001` / `#010-1` / `#3058` 等；稳定 `line_tower_position_id` 是线路位置身份真源；同线路当前 `sort_rank` 唯一并与编号解耦。
- `whole_line / tower / tower_range` 三种位置形状及严格正向区段。
- 跨线路杆塔、倒序区段、停用父级/杆塔必须拒绝。
- 线路被需求引用后不能换电压等级；线路节点不能通过普通编辑换线、改编号、改顺序或替换物理塔。线路/杆塔正式更名、杆塔顺序调整和物理塔 rebind 必须走专用动作并保留审计；引用对象删除仍受保护。
- 物理杆塔资产编号、塔型、班组使用独立 `version`；线路节点 rebind 后稳定线路节点 ID、编号和需求位置引用保持不变。
- 自定义字段值使用独立 `custom_field_value_sets.version`，与业务对象本体版本分开；标量与多选筛选索引必须和真值原子更新。
- 自定义字段定义创建后不得改变对象类型、字段键和数据类型；产生业务值后不能直接删除字段定义，只能停用。
- 未引用对象可删除；引用对象删除拒绝；停用后历史需求仍可读取，新需求不可使用。
- 杆塔导入用户侧不限行数；浏览器全量预检后自动切为内部安全分片。覆盖 65 行自动分片、非法编号/状态、文件内重复、同号歧义、版本竞争、幂等重放、失败断点继续，以及内部 chunk 不允许绕过更名/排序门禁。
- 完整清单重排必须覆盖当前线路全部稳定杆塔对象且无重复，文件行顺序成为最终顺序；缺项、重复、跨线路 ID、stale `tower_order_version` 均拒绝，成功后 ID/编号保持不变。
- 线路/杆塔父级过滤和 cursor 分页无重复/遗漏，单页上限 100。
- 手工需求只提交对象 ID；父级变化清空下游选择。
- Excel validate/publish 都必须重新解析台账；未知或停用对象阻断发布，不自动创建台账。
- 杆塔号完整匹配优先于区段拆分，带连字符编号不能误拆。
- 手工需求大量物资使用集合校验/写入，不能按物资条数线性放大 D1 invocation 查询次数。

## 6. 需求导入与物资

主要测试：`demand-import.test.mjs` 和 Web import/parser 测试。

覆盖：

- `.xlsx`/UTF-8 `.csv`，多工作表和真实物理行号；旧 `.xls` 明确拒绝。
- 标准模板下载/回导和自定义字段映射。
- 同一抽象需求多行归并为一个需求 + 0..N 物资，并保留全部来源行。
- 无物资需求合法；型号/数量单边缺失拒绝。
- chunk/validate/publish 使用 `expectedVersion`；并发竞争只有一个成功，失败不留下半批正式数据。
- 同一文件来源幂等；业务文字相同但不同来源只提示疑似重复，不自动删除。
- 未知标准物资不伪造价格或已匹配事实。
- 需求列表分页，完整 Excel 不交给 Worker 解析。

## 7. 项目储备与项目物资

主要测试：`reserve-planning.test.mjs`、`final-business-flow.test.mjs`、`ProjectsView.test.ts`、`ProjectDetailView.test.ts`、`ProjectEditors.test.ts`。

覆盖：

- 项目可 0 物资创建。
- `project_demand_links` 与 `project_material_requirements` 分离。
- 项目物资可独立增删改/换型并记录修订原因与前后快照。
- 相同型号不同单位不得合并。
- `unit_price_scaled=null` 与显式 0 区分；金额定点计算并四舍五入到分。
- 已分配到任务的项目物资形成保护下限，不能静默缩减/删除。
- 储备确认形成不可变版本，后续修订产生新版本。
- 候选池和列表分页无遗漏，聚合不只统计当前页。
- 项目中心列表必须覆盖服务端 keyset 分页：`created_at + id` 稳定排序、跨页无重复/遗漏；`stage=reserve` 在 SQL 层按“不存在项目级出库记录”过滤。
- 项目/框架 scope 必须在列表 SQL 的 `LIMIT` 前生效，测试不得只验证 HTTP 层过滤后的少量样本。
- 项目名称/负责人/年度搜索必须由服务端在 `LIMIT` 前过滤；测试必须覆盖目标项目位于首个未筛选分页之外的情况，禁止退回“只搜索当前已加载项目”。
- Projects 页面从 URL 恢复 `stage/query`，筛选变化同步回 URL；从项目详情返回时恢复原项目列表 URL。

旧 `demand_allocations` 回归只用于历史兼容，不得据旧数量守恒测试恢复旧主模型。

## 8. 框架、协议与资金

主要测试：`finance.test.mjs`、`FinanceView.test.ts`。

覆盖：

- 框架/协议版本历史与并发版本守卫。
- 预算草稿与预算发生严格分离；预算确认不能自动产生资金流水。
- 预算协议分配精确等于预算金额且同框架、业务日期有效。
- `budget_occurrence` 与 `actual_cost` 独立统计。
- 一协议多项目、一项目多协议不会重复放大金额。
- 90%/80% 精确边界、预算超框架 1 分边界、0 分母未配置。
- 冲销通过负数追加记录保留原流水；同一原记录最多冲销一次。
- 资金流水游标分页、汇总集合查询和幂等重放。
- 协议状态等内部枚举不得直接以英文值进入业务界面；资金页在手机端使用框架/协议/流水对象列表，不依赖桌面宽表缩放。
- 需求页标准物资字典在手机端同样必须有独立对象列表，不能保留 700px 以上桌面宽表作为唯一展示方式。

## 9. 项目出库、任务、供应、实施和结算

主要测试：`final-business-flow.test.mjs`、`project-lifecycle.test.mjs`、`TaskQueueView.test.ts`、`TaskCreateView.test.ts`、`TaskDetailView.test.ts`、`ProjectDetailView.test.ts`。

最终主模型必须覆盖：

- 每项目一次项目级出库，保存不可变快照，不生成新的逐物资 `release_lines`。
- 只有项目级出库后才能创建 1..N 个正式任务。
- 任务物资累计不超过项目物资；项目物资不能缩到任务占用以下。
- 供应、实施、结算分别使用独立版本，允许不同顺序推进。
- `arrived <= shipped <= reported <= required`，相同 supply version 并发只有一个成功。
- 部分实施/结算保留数量进度；结算可以先于实施。
- 最终结算必须覆盖完整任务范围。
- 四状态由所有任务事实回投原始需求，而不是人工标签。
- 私有 R2 附件按项目范围重新鉴权。
- 任务队列从 URL 恢复 `status/query` 并把后续筛选变化同步回 URL；刷新 `/tasks?status=settlement_pending` 后仍必须保持待结算过滤并把状态发送到服务端。
- 需求池从 URL 恢复显式 `query`，执行新搜索后同步回 URL；刷新、复制需求搜索链接或从其他页面返回时不得丢失条件。
- 任务队列进入任务详情时必须携带原完整队列 URL；任务详情返回时恢复原 `status/query`。从项目详情进入任务详情/新建任务则恢复原项目详情分段，不能统一写死“返回项目”。任务详情 `section` 可从 URL 恢复并随分段切换同步。

`project-lifecycle.test.mjs` 中旧 release-batch/legacy implementation 测试只保证历史兼容，不定义新业务主路径。

## 10. 分析、预警、通知和备份

主要测试：`analysis-operations.test.mjs`。

覆盖：

- 月计划、季度边界、年度目标 0、两类滞后规则精确判定。
- 历史月报保留 rule version、规则 JSON 和完整 snapshot。
- 当前储备分析只读未项目级出库项目的当前项目物资；施工/其他费不进入项目物资类别，缺价单列。
- 年度事项 `month/day/unknown` 精度，不补造日期。
- crossing、daily summary、recovery、recross 生命周期。
- outbox 租约、超时回收、失败退避和 `unknown` 结果。
- 定时任务关闭浏览器后仍可执行。
- 备份分片 SHA-256/manifest、断点续跑、独立 D1 实际恢复对账；`auth_sessions` 不恢复。

## 11. 前端行为合同

`apps/web/tests/*.test.ts` 优先验证“用户操作 → 请求 payload → 成功/错误状态”，不做低价值像素快照。

重点：

- 登录/改密/成员管理不向服务端发送明文密码；
- 各角色不会发出越权写请求；
- 数量、金额转换使用正确定点/整数单位；
- 需求手工创建与导入流程、父子级联和错误阻断；
- `/master-data` 使用线路中心式“线路列表 → 线路详情”；移动端不得退回桌面三栏模拟，并须提供不依赖 drag/drop 的排序操作；
- 重业务页面保持路由懒加载；
- 全局中文 locale，禁止默认英文 placeholder。
- 主导航归属必须由路由 `meta.navKey` 显式声明；嵌套任务路由仍归“执行任务”。手机“更多”内页面关闭抽屉后仍应保持“更多”当前态。
- 中等宽度桌面/平板侧栏必须保留业务入口文字，不得退化成纯图标栏；手机一级导航必须直接包含需求、项目、任务，管理/系统功能再进入“更多”。
- 需求、资金、分析的主工作区 Tab 必须可由 URL `tab` 恢复并同步切换；项目详情进入资金页时同时携带 `projectId`、`tab=budgets` 和安全的项目返回上下文。
- `/master-data` 线路列表必须从 URL 恢复 `voltage/status/query` 并把显式筛选/查询同步回 URL；当前还没有按稳定线路 ID 直接读取接口时，不得用“只查当前首屏 100 条”伪造详情深链。
- 资金、分析的当前框架必须从 URL `framework` 恢复并在切换时保留当前 Tab；资金切框架后若原预算项目不属于新框架，必须清空预算项目并移除失效 `projectId`，预算/流水项目下拉不得暴露其他框架项目。
- 业务源码显式 CSS 字号不得出现 10px/11px；repository guard 将 12px 作为绝对可读性下限，高频业务元数据、表头、状态和可点击文字仍应优先使用 13px 及以上。
- 手机端任务队列必须直接展示任务四状态与计划量；复杂弹窗/抽屉的主要操作区考虑软键盘和安全区，不能把保存动作挤出可达区域。
- 手机任务名、线路名、物资名等主识别信息应允许换行，不得用单行省略号隐藏决定用户点击对象的关键内容。
- 未知前端路由必须命中明确的 404 页面，并提供可执行的返回入口，不能只剩应用壳空白正文。
- 项目来源需求、项目物资等带版本守卫的编辑器遇到 409 时必须保留用户草稿，并提供原地读取最新项目数据的明确动作；保存进行中禁止通过遮罩或关闭按钮中断界面状态。
- UI 审计应删除无行为的假按钮/假筛选控件；用户可见文案不得暴露无业务意义的内部 ID、JSON、SQL、cursor 等实现术语。
- 分析图表必须验证使用设计 token 而不是 ECharts 默认浅色；分段切换和系统明暗主题变化后要触发重新渲染/resize，防止隐藏容器产生错误尺寸。
- 主题样式使用统一 `--ui-*` token；业务 View/feature 不得通过 `var(--ui-*, #fff)` 等浅色 fallback 或硬编码阴影绕过暗色主题。
- 可见交互控件必须有真实行为，测试/审计应删除不改变状态、不发请求也不导航的假交互。
- 工作台、需求、资金、分析、设置等主工作区读取失败后必须提供明确“重新加载”；任务创建等条件页面不得因上下文请求失败而只剩空白布局。
- repository guard 拦截纯英文页面眉标/认证装饰文案回流；业务状态/角色不得把内部英文枚举作为未知值 fallback 直接展示给用户。

真实浏览器布局仍应在重大 UI 改动后补充人工/浏览器验收；组件测试不能证明所有设备像素效果。

## 12. P7 真实环境验收

以下不能用本地模拟替代：

- 真实业务模板数据抽检；
- 真实 Workers CPU/错误率和 D1/R2 配额；
- 正式域名、HTTPS/Cookie；
- 低性能手机 Argon2id 体验；
- 目标用户所在地网络；
- 真实通知投递；
- 正式停写备份、隔离恢复、回退；
- Cloudflare/GitHub 运维移交和 CI/CD 服务身份。

详细证据要求见 `PRODUCTION_ACCEPTANCE.md`，操作步骤见 `PRODUCTION_RUNBOOK.md`。
