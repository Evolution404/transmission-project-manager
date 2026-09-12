# 给下一位 AI 的交接

## 当前状态

P0、P1、P1.1、P1.2、P2、P3、P4、P5、P6 已完成并通过本地/合成数据验收。业务登录现为系统自维护 `username + password`：浏览器 Web Worker 执行 Argon2id，服务端保存带运行时 pepper 的 HMAC verifier，并使用 7 天 HttpOnly 服务端会话。邮箱和 Cloudflare Access 均不参与业务认证。

P2 已完成 Excel/CSV 浏览器解析、字段映射模板、分片导入/校验/发布、需求池列表/详情、来源追溯和标准物资字典。chunk/validate/publish 都使用显式 `expectedVersion`；版本守卫、业务写入和幂等记录处于同一个 D1 batch，stale version 及并发上传/校验/发布的失败请求不会留下半批数据。`/demands` 已懒加载真实需求页，不再指向占位页。

P2 恢复阶段使用过 Git stash `wip P2 before P1.2 local account auth`；该 stash 已在 P4 开始前按用户要求删除。当前代码和测试不依赖任何 stash。`docs/P2_RECOVERY_STATUS.md` 只保留恢复历史和完成结论，不再是待办入口。

P3 已完成储备候选/归并建议、数量拆分与守恒、估算与估价完整度、储备大类/类别映射、分类金额守恒、不可变储备版本，以及真实 `/reserves` 四步工作流。候选池按最多 100 条使用不透明游标分页，归并建议直接聚合完整剩余池，不会被第一页截断。数量和金额全部使用定点/整数口径；`null` 单价与显式零价严格区分，并发超分配、stale version、金额溢出和分类金额不守恒均有自动回归。

P4 已完成框架/协议版本、项目框架归属、预算草稿与确认版本、多协议分配、独立预算发生/实际发生、追加式冲销、资金汇总及 90%/80%/超框架警示；`/finance` 已接真实资金工作台。预算确认不自动生成预算发生，旧预算版本不重复计入，阈值判定使用精确整数比较。

P5 已完成分批出库、正常/历史实施、历史关联、独立结算与撤销、四状态投影、结算待办及私有附件；`/delivery` 已接真实实施结算工作台。P3 项目范围不能缩小到已出库/已实施/有效结算事实以下；“已结算”必须同时满足完整覆盖和有效最终结算，非最终覆盖满仍不算已结算。

**下一步进入 P7：真实数据、云资源、网络、恢复与正式上线验收。** Cloudflare 仍是托管路线，但不参与业务身份认证；继续保留 P1.2 的账号、会话和权限中间件，不得把旧 Access/邮箱身份代码带回来。P7 不能以真实数据接入为由破坏 P2–P6 已锁定的不变量。对外简短交接直接使用 `docs/NEXT_AI.md`。

## 阅读顺序

1. [AGENTS.md](../AGENTS.md)：工作约定与业务底线。
2. [DESIGN.md](DESIGN.md)：用户需求、口径、默认值和参考示例观察。
3. [DATA_MODEL.md](DATA_MODEL.md)：对象、数量金额约束与API规则。
4. [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)：P1–P7依赖、交付和验收。
5. [TESTING.md](TESTING.md)：先测试后生产代码、迁移锁、并发/原子性和阶段门禁。
6. [DEPLOYMENT.md](DEPLOYMENT.md)：本地与生产的区别、Cloudflare限制。

## 给下一位 AI 的短提示词

不要在这里维护第二份长提示词。直接复制 `docs/NEXT_AI.md` 给下一位 AI；本文件只保存完整背景和历史记录。

## 本地命令

```sh
npm ci
npm run dev
# 另一个终端，或停止开发服务器后：
npm run check
```

开发端口：5173/8787，集成测试使用独立端口和临时 D1。`npm run dev` 只应用本地迁移，不再注入账号 seed；空库首次进入登录页时使用一次性 bootstrap 创建管理员。生产资源ID未配置；`npm run build:worker`只是 dry-run 打包，不发布资源。

## 不能遗漏的设计细节

- 预算总额和预算发生流水是两回事，切换报表口径不能混加各账目。
- 需求物资分配表保证数量守恒；储备项目与框架子项目同ID。
- 混合类别项目按金额分摊，大类映射全系统共用；缺价不能变成零价。
- 历史实施可以没有出库，但必须显式标记；后续关联不能重复统计。
- 实施/结算独立、允许先结算；部分进度不等于全量完成。
- 提醒在服务端调度，关闭浏览器仍应执行。免费10ms是CPU时间，不是网络等待；异步不绕过CPU限制。
- 默认全球网络、不备案、不买服务器，不承诺大陆必然快速或固定香港路由。
- 不共享资产所有者 Cloudflare 密码/Global API Key/个人长期 Token。业务管理员在应用内管理成员；技术维护人使用自己的 Cloudflare Account Member 身份；生产 CI 最终使用 account-owned API token。
- 业务认证不依赖 Cloudflare Access、邮箱或邮箱验证码。管理员预建 username + 初始密码 + 角色/范围；首次登录强制改密。忘记密码联系管理员重置。

## 外部材料与待验证项

- 可读参考：https://www.workbuddy.link/p/plhvulKoyaQX5vic8Oaeoy?source=2 。仅作为功能和布局参考。
- 尚缺：原始需求Excel、“一年工作早知道”、“项目储备类别”、真实单价/框架/协议资料。
- 尚缺：生产 Cloudflare 账户资源、可用自定义域名、正式运行时 Secrets 和后续通知收件资料。
- 未测：真实 Cloudflare Workers CPU/配额与目标地区网络、低性能手机 Argon2id 体验、真实文件映射、真实发信、正式环境恢复与运维移交；这些全部属于 P7。
- P4 完整本地门禁已全绿：70/70 Node/workerd+D1 + 38/38 Vue/Vitest，共 108 项；覆盖 P1.2/P2/P3 全量回归、P3→P4 数据保留、预算/发生分离、协议归属、预算版本、冲销、并发/幂等、精确阈值、105+ 流水游标分页和 `/finance` 页面合同。CI 实际结果以仓库 Actions 为准。

## 后续交接记录

### P1 · 2026-09-12

- 主要实现提交：`4880918`（`feat: complete P1 identity and app framework`）。
- 完成：Access JWT 鉴权；成员角色/范围；基础设置版本；字典、审计与幂等；Vue Router + Naive UI 应用壳；规则与成员读取页；本地 seed 与 P1 集成测试。
- 测试：从空本地 D1 执行 `npm run check` 全绿，9/9 集成测试 PASS；前端路由拆包后主包约 363KB；生产模式缺 Access 配置实测 fail-closed（503）。
- 未验证：真实 Access 租户、线上资源、正式成员名单；不影响进入 P2，本事项留生产部署/P7 验证。
- 后续设计更新：新增 P1.1，补齐成员新增/编辑/范围授权、首次登录状态、首管理员 bootstrap、最后管理员保护，并建立可完全移交的运维责任边界。

### P1.1 · 2026-09-12

- 主要实现提交：`1b8139c`（`feat: complete P1.1 member management handover`）。
- 完成：成员新增/编辑/启停、角色与 `all/framework/project` 范围；成员邀请/首次/最近登录生命周期；一次性首管理员 bootstrap；最后一个启用管理员保护；完整前端成员管理界面。
- 数据：当时采用追加式 `0002_p1_1_member_lifecycle.sql` 和本地 seed；P1.2 按用户明确要求在尚未上线阶段重整开发 schema 后，这些历史文件已从当前仓库删除。
- 运维：新增 `docs/OPERATIONS_HANDOVER.md`，将资产所有者、应用管理员、技术运维负责人和 CI/CD 服务身份分离；正式 Cloudflare/GitHub 移交演练仍留 P7。
- 测试：当时 `npm run check` 全绿，12/12 workerd+D1 集成测试 PASS。
- 此阶段的 Access/邮箱认证结论已被 P1.2 取代；成员角色、范围、最后管理员保护和审计继续沿用。

### P1.2 · 2026-09-12

- 主要实现提交：`ad05dd0`（`feat: replace Access with local account authentication`）。
- 完成：系统自维护 username、一次性首管理员 bootstrap、登录/退出、首次强制改密、管理员重置密码、5 次失败临时锁定、7 天 HttpOnly 会话、停用/改密/重置撤销旧会话。
- 凭据：浏览器 Web Worker 使用 Argon2id（19 MiB / t=2 / p=1 / 32 bytes），服务端只计算 `HMAC-SHA256(AUTH_CREDENTIAL_PEPPER, derivedCredential)`；数据库不保存明文密码或浏览器派生凭据。
- 数据：按“尚未上线、无需兼容”决定重整当前 `0001`；删除旧 `0002` 和账号 seed，`members` 直接承载 username/credential/session_version 等字段，新增 `auth_sessions`。
- 安全：生产不读取 Cloudflare Access JWT 或开发身份头；最后管理员保护升级为数据库条件写入；修复成员 PATCH 审计 SQL 占位符导致的错误 409。
- 测试：`npm run check` 全绿，31/31 Node/workerd+D1 + 11/11 Vue，共 42 项 PASS；Argon2 worker/WASM 正常生产构建，Worker dry-run PASS。
- 未验证：真实 Cloudflare 线上 CPU/配额/网络，以及低性能手机 Argon2id 交互体验，留 P7。
- 后续状态：P2 stash 已于同日 apply 到工作区并完成恢复；该恢复备份在 P4 开始前已按用户要求删除。恢复历史见 `docs/P2_RECOVERY_STATUS.md`。

### P2 · 2026-09-12

- 主要实现提交：`24abfa0`（`feat: complete P2 demand import and material workflow`）。
- 完成：浏览器 Web Worker 解析 `.xlsx`/UTF-8 `.csv`，多工作表与源行号保留；`.xls` 明确拒绝。支持字段自动/人工映射、映射模板、文件 SHA-256、20 行上传分片、20 行校验分片和 10 行发布分片。
- 数据/API：新增物资字典、导入模板/批次/源行、需求与需求物资表；支持批次恢复、错误/警告分类、来源文件/工作表/行追溯、需求分页列表/详情和标准物资新增/查询。相同业务内容但不同来源只提示疑似重复，不自动删除。
- 一致性：chunk/validate/publish 请求必须携带 `expectedVersion`；事务首语句用版本/状态守卫让 stale version 成为真实事务失败，再执行源行/需求写入和幂等记录。并发上传、并发校验、并发发布均有回归测试，失败请求不会留下半批写入。
- 迁移：`0002_p2_import_demands_materials.sql` 已加入 checksum 锁；P1.2→P2 升级测试确认成员、scope、活动会话、自定义设置和审计记录保留。
- 前端：`/demands` 已从占位页切换到真实 `DemandsView` 并懒加载；页面支持导入、映射模板、需求列表/详情与标准物资。懒加载后主入口 JS 约 458.65 kB，P2 页面约 62.74 kB。
- 测试：完整 `npm run check` 全绿，43/43 Node/workerd+D1 + 26/26 Vue/Vitest，共 69 项 PASS；TypeScript、Vite 生产构建和 Worker dry-run 同时通过。
- 未验证：真实 5 万行业务文件、真实 Cloudflare D1/Workers 配额、目标地区网络与低性能设备仍留 P7，不据本地合成测试宣称正式上线。
- 下一步：P3 储备转换。先把数量分配守恒、并发超分配、相同型号不同单位、缺价/零价、分类金额守恒等不变量写成失败测试，再实现生产表/API/UI。

### P3 · 2026-09-12

- 主要实现提交：`bd6e7d2`（`feat: complete P3 reserve conversion workflow`）。
- 完成：储备候选/归并建议、部分数量分配与剩余数量、项目草稿/列表/详情、物资汇总和来源追溯、估算与完整度、储备大类/类别映射、分类金额分摊、确认版本与历史；候选池支持游标分页，归并建议按完整剩余池聚合。
- 一致性：数据库事务守卫保证需求物资有效分配不超过原始数量；60/40 拆分、并发 60/60、重复提交、分配调整及 stale version 均有回归。相同型号不同单位独立汇总。
- 金额：数量/单价使用万分之一缩放，金额存整数分；物资金额以 BigInt 精确乘算并四舍五入到分，`null` 单价与显式 0 分离，固定费用及项目总额超安全整数时拒绝。
- 分类/版本：每条已知费用的分类分摊必须完整守恒；需求类别映射可给费用行建议。确认时保存完整不可变快照与原因，调整后再次确认产生新的储备版本。
- 前端：`/reserves` 已从占位页切换为懒加载真实页面，覆盖选择需求、建立草稿、估算/分类、确认四步；只读成员只查看不写入。
- 迁移：`0003_p3_reserve_projects.sql` 已加入 checksum 锁；P2→P3 数据保留测试确认需求、标准物资与来源信息不丢失。
- 测试：完整 `npm run check` 全绿，58/58 Node/workerd+D1 + 32/32 Vue/Vitest，共 90 项 PASS；生产 Web 构建和 Worker dry-run 通过。
- 未验证：真实业务文件/单价/分类映射、真实 Cloudflare 配额及目标地区网络仍留 P7。
- 下一步：P4 框架、协议、预算与费用流水。优先测试预算与预算发生严格分离、协议/框架归属、金额守恒、90%/80%边界、并发与幂等。

### P4 · 2026-09-12

- 主要实现提交：`17ffcea`（`feat: complete P4 finance workflow`）。
- 完成：框架/协议当前态及历史版本、项目框架归属、预算草稿/确认版本、多协议预算分配、预算发生/实际发生独立流水、冲销与资金汇总；`/finance` 为真实懒加载页面。资金流水最多每页 100 条使用不透明游标继续读取，汇总按协议集合聚合，避免 N+1。
- 一致性：预算确认只写不可变预算版本和协议分配快照，不自动产生预算发生；当前汇总只计最新确认版本。跨框架协议、无有效协议、金额分摊不守恒均拒绝。
- 流水：同一协议可服务多个项目，一个项目可拆多个同框架协议；预算发生与实际发生独立统计。冲销保留原流水并写负数更正，一条原流水最多冲销一次。
- 阈值：协议使用率精确达到 90%、框架预算发生精确达到 80% 才预警；显示四舍五入不参与判定。预算合计仅大于框架总额时预警，等于不预警；0 分母为未配置。
- 并发/幂等：框架、协议、项目归属和预算更新使用 `expectedVersion` + D1 batch guard；同键重放在版本/状态判断前返回已存响应，不重复版本或流水。
- 迁移：`0004_p4_finance.sql` 已加入 checksum 锁；P3→P4 升级测试确认储备项目、需求分配和储备确认版本不丢失。
- 测试：完整 `npm run check` 全绿，70/70 Node/workerd+D1 + 38/38 Vue/Vitest，共 108 项 PASS；生产 Web 构建与 Worker dry-run 通过。主入口约 458.90 kB，`FinanceView` 约 20.09 kB。
- 未验证：真实框架/协议/预算资料、真实云配额与目标地区网络仍留 P7。
- 下一步：P5 出库、实施、结算与四状态反馈。优先测试分批范围、部分完成、先结算后实施、撤销重算、历史实施不造出库、已有出库不可被储备修改静默覆盖。

### P5 · 2026-09-12

- 主要实现提交：`8093a00`（`feat: complete P5 delivery lifecycle workflow`）。
- 完成：分批出库及范围快照、正常实施、历史实施补录与后续关联、结算/结算覆盖/撤销、需求与项目四状态投影、结算待办、私有 R2 附件；`/delivery` 为真实懒加载页面。
- 范围守恒：出库不能超过项目当前需求分配；正常实施不能超过已出库范围。P3 修改项目需求分配时读取 P5 历史保护下限，不能缩小到已出库、已实施或有效结算事实以下；P3/P5 写入统一推进 `projects.version`，并发不能绕过保护。
- 历史实施：可先不关联项目和出库，后续显式关联项目/需求物资；不会补造出库，幂等重放与重复关联不会重复统计。
- 状态：实施与结算独立，允许先结算后实施。只有全部范围实施完成才算“已实施”；只有全部有效范围覆盖完整且存在有效最终结算才算“已结算”。非最终结算即使覆盖 100% 仍保持未结算；已有非最终覆盖完整时允许 0 元、空新增覆盖的最终确认收口。
- 待办：实施全部完成且尚未最终结算完成时生成默认 30 天结算待办；最终结算完成关闭，撤销后重新打开并按原实施完成日计算到期日。
- 附件：项目/出库/实施/结算附件存私有 R2，单文件最大 10 MiB；下载重新校验项目范围，跨项目拒绝；元数据事务失败会清理已上传 R2 对象。
- 迁移：`0005_p5_delivery_implementation_settlement.sql` 已加入 checksum 锁；P4→P5 升级测试确认框架、预算版本和资金流水历史不丢失。
- 测试：完整 `npm run check` 全绿，80/80 Node/workerd+D1 + 43/43 Vue/Vitest，共 123 项 PASS；生产 Web 构建和 Worker dry-run 通过。主入口约 459.00 kB，`DeliveryView` 约 19.83 kB。
- 未验证：真实出库/实施/结算历史、真实附件规模、真实 D1/R2 配额和目标地区网络仍留 P7。
- 下一步：P6 分析、提醒与备份。优先测试月/季度时间边界、计划/实际口径、0 分母、历史报表版本、提醒幂等/租约/重试以及备份可恢复性。

### P6 · 2026-09-12

- 主要实现提交：`3f4a62d`（`feat: complete P6 analysis notifications and backups`）。
- 完成：分析规则/月计划/季度进度、月报修订快照、子项目缺口、储备剩余分析、年度事项、预警生命周期、通知 outbox 与服务端 cron、D1→R2 分片备份和独立 D1 实际恢复；Dashboard 与 `/analysis` 均使用真实 API 数据。
- 预警：首次 crossing、持续期间每日摘要、recovery、同周期 recross 均有自动测试；通知领取使用租约，失败指数退避，provider 结果不确定记 `unknown`，避免无限重复发送。
- 后台：Worker `scheduled()` 每 5 分钟执行 P6 tick；未配置 `NOTIFICATION_DELIVERY_URL` 时 outbox 保持 pending，关闭浏览器不影响分析/通知/备份后台任务。
- 备份：按表和 100 行分片导出至私有 R2，保存 chunk SHA-256 与 manifest；测试已把 manifest/chunk 回灌到第二个独立临时 D1 并对账核心业务事实，且不恢复 `auth_sessions`。
- 前端：ECharts 采用按需注册并动态拆包，`AnalysisView` 约 19.48 kB（gzip 6.25 kB），独立图表运行块约 488.44 kB（gzip 164.84 kB）；Worker dry-run 上传约 411.87 KiB（gzip 78.17 KiB）。
- 测试：分段完整门禁全绿，93/93 Node/workerd+D1 + 48/48 Vue/Vitest，共 141 项 PASS；TypeScript、Vite 生产构建、Worker dry-run 均通过。当前工具单次 300 秒限制导致完整 `npm run check` 不宜单次运行，因此 Node 测试按全部 `tests/*.test.mjs` 文件组分段实际跑完，无跳过。
- 未验证：真实 Excel/年度事项/分类文件、真实邮件供应商与域名、真实 Cloudflare CPU/免费额度、目标地区网络、正式环境恢复、Cloudflare/GitHub 运维移交和正式发布，全部进入 P7。
- 下一步：P7 仅做真实数据与正式环境验收/上线，不扩写新业务功能；任何口径差异先回到现有设计和不变量核对，不能用真实数据接入覆盖历史事实。

每完成阶段在此追加：阶段、提交号、完成内容、测试、未完成/未验证项和明确下一步。不要删除原始边界说明。

### P7 离线准备 · 2026-09-12

- 完成：非 Secret production config 模板与拒绝占位/错误绑定/旧认证的校验；13 项真实验收记录模板/结构检查；私有文件哈希清单；P6 manifest/chunk/附件存在性离线检查；发布、迁移、停写备份、隔离恢复、回退和运维撤权手册。
- CI：普通 push 仍只验证；新增手工 production preflight 仅 dry-run，不使用云 Token。生产部署模板位于 workflows 外，必须另行授权、配置并验证 Environment 保护后才可启用。
- 缺陷：真实 Excel 准备审计发现解析器忽略空行和 used-range 起点会偏移物理来源行。两个回归先复现失败，再修复保留真实行号且过滤空行；不自动改写旧批次。
- 验证：完整单次 `npm run check` 成功（Node 测试约 228 秒），100/100 Node/workerd+D1 + 50/50 Vue/Vitest，共 150/150 PASS；TypeScript、Vite build、Worker dry-run PASS；production 示例独立 dry-run PASS；3 份 workflow YAML 语法解析 PASS；空验收记录按预期退出 2，占位 production config 按预期退出 1。
- 迁移影响：无 schema/迁移改动；认证与 P2–P6 后端数量、金额、版本、幂等、并发和状态实现保持不变。
- 未完成：P7-01～13 真实验收仍缺原件、生产资源/授权、Secret、邮件适配器/域名、CPU/额度与现场网络、真实恢复/发布/撤权证据。没有创建资源、部署或发送邮件，未使用生产 Secret。
- 下一步：按 `docs/P7_RUNBOOK.md` 和矩阵采集真实证据；JSON 记录结构通过不能代替真实验收。备份不具备跨表快照隔离，正式迁移前需可靠停写并隔离恢复对账。
