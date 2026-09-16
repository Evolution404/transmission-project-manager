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
- 品牌资产已组件化：统一为“输电运检中心 / 全流程项目管理”，`BrandIcon.vue` 与 `BrandLockup.vue` 复用同一套输电塔 + 环形线路 SVG 设计，侧栏、登录、首次改密及 `favicon.svg` 已统一，不再保留旧临时 logo。
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

最近一次完整 `npm run check`：Node **308/308 PASS**、Web **161/161 PASS（23 个测试文件）**；TypeScript、Web production build、Worker `wrangler deploy --dry-run`、Node + SQLite + Filesystem 第二运行时均 PASS。

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

继续完成了一轮移动端与并发状态审计（当前待完整门禁后提交）：

- 需求页“物资字典”已补手机独立对象列表，名称、编码、型号、单位、启停状态无需横向拖动桌面宽表；新增需求/需求详情弹窗在手机端限制可视高度，正文独立滚动，footer 考虑 safe-area。
- 项目“来源需求”和“项目物资”编辑器新增完整 409 恢复链：冲突后草稿保留，抽屉内可直接“读取最新项目数据”，父项目刷新后继续使用原草稿重试；保存进行中遮罩和关闭按钮均不能误关抽屉。
- 任务详情删除无任何行为的“更多”假按钮；供应抽屉保存中同样禁止误关。
- 基础台账所有业务弹窗统一加入手机可视高度、内部滚动和安全区 footer；清理用户界面中的“稳定 ID / JSON / 成员 ID”等无业务价值实现术语，未知自定义字段类型不回退英文内部值。
- 当前定向结果：MasterData / Demands / ProjectEditors / ProjectDetail / TaskDetail / Administration 相关 **49/49 PASS**，Web typecheck 与 `git diff --check` PASS；完整 `npm run check` 为 Node **298/298 PASS**、Web **136/136 PASS（23 文件）**，Web/API/shared TypeScript、Web production build、Worker dry-run 和 Node + SQLite + Filesystem 第二运行时均 PASS。
- 分析页图表随后完成暗色模式收口：ECharts 轴线、标签、网格、tooltip 和柱色全部读取全局 `--ui-*` 设计 token；切换“进度与缺口 / 储备剩余”分段或系统明暗主题时会重新渲染并 resize，避免隐藏分段初始化导致尺寸异常。该改动测试先红后绿，Analysis 定向 **4/4 PASS**；完整 `npm run check` 为 Node **298/298 PASS**、Web **137/137 PASS（23 文件）**，TypeScript、Web production build、Worker dry-run 与第二运行时均 PASS。

无头浏览器验收基础设施已经补齐并进入 CI：仓库已引入 Playwright，`npm run test:ui:headless` 每次使用临时目录创建隔离 D1 / R2 本地状态并启动独立 Wrangler Worker，不复用开发数据库、不读取真实浏览器 Cookie，也不接触真实账号。认证链路完全通过页面完成：先在初始化页输入测试管理员姓名、测试账号、测试密码和测试初始化令牌创建首管理员；随后开启新的无 Cookie 浏览器会话，再从登录页输入同一测试账号密码完成真实登录，覆盖浏览器 Argon2id 派生、服务端 HMAC verifier 与 HttpOnly session。后续视觉验收复用的是该真实登录产生的 HttpOnly 会话状态，而不是伪造 Cookie，从而避免每个视口重复执行慢 KDF。当前 Headless Chromium **10/10 PASS**：首次初始化、重新登录、业务深链整页刷新后保持登录/路由、desktop-light、desktop-dark、**900px compact-light**、mobile-light、mobile-dark，以及桌面/手机关键写入弹层验收。五种视口/主题均遍历工作台、需求、项目、任务、资金、分析、基础台账、设置 8 个主路由，并校验横向溢出、实际计算字号不低于 12px、手机一级导航 5 个触控目标均不低于 44px、系统明暗 token、桌面侧栏/手机“更多→设置”真实交互；同时通过真实 DOMRect 拦截侧栏图标/文字、激活竖条/图标、右上账号区、手机底部导航、手机“更多”菜单和手机账号行的元素重叠。“新增需求 / 新建项目 / 新增成员”三个关键写入弹层继续校验不越出桌面/手机视口。GitHub Actions `CI` 已增加独立 `headless-ui` job，安装 Chromium 后执行同一仓库命令，本地 `npm run check` 保持轻量。

本轮浏览器级验收发现并修复了多类静态审计未能发现的真实 UI 问题：设置页成员 DataTable 使用 `h()` 动态创建单元格时 scoped CSS 未命中，账号 `<small>` 实际回退为 **10.83px**；手机“新建项目”抽屉错误保留桌面 520px 宽度；“新增需求 / 需求详情”使用 Teleport 后 scoped `:deep()` 高度规则在 Ubuntu Chromium 未命中，390×844 视口中“新增需求”曾达到 **1267.16px**；侧栏激活竖条曾因滚动容器裁剪而缺失，随后又暴露 `AppPressable` scoped reset 的 `padding: 0` 高优先级覆盖业务样式、导致竖条与图标实际重叠 **6px**；900px 紧凑桌面还发现设置页成员表的 min-content 宽度将整页撑到 **980px**。当前已分别通过限定全局后代样式、正确的 NDrawer/Teleport 选择器、低优先级 `:where(.app-pressable)` reset、独立侧栏 indicator gutter，以及设置页 grid 子项 `min-width: 0` + 成员表内部横向滚动收口。账号 Shell 同步改为 **username 主身份、role 次级信息**：桌面左下仅 `username + 角色`，右上仅 `username + 退出`，手机“更多”保持同一层级，避免 `displayName=系统管理员` 与角色标签重复显示。最新完整 `npm run check` 为 Node **314/314 PASS**、Web **165/165 PASS（23 文件）**，TypeScript、Web production build、Worker dry-run 与 Node + SQLite + Filesystem 第二运行时全部通过；独立 Headless Chromium 为 **10/10 PASS**。此前远端 GitHub Actions run `35088316979` 已验证基础 `check` 与 `headless-ui` 双绿；当前分支最新 UI 收口仍需以本次提交后的 CI 结果为最终远端证据。

## 最近收口：导航逻辑与可读性审计

- 侧栏不再通过 URL 前缀猜当前模块。所有主路由显式声明 `meta.navKey`：项目详情归“项目”，项目下的新建任务/任务详情归“执行任务”。桌面分组调整为“业务：工作台/需求/项目/执行任务；管理：资金/分析/基础台账；系统：设置”，基础台账不再与设置混在底部系统区。
- 手机底部“更多”在需求、资金、分析、基础台账、设置页面持续保持当前态；“更多”抽屉内部当前项也有选中反馈，不再出现进入页面后底部四项全部未激活。
- 全站显式 CSS 字号新增硬门禁：业务源码禁止 10px/11px，12px 仅作为最低 caption 基线；表头、列表关键元数据、状态、返回/操作文字普遍提升至 13px，主 Tab/分段导航提升至 14px。repository guard 已锁定该约束。
- 返回上下文统一：任务队列进入任务详情后返回原 `status/query`；项目详情进入任务详情/新建任务后返回原项目详情；新建项目后继续保留原项目列表筛选 URL；项目详情进入资金工作区携带 `projectId + tab=budgets + from`，资金页只在合法项目来源下显示“返回项目”。
- 需求、资金、分析主工作区用 URL `tab` 恢复/同步当前位置；任务详情用 `section` 恢复“供应/实施/结算/范围”。默认项不强制写参数，非法值回默认项，不再刷新后悄悄回首个 Tab 或产生空白状态。
- 项目详情非法 `tab` 已使用白名单回退到概览，错误/旧链接不会再出现“项目头正常但正文空白”的半空白状态；默认概览不额外污染 URL。该修复已独立提交 `f6b302c`。
- 中等桌面/平板宽度原 76px 纯图标侧栏已改为 96px 紧凑文字侧栏，图标与业务名称同时可见；新增 repository guard 禁止再次把 768–1100px 导航退化为只能靠图标识别。
- 手机一级导航调整为“工作台 / 需求 / 项目 / 任务 / 更多”，核心“需求 → 项目 → 执行任务”流程不再把需求藏进更多；资金、分析、基础台账、设置留在更多，并有静态门禁锁定一级业务路径。
- 显式 12px 样式从审计时的 67 处缩减到 19 处，保留项主要是版本、眉标、日期、序号等真正 caption；错误提示、状态、列表主次事实、设置记录、移动端对象事实等高频信息已提升到 13px。手机任务名、所属项目名、需求线路名和物资名允许自然换行，不再强制单行省略。
- 新增显式 404 页面：未知/过期前端 URL 不再只显示应用壳和空白正文，而是提供“返回工作台 / 打开项目中心”。需求池显式搜索也已纳入 URL `query`，刷新、分享链接或返回页面后继续保留搜索条件。
- 本轮测试继续按先红后绿推进；其后又完成工作区上下文恢复收口：基础台账线路列表的 `voltage/status/query` 可由 URL 恢复并同步；资金、分析当前框架使用 `framework` 恢复并保留当前 Tab；资金切框架会清理跨框架预算/流水项目选择并删除失效 `projectId`，预算/流水项目下拉只展示当前框架项目。基础台账暂未伪造 `lineId` 详情深链，因为服务端尚无稳定按线路 ID 直接读取接口，避免在首屏 100 条里查找造成大台账随机失效。该包定向 MasterData/Analysis/Finance **33/33 PASS**，Web typecheck、`git diff --check` PASS；最新完整 `npm run check` 为 Node **302/302 PASS**、Web **151/151 PASS（23 文件）**，TypeScript、Web production build、Worker dry-run 与 Node + SQLite + Filesystem 第二运行时全部 PASS。
- 任务供应、实施、结算三类写入抽屉现已统一保存期关闭门禁：保存请求进行中，遮罩、右上角关闭、Esc / `update:show` 和底部取消都不得中断界面状态；新增 repository guard 防止回退。项目来源需求 409 文案同步为“草稿保留并可原地读取最新项目”，与实际交互一致。
- 其后把同一关闭门禁扩展到主要写操作层：项目新建、需求新建、需求详情追加物资、项目储备确认/出库、成员管理/重置密码，以及基础台账删除、电压等级、班组、塔型、自定义字段、线路/杆塔编辑与更名、物理杆塔/rebind、自定义值、排序和批量导入。基础台账 14 个写弹窗共享 `writeModalGuardProps`，避免每个弹窗独立维护。该包相关 Web 定向 **45/45 PASS**，最新完整 `npm run check` 为 Node **303/303 PASS**、Web **151/151 PASS（23 文件）**。
- 内联编辑页继续补齐“提交对象不可漂移”约束：Finance 保存框架/协议/归属/预算/流水时锁定框架、子项目和当前编辑字段，保存期间不能切换工作区 Tab 或折叠当前表单；Analysis 保存月计划/规则/月报/事项时锁定框架、统计日期和当前表单，年度事项“完成”也进入统一写锁，桌面/手机均阻止重复提交；Demands 保存映射模板或执行导入时锁定模板和字段映射，保存标准物资时锁定表单及收起入口。该包 Finance/Analysis/Demands 定向 **26/26 PASS**；完整 `npm run check` 为 Node **304/304 PASS**、Web **151/151 PASS（23 文件）**。
- 操作可达性继续收口：业务 Vue 源码禁止 `size="tiny"`，基础台账线路操作和杆塔排序统一提升为 small；手机上的线路“编辑/删除”和杆塔“上移/下移”至少 36px 高。项目详情、任务详情/新建任务、基础台账的文本式返回操作桌面至少 36px、手机至少 44px 命中高度，外观仍保持轻量文本导航。两条 repository guard 已锁定；完整 `npm run check` 为 Node **306/306 PASS**、Web **151/151 PASS（23 文件）**。
- 异步上下文竞态继续收口：Finance 的框架汇总/协议/流水、预算项目和流水分页使用 request sequence，旧框架/旧项目请求晚到后直接丢弃；Analysis 的框架进度/缺口/计划/月报同样使用框架请求序号，统计日期相关事项统一经 `loadMilestones()` 的单一请求序号处理，页面刷新、改日期、新增事项和状态更新不再维护多套竞态逻辑。新增 4 个行为测试主动让旧请求最后返回，Finance/Analysis 定向 **20/20 PASS**；最新完整 `npm run check` 为 Node **307/307 PASS**、Web **155/155 PASS（23 文件）**。
- 当前上下文失败恢复也已收口：Finance 切框架/切预算项目、Analysis 切框架/切统计日期的当前请求失败会进入页面内错误提示和“重新加载”，不会再产生 Vue 未处理 Promise；重试保持当前框架/预算项目/统计日期并真实重新请求，旧上下文失败则由请求序号静默丢弃。Analysis 在新框架读取开始时同步清空旧进度图，失败后不会残留上一框架图表。新增 4 个失败/重试行为测试后 Finance/Analysis 定向 **24/24 PASS**；最新完整 `npm run check` 为 Node **307/307 PASS**、Web **159/159 PASS（23 文件）**。
- Finance / Analysis 写后刷新语义进一步拆分：框架、协议、项目归属、预算草稿/确认、资金流水、月计划、分析规则、月报、年度事项创建/状态更新，mutation 成功后统一经 `refreshAfterCommittedWrite()` 刷新。刷新失败时页面明确显示“操作已成功，但最新数据刷新失败”，并发 warning 引导重新加载；不会再进入“预算保存失败 / 月计划保存失败”等 mutation error。两条真实“写成功、刷新失败”行为测试先红后绿，新增 repository guard 锁定规则；Finance/Analysis 定向 **26/26 PASS**，完整 `npm run check` 为 Node **308/308 PASS**、Web **161/161 PASS（23 文件）**。
- Demands 已继续按同一语义收口：手工需求创建、需求物资追加、标准物资新增、批量导入发布在服务端写入成功后，后续列表/字典刷新失败不得再误报为“创建失败/保存失败/导入失败”；统一通过 `refreshAfterCommittedWrite()` 提示“操作已成功，但最新数据刷新失败，请重新加载”，并保留页面级恢复入口。代表性“标准物资 POST 已成功、字典刷新失败”测试已先红后绿，repository guard 锁定四条需求写路径。定向 Demands **11/11 PASS**；最新完整 `npm run check` 为 Node **309/309 PASS**、Web **162/162 PASS（23 文件）**，TypeScript、Web production build、Worker dry-run 与 Node + SQLite + Filesystem 第二运行时全部通过。

## 下一步施工顺序

1. 当前 mutation / reload 语义审计和本轮全站 UI 自动化验收均已收口：`MasterDataView.vue` 与 `SystemOperationsPanel.vue` 的真实误报已修复；`ReserveClassificationPanel.vue` 已用行为测试确认无需生产改动；`ProjectDetailView` / `TaskDetailView` 等已正确处理路径未做机械重构。
2. 后续 UI 改动继续同时维护相关 Vitest、`npm run check` 与独立 `npm run test:ui:headless`；无头 E2E 必须继续使用隔离测试数据和页面真实认证，不得注入真实 Cookie、真实密码或复用用户真实浏览器窗口。CI 的 `headless-ui` job 不得移除，已有 repository guard 锁定。
3. 当前没有已知 UI blocker。除非后续自动化/人工验收出现可复现问题，否则停止继续泛化改样式；当前施工分支保持待审状态。未经用户明确授权仍不得合并 `main` 或部署生产。

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
