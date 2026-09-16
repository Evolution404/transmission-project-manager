# AI 交接说明

日期：2026-09-16。此文档只记录当前施工状态；历史过程通过 Git 追溯，不再长期保留阶段性 WIP。

## 当前任务

正在执行全站 UI 重构，目标是现代、专业、简洁、优雅的企业级项目控制台。桌面端与手机端同等优先；桌面强调高效且有完成度的数据工作台，手机使用独立对象列表和单列触控流程，不做桌面页面缩小版。

长期 UI 规范已经归并到 `DESIGN.md`。早期独立 UI 方案、概念截图和阶段性界面审计已清理，过程只通过 Git 历史追溯，不再维护重复施工真源。

## Git 与本地环境

- 仓库：`Evolution404/transmission-project-manager`
- 当前施工分支：`refactor/ui-redesign-20260916`
- 禁止 `git reset` / `git clean`，不得覆盖他人未提交修改。
- 本地服务保持在 `http://127.0.0.1:5173/` 供实时验收。
- 当前仅授权代码实现和本地验证；不得据此部署生产、修改生产 D1、清理生产数据或推进新的 migration 版本。
- 开发阶段数据库继续只允许单一 `0001_initial_schema.sql` 基线；除非用户明确宣布进入运行阶段，否则不得新增 `0002+`。

## 已完成的 UI 重构

- 新应用壳：分组桌面导航、手机底部导航、统一设计 token、浅/暗色基础能力。
- 项目中心：项目列表、手机项目对象列表、新建项目、统一项目详情。
- 项目详情：来源需求、项目物资、储备确认、项目出库、执行任务、项目资金、附件与历史已经进入同一项目上下文；来源需求与项目物资保持独立，0 需求/0 物资合法。项目资金分段只展示真实框架归属、当前预算和明确标注的最近流水，不把当前页流水伪装成累计值；进入资金工作区会携带并恢复当前 `projectId`。
- 执行任务：跨项目 `/tasks` 使用服务端分页队列；旧 `/delivery` 页面实现已删除，只保留 `/delivery → /tasks` 兼容重定向。
- 旧储备页面已退役：`ReservesView.vue` 已删除，`/reserves` 仅兼容重定向到项目中心；其分类规则能力迁入设置，项目储备本身由项目中心和项目详情承载。
- 任务闭环：项目出库 → 新建执行任务 → 供应 → 实施 / 结算并行。统一供应编辑器可登记已上报、已发货、已到货，并按 `到货 <= 发货 <= 上报 <= 任务物资需求量` 计算阶段最大增量；三条线独立版本/幂等，结算允许先于实施。
- 手机任务详情、登记到货、任务创建等已按独立手机布局处理，不依赖桌面宽表。
- 需求页已完成第一轮新结构：桌面高密度列表、手机需求对象列表、创建/导入主次动作重新整理。
- 资金页已改为浏览优先、编辑按需；框架、协议、项目预算、资金流水仍保持原业务语义，不用分页数据伪造汇总。
- 分析页只保留业务分析、月计划、月报、年度事项和预警；通知联系人、通知发送记录和逻辑备份已迁入设置。分析页桌面采用指标条与数据面板，手机缺口/事项/预警使用独立对象列表。
- 设置页已重构成员管理、可读系统配置、储备分类规则、通知与逻辑备份；成员列表在手机端不依赖宽表，低频/危险操作不常驻主列表。
- 基础台账外层已改为线路中心对象清单：桌面使用高密度线路清单和全宽杆塔数据面板，手机使用线路/杆塔对象列表；线路位置、物理杆塔、更名、rebind、排序和批量导入的业务边界未改变。
- 登录和首次改密已统一到新的认证视觉；账号/密码 autocomplete、浏览器 Argon2id、服务端 HMAC verifier 和 HttpOnly 会话边界未改变。
- 暗色主题已接入 Naive UI `darkTheme` 与设计 token；DataTable 等组件不再被浅色 theme override 强行覆盖。
- 已建立 UI 硬门禁：业务源码禁止直接渲染原生 `<button>` / `<input>` / `<select>` / `<textarea>` 和动态 `h('button')`；原生 file input 只能隐藏在设计系统 primitive 内。门禁位于 `tests/repository-guards.test.mjs`。
- 设计系统 primitive：`apps/web/src/app/AppPressable.vue`、`AppFilePicker.vue`。

最近一次完整 `npm run check`：Node **298/298 PASS**、Web **134/134 PASS（23 个测试文件）**；TypeScript、Web production build、Worker `wrangler deploy --dry-run`、Node + SQLite + Filesystem 第二运行时均 PASS。Web 测试文件数下降来自旧 `ReservesView` / `DeliveryView` 页面及其重复测试在能力迁移完成后正式删除，不是跳过门禁。

最近 UI 提交：

- `e45d108` `feat(ui): establish professional app shell and task queue`
- `1dc2999` `feat(ui): prevent native control regressions`
- `6757f37` `feat(ui): refine demand and finance workspaces`
- `76a69f8` `feat(ui): retire legacy reserve and delivery workspaces`
- `c411e85` `feat(ui): unify finance analysis and master data experience`
- `a0fa16e` `refactor(ui): streamline finance and demand workspaces`

## 最近收口：项目分页与 URL 状态

- 工作台“待出库”使用 `/projects?stage=reserve`，口径与分析统计一致：项目不存在 `project_releases`；**不额外要求储备已确认**。
- `SqlReserveProjectQueryRepository.list(...)` 已改为 `stage + scope + created_at/id keyset cursor` 同一 SQL 查询；项目/框架权限范围在数据库 `LIMIT` 前过滤，不再先取固定前 50 条后在 HTTP 层筛权限。
- `/api/reserve-projects` 已支持 `stage=all|reserve`、不透明 cursor 和 `limit+1` 下一页判定，修复大项目集固定前 50 条且 `nextCursor:null` 的静默遗漏。
- `ProjectsView.vue` 已从 URL 恢复 `stage/query` 并同步筛选状态；列表使用服务端 cursor 分页，进入详情时携带完整项目列表 URL，`ProjectDetailView.vue` 返回时恢复原筛选上下文。
- `TaskQueueView.vue` 已从 URL 恢复并同步 `status/query`，刷新 `/tasks?status=settlement_pending` 后仍保持待结算筛选并按该状态请求服务端。
- `PlaceholderView.vue` 已删除并确认无引用；`DashboardView.test.ts` 已补 router mock，消除全量 Web 测试中的虚假 router injection warning。
- 测试先行回归已收口：仓储分页/stage **2/2 PASS**，Projects/Tasks 定向 **6/6 PASS**，Web/API typecheck、`git diff --check` 均 PASS；当前分支最新完整 `npm run check` 为 Node **298/298 PASS**、Web **134/134 PASS（23 文件）**。

## 当前 UI 收尾施工包

- 项目中心搜索已经从“只筛当前已加载项目”改为服务端搜索；项目名称、负责人、年度查询与 stage、scope、cursor 一起在 SQL `LIMIT` 前生效，大项目集不再因为首屏 50 条而漏掉匹配项目。
- 资金页手机端不再复用桌面宽表：框架、执行协议、资金流水均有独立对象列表；协议状态使用中文业务文案，不泄露 `active/paused/expired` 内部枚举。顶部原有一个不控制任何数据的“口径”下拉框已删除，禁止保留假交互。
- 任务队列手机对象行已补任务四状态与计划量；任务创建、任务详情、实施/结算抽屉、需求弹窗和项目详情的残留浅色 fallback/硬编码浮层阴影已改为统一设计 token。
- 设置页成员编辑弹窗补齐手机端可滚动内容区、软键盘/安全区友好的 sticky 操作区；未知角色/运维状态不再回退显示英文内部枚举。
- 已完成“旧入口 → 新位置”覆盖审计：当前 `views/` 只剩实际页面；`/reserves` 与 `/delivery` 仅保留兼容重定向。现有 settings/tasks/projects feature 组件均有真实引用，没有可安全删除的死 Vue 组件。
- 当前施工包验证已通过：相关 Web 定向 **39/39 PASS（7 文件）**，项目查询仓储 **2/2 PASS**；当前分支最新完整 `npm run check` 为 Node **298/298 PASS**、Web **134/134 PASS（23 文件）**，Web/API/shared typecheck、Web production build、Worker dry-run、Node + SQLite + Filesystem 第二运行时和 `git diff --check` 均 PASS。

其后状态一致性收尾已经完成并通过完整门禁：

- `TaskCreateView` 已补真实回归：项目/执行上下文读取失败时不再只剩“返回项目”的空白页，而是显示错误和“重新加载”；测试按先红后绿完成。
- 工作台、需求、资金、分析、设置统一补主数据读取失败后的“重新加载”动作；repository guard 锁定这 5 个主工作区的恢复入口。
- 页面眉标、登录/改密装饰文字和项目对象眉标中的 `WORKSPACE/PROJECTS/EXECUTION/FINANCE/SETTINGS/ANALYSIS/DEMANDS/PROJECT/...` 已统一改为中文，并增加静态门禁，避免纯英文装饰文案回流。未知角色/预警状态也不再回退显示内部英文枚举。
- 全局 DataTable hover/分隔线已改用 `--ui-*` token，不再维护浅色/暗色两套硬编码值；分析页刷新、月报生成、事项创建补 loading 反馈。
- 该状态一致性包新增 repository guard 后 **40/40 PASS**，相关 Web 定向 **49/49 PASS**、TaskCreate **3/3 PASS**；最终完整 `npm run check` 为 Node **298/298 PASS**、Web **134/134 PASS（23 文件）**。
- 当前定向结果：repository guards **40/40 PASS**；相关 11 个 Web 页面 **49/49 PASS**；TaskCreate **3/3 PASS**；Web typecheck 与 `git diff --check` PASS。完整 `npm run check` 仍需在本小包提交前复跑。

真实浏览器最终验收仍未完成：项目未引入 Playwright/Puppeteer；本机 Chrome headless 能生成首张未登录截图，但进程会被 Google Updater/Crashpad 拖住，批量桌面/手机/明暗截图流程不可靠。未登录状态不会伪造认证 session；最终验收需要使用正常登录会话补齐真实浏览器截图与交互检查。

## 下一步施工顺序

1. 对新位置继续补齐空状态、加载失败、只读、409、重复提交和移动端软键盘/底部操作区域检查；已有自动测试继续保留。
2. 使用正常认证流程补齐真实浏览器桌面/手机、浅色/暗色截图和关键交互验收；不得通过伪造会话绕过认证。自动测试不能替代最终真实浏览器验收。
3. 真实浏览器验收完成后最终再次运行完整 `npm run check`，确认全站功能迁移和交互验收都完成后才可标记 UI 重构完成。

## 必须保持的业务/工程边界

- 需求可以没有物资；项目也可以 0 需求、0 物资建立。
- 需求来源与项目物资是不同事实，不得相互推导数量上限。
- 项目出库是一次项目级节点，不是仓库发货。
- 任务供应、实施、结算三线并行；最终四状态来自业务事实汇总，不是人工标签。
- 框架总额、协议额度、项目预算、预算确认占用、预算发生、实际费用、任务结算始终分开。
- 金额/数量继续使用定点整数；写操作保持角色/范围校验、版本冲突、幂等键和审计。
- 线路位置与物理杆塔保持独立稳定身份；更名和 rebind 不得破坏历史需求定位。
- 禁止假数据、当前页统计冒充总量、前端 N+1 聚合、隐藏权限代替服务端鉴权。
- 本轮不授权生产发布和生产数据修改。
