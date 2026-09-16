# 实施计划与验收清单

版本：2026-09-16。长期业务事实见 `BUSINESS_BASELINE.md`，当前施工状态见 `AI_HANDOFF.md`。

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
| 全站 UI 重构 | 应用壳、项目/任务闭环、需求、资金、台账、分析、设置、认证视觉与全站验收 | **施工中，主体迁移已完成**；项目/任务核心闭环、需求、资金、台账、分析、设置、认证和旧页面退役已落地，当前重点为全站细节审计与真实浏览器最终验收。长期 UI 规范统一维护在 `DESIGN.md` |

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
- 当前全站 UI 已把基础台账外层统一为“线路对象清单 → 线路详情 → 全宽杆塔数据区”：桌面使用高密度对象清单/表格，手机使用独立对象列表，不改变 M6 的线路位置与物理杆塔身份边界。
- 统一项目详情已接入来源需求、项目物资、储备确认、项目出库、执行任务、项目资金、附件与历史；项目资金只展示真实当前预算/框架归属和明确标注的最近流水，不用分页结果冒充全量累计。
- 任务详情统一供应编辑器支持已上报/已发货/已到货三个阶段，保留独立 `supply_version`、幂等与 409 输入保留。
- 设置承载成员、可读系统配置、储备分类、通知和逻辑备份；分析页只承载业务分析、计划、月报、年度事项和预警。
- 旧 `/reserves` 与 `/delivery` 页面实现已经删除，分别只保留到项目中心和任务队列的兼容重定向，避免两套业务 UI 长期并存。

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

全站 UI 重构当前施工分支 `refactor/ui-redesign-20260916` 最近一次完整 `npm run check` 已 PASS：Node **299/299**、Web **144/144（23 文件）**，Cloudflare/Node/Web/shared TypeScript、Web production build、Worker dry-run、Node+SQLite+Filesystem 第二运行时和全部静态门禁均 PASS。

项目分页/路由状态工作包已经收口并验证：修复项目列表固定前 50 条且 `nextCursor:null` 的分页缺口，并让工作台 `/projects?stage=reserve`、项目列表 `stage/query`、任务队列 `/tasks?status=...&query=...` 在刷新后恢复筛选。定向仓储测试 **2/2 PASS**，Projects/Tasks 定向 **6/6 PASS**，Web/API typecheck 和 `git diff --check` 均 PASS。

其后的 UI 收尾施工包进一步修复了“大项目集搜索”和手机端完成度：项目搜索改为服务端 SQL `LIMIT` 前过滤；资金页框架/协议/流水在手机使用独立对象列表；任务队列手机端直接展示四状态与计划量；成员弹窗补软键盘/安全区可达操作区；业务 View/feature 的浅色 fallback 已清理为统一设计 token；无实际效果的资金筛选控件已删除。旧入口覆盖审计确认 `/reserves`、`/delivery` 只保留兼容重定向，现有业务 Vue 组件均有真实引用。定向 Web **39/39 PASS（7 文件）**、项目查询仓储 **2/2 PASS**；当前分支最新完整 `npm run check` 为 Node **298/298 PASS**、Web **134/134 PASS（23 文件）**，Web/API/shared typecheck、Web production build、Worker dry-run、Node+SQLite+Filesystem 第二运行时与 `git diff --check` 均 PASS。

状态恢复与中文化一致性收尾已完成：任务创建上下文读取失败显示可恢复错误而不是空白页；工作台、需求、资金、分析、设置统一提供“重新加载”；纯英文页面眉标/认证装饰文案由 repository guard 拦截；DataTable 全局 hover/分隔线统一走主题 token；分析页刷新、月报生成、事项创建补齐进行中反馈。该小包 repository guards **40/40 PASS**、相关 Web **49/49 PASS**、TaskCreate **3/3 PASS**；完整 `npm run check` 为 Node **298/298 PASS**、Web **134/134 PASS（23 文件）**。

随后继续收口移动端与并发编辑体验：需求物资字典增加手机对象列表；需求长弹窗、基础台账业务弹窗统一处理可视高度/正文滚动/safe-area footer；项目来源需求和项目物资的 409 从“仅提示用户关闭刷新”改为草稿原地保留并可直接刷新父项目；保存中的项目编辑器和任务供应抽屉禁止误关；删除任务详情无行为“更多”按钮，并清理业务界面的内部实现术语。该包定向 Web **49/49 PASS（6 文件）**、Web typecheck 与 `git diff --check` PASS；完整 `npm run check` 为 Node **298/298 PASS**、Web **136/136 PASS（23 文件）**，Web/API/shared TypeScript、Web production build、Worker dry-run 与第二运行时均 PASS。

分析页图表继续完成暗色/响应式收口：ECharts 配色不再依赖默认主题，而是读取全局设计 token；切换分析分段或系统明暗主题后重新 setOption/resize，并使用 `containLabel` 避免手机端长分类文字被固定边距裁切。Analysis 定向 **4/4 PASS**；完整 `npm run check` 为 Node **298/298 PASS**、Web **137/137 PASS（23 文件）**，TypeScript、Web production build、Worker dry-run 与第二运行时均 PASS。

随后完成导航逻辑与可读性专项审计：主路由用 `meta.navKey` 明确侧栏归属，嵌套任务路由不再错误点亮“项目”；基础台账移入“管理”，设置独立为“系统”；手机“更多”在其子页面持续保持当前态。业务 UI 增加 12px 最低字号门禁，并将高频业务元数据/表头/状态提升到 13px、主 Tab/分段导航提升到 14px。项目列表/项目详情/任务队列/任务详情/新建任务/资金工作区的 `from` 上下文已贯通；需求、资金、分析使用 URL `tab`，任务详情使用 `section`，刷新与分享链接可恢复当前位置。该轮完整 `npm run check` 为 Node **299/299 PASS**、Web **144/144 PASS（23 文件）**。

该工作包保持以下验收条件：

- `/api/reserve-projects` 的 `stage=reserve` 必须在 SQL 层按“不存在 `project_releases`”过滤，与工作台/分析统计口径一致；
- 项目 scope/framework scope 必须在 `LIMIT` 前下推 SQL，禁止 HTTP 层过滤分页结果；
- 项目列表使用稳定 `created_at DESC, id DESC` keyset cursor，跨页不得重复或遗漏；
- Projects 页从 URL 恢复并同步 `stage/query`，项目详情返回时恢复原列表 URL；
- Projects 搜索条件由服务端在 `LIMIT` 前过滤，不得退回仅搜索当前已加载页；
- Tasks 页从 URL 恢复并同步 `status/query`；
- 定向测试、`git diff --check`、相关 typecheck 通过后，再跑完整 `npm run check` 并独立提交。

真实浏览器最终验收仍是未完成项。当前项目未引入 Playwright/Puppeteer；本机 Chrome headless 在该环境会被 Updater/Crashpad 拖住，不能稳定批量生成桌面/手机/明暗截图。不得通过伪造认证会话规避登录；最终应使用正常认证会话完成关键页面真实浏览器验收后再宣布 UI 重构完成。

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
- 上述分析模块职责拆分完成时的历史门禁基线为 Node **293/293 PASS**、Web **114/114 PASS**；当前施工分支的最新完整门禁以第 4 节所列 Node **299/299**、Web **144/144（23 文件）**为准。
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
9. 项目/任务列表的筛选必须可从 URL 恢复；服务端分页必须在权限过滤与业务 stage 过滤之后执行，不能靠前端 N+1 或当前页筛选伪造完整列表。
