# 数据关系与接口约定

这是一份实现约定。长期业务事实见 `BUSINESS_BASELINE.md`。当前模型先以 `voltage_levels → transmission_lines → transmission_towers` 形成统一基础台账，再由 `demands` 保存结构化位置引用；需求本体仍是纯抽象业务事项，可带 0..N 条需求物资子明细。项目储备通过 `project_demand_links` 记录需求来源，同时用独立的 `project_material_requirements` 维护项目当前物资；项目通过一次 `project_releases` 项目级出库进入执行阶段，随后拆分为 1..N 个 `project_tasks`，每个任务的物资供应、现场实施、结算三条线独立推进，并由任务事实回投需求四状态。旧 `demand_allocations`、`release_batches/release_lines`、旧 implementation/settlement 表仅保留历史兼容与旧数据备份，不再是最终业务主模型。使用 D1/SQLite，不依赖 PostgreSQL 专有语法。

## 1. 通用约定

- 主键使用服务端生成的 UUID 文本；原始 Excel 序号不能作为全局主键。
- 时间戳为 UTC ISO 8601；业务日期为 `YYYY-MM-DD`，业务月份为 `YYYY-MM`，业务时区 `Asia/Shanghai`。
- 金额存为整数分 `amount_fen`，API同样用整数；输入输出时检验 JS 安全整数范围。比例以基点表示（10000=100%）。
- 数量存为整数万分之一单位 `quantity_scaled`（10000=1单位），数量精度最多4位小数。超出精度拒绝并要求明确修正，不静默舍入。
- 单价用整数万分之一元 `unit_price_scaled`，允许 `null` 表示未知；明细金额以精确整数运算四舍五入到分，再求和。`null`和0不同。
- 可变对象有 `version`、`created_at`、`updated_at`、操作者；已确认记录通过修订/撤销/冲销处理。历史引用采用ID及快照，不依赖可修改名称。
- 类别扩展字段按版本化字段定义存JSON，受服务端校验；经常查询的核心字段单独建列和索引。
- 正式版本只保留一份当前生效记录；历史版本不参与当前总额重复求和。

## 2. 对象与关系

| 对象（建议表） | 核心内容 | 关系/约束 |
|---|---|---|
| members / member_scopes | 唯一 username、显示姓名、角色、启用状态、授权范围、Argon2id salt/KDF 参数、服务端 HMAC verifier、强制改密、失败计数/锁定、session_version、邀请/首次/最近登录时间 | username 大小写不敏感唯一；邮箱不在认证模型；浏览器派生凭据不入库；停用立即撤销会话；至少保留一个启用管理员 |
| auth_sessions | 随机会话 token 的 SHA-256 哈希、member_id、session_version、创建/最近访问/到期/撤销时间 | 原始 token 只存在浏览器 HttpOnly Cookie；默认 7 天绝对有效期；停用/改密/重置立即失效 |
| settings_versions | 口径、阈值、目标、提醒参数、生效时间 | 每个报表/预警引用规则版本 |
| voltage_levels | 电压等级编码、显示名、交流/直流制式、标称 kV、排序、启停、版本 | 统一电压对象；名称/编码唯一；被业务引用后制式/标称电压受保护 |
| transmission_lines | 所属电压等级、当前线路名称/编码、名称有效期起点、启停、版本、`tower_order_version` | `VoltageLevel 1:N TransmissionLine`；稳定 `line_id` 才是身份；名称允许重名/复用/更名；被需求引用后不能换所属电压等级 |
| transmission_line_name_history | 线路ID、历史名称、有效起止、修改人、原因 | 更名历史可多条、可与其他线路重名；用于旧名搜索和时间轴追溯 |
| transmission_towers | 所属线路、规范化当前杆塔编号、编号有效期起点、独立 `sort_rank`、类型、启停、版本 | `TransmissionLine 1:N TransmissionTower`；稳定 `tower_id` 才是身份；编号允许重名/复用/更名；同线路当前 `sort_rank` 唯一 |
| transmission_tower_no_history | 杆塔ID、当时所属线路、历史编号、有效起止、修改人、原因 | 旧编号可搜索、多对象可命中；更名不改变 `tower_id` 或既有业务引用 |
| import_batches / import_rows | 文件哈希、工作表、映射版本、源行、原始JSON、错误、发布状态 | 批次分片幂等；未发布行不得计入正式报表 |
| demand_categories / field_definitions | 需求类别、模板/扩展字段定义、字段类型、版本 | 当前需求成立必填核心为序号和结构化位置；物资是 0..N 子明细，不能因旧字段定义把物资重新变成需求成立前提 |
| demands | 抽象业务事项：`source_type=import/manual`、业务年份、类别、负责人，以及 `voltage_level_id`、`line_id`、`location_type`、起止杆塔对象；同时保留对象生成的显示快照 | 需求无需物资即可成立；正式位置只能来自基础台账；同一业务事项可由多个 Excel 来源行共同形成 |
| demand_source_rows | 需求ID、源 import_row、文件哈希、工作表、物理行、原始JSON | 多个来源行可归到同一个抽象需求；保留完整来源追溯 |
| materials | 标准编码、名称、型号、单位 | 原始型号通过人工确认映射；单位不同时不能直接汇总 |
| demand_materials | 需求ID、原始型号、标准物资ID、数量、单位、来源行、版本 | 一需求可有 0..N 条物资子明细；这些只是需求阶段已知信息，不构成项目物资上限 |
| projects / project_versions | 项目名称、年度、阶段、框架ID、负责人、储备版本 | 同一个项目ID用于储备和框架子项目；只属于一个框架；允许无项目物资时先建立 |
| project_demand_links | 项目ID、需求ID | 仅表达项目由哪些抽象需求形成，不继承需求物资数量 |
| project_material_requirements / project_material_revisions | 项目自己的型号、单位、数量、单价、储备大类、版本；每次调整前后快照和原因 | 可后补、增减、换型；已分配到任务的历史事实形成保护下限 |
| project_releases | 项目ID、出库日期、项目/储备版本、需求与项目物资快照 | 每个项目只做一次项目级出库；不是仓库发货，也没有逐物资出库行 |
| project_tasks / task_demand_scopes | 出库项目下的任务、现场范围、负责人、计划量，以及任务覆盖的抽象需求数量 | 只有项目级出库后才能创建；一个项目可有多个任务；需求范围用于回投实施/结算状态 |
| task_material_requirements / material_supply_events | 任务物资、需求量、供应版本；已上报/已发货/已到货事件 | 任务物资来自项目物资但有独立数量；累计满足 到货<=发货<=上报<=任务物资需求 |
| task_implementation_* | 任务实施记录、需求范围完成量、实际物资使用 | 与供应/结算独立版本推进；部分完成不等于全部实施 |
| task_settlements / task_settlement_* | 任务结算金额、需求范围覆盖、最终标记、协议金额分摊、结算提醒 | 可先于实施发生；最终结算必须覆盖任务全部需求范围；首次实施后形成结算提醒 |
| legacy demand_allocations / release_batches / release_lines / implementation_records / settlements | 旧 P3/P5 历史模型 | 仅用于历史数据兼容、旧回归和备份恢复；新页面与最终业务 API 不再读写这些表 |
| frameworks / framework_versions | 框架编号、名称、有效总额度、期间、年度目标 | 按生效版本统计；修改额度不重写历史报告 |
| agreements / agreement_versions | 所属框架、协议额度、有效期、状态 | 同框架才能支持子项目；历史发生保留原协议版本 |
| project_budgets / budget_allocations | 子项目预算版本、生效状态、分配到协议的金额 | 已确认预算分配合计=预算总额；草稿可不完整 |
| financial_entries / financial_entry_allocations | 类型、业务日/月、项目、确认金额、冲销关联、协议分摊 | 类型至少 `budget_occurrence`、`actual_cost`；每条协议分摊合计=条目金额 |
| settlements / settlement_coverage | 结算金额、日期、项目、协议金额分摊、覆盖需求范围、最终标记 | 最终结算由明确范围确认，不以等于预算推断 |
| reserve_categories / category_mappings | 大类、需求类别映射、项目性质、版本 | 多需求类别可归一个大类；性质与大类分开 |
| category_cost_allocations | 费用明细、大类、分摊金额 | 分摊合计等于该明细已知金额；共同费用人工确认 |
| annual_milestones | 年度、事项、日期精度、月份/日期、负责人、关联项目、完成状态 | 月份精度不补造具体日；完成后停止待办提醒 |
| monthly_plans / report_snapshots | 对象、月份目标、口径、生效版本、报告修订 | 同期计划与实际可复核；保留历史报告 |
| alert_events / notification_outbox | 规则、对象、事件、收件人、状态、领取租约、重试次数、下次时间 | 唯一通知键防重复；发送结果未知单独留痕 |
| attachments | 私有R2键、版本、文件名、大小、所属对象、上传人、删除时间 | 服务端授权下载；无公开永久链接 |
| audit_events / idempotency_records | 操作、操作者、前后版本、请求键、结果 | 不记录密钥；复用请求键但内容不同返回冲突 |

项目阶段与需求四状态不同：项目阶段体现储备/出库/实施进度；需求四状态由实施和结算独立投影。不能用一个顺序枚举同时代替两者。

## 3. 基础台账与需求位置不变量

- `transmission_lines.voltage_level_id` 必须指向存在的电压等级；启用新线路时父电压必须启用。
- `transmission_towers.line_id` 必须指向存在的线路；启用新杆塔时线路和父电压都必须启用。
- 正式需求的 `line_id` 必须属于 `voltage_level_id`；`whole_line` 起止为空，`tower` 起止相同，`tower_range` 起止不同且在创建/发布时满足 `start.sort_rank < end.sort_rank`。正式需求保存稳定 `line_id/start_tower_id/end_tower_id`，后续名称/编号/排序变化不能替换对象身份。
- 手工创建和 Excel 发布都必须在同一写事务中重新校验父子关系、启用状态和显示快照，避免“校验后停用/改名”的竞态。
- 线路已有需求引用后不能更换电压等级；杆塔不允许通过普通编辑切换所属线路。线路/杆塔更名必须走专用历史化动作，杆塔排序通过独立 `tower_order_version` 控制并允许调整；删除仍按业务引用保护。历史需求依赖稳定 ID 和来源/显示快照追溯，而不是冻结当前名称或顺序。
- 停用不破坏历史读取；新需求和导入发布不得选择停用对象。
- 当前开发阶段数据库只有 `0001_initial_schema.sql` 一个可重建基线；除非用户明确要求兼容已有数据/保留升级路径，否则 schema 变化直接修改 `0001` 并重建开发/测试数据库，禁止新增 `0002+` migration。

## 4. 必须保持的不变量

1. 需求是抽象业务事项，不存在“需求数量必须分配完”的总量守恒。需求物资子明细只是需求阶段已知信息；项目需求来源关系和项目物资是两类独立事实，项目物资数量不得被需求物资数量隐式限制。
2. 同一笔费用不会因多类别、多协议、多需求关联而倍增。关联金额/数量必须显式分摊。
3. 框架“已发生”来自指定口径的已确认条目，不能把预算总额、预支和结算简单相加。
4. 协议分配与条目属于同一框架，生效确认时协议有效。无效协议可以保留历史记录。
5. 提示阈值不是硬上限。超过90%、80%、总预算超框架可产生预警；不能因此未经要求禁止录入。无协议、非法归属、数量超分配和重复写入属于数据校验错误。
6. 不以浮点累计金额。单价×数量在整数/精确十进制中计算，统一舍入到分，合计按已舍入明细求和。
7. 缺价格的项目既展示已知小计，也展示待估价覆盖，不能当作完整估算参与无提示排名。
8. 金额条目确认、汇总更新、审计和待发事件尽量在同一D1事务完成。D1支持 `batch()` 失败整体回滚；不要用多次独立请求模拟开放事务。
9. 版本条件更新未命中必须显式转成冲突/事务失败；仅返回 `changes=0` 不等于 `batch()` 失败，不得随后继续产生孤立流水。
10. 只读缓存、报表快照不是金额唯一真相；需能由有效流水重建并对账。
11. 生产账号只能由一次性 bootstrap 或已授权管理员显式创建；不存在开放注册、邮箱自动建号或首次访问自动升权。
12. 成员停用、角色和范围变更必须可审计；不能停用或降权最后一个启用管理员。历史业务记录引用停用成员仍然有效，不通过硬删除破坏审计链。
13. `username` 是唯一登录标识；邮箱不属于当前认证 schema。正式 API/UI 都不得把邮箱或请求头身份解释为业务账号。
14. 慢 KDF 只在浏览器 Web Worker 执行：Argon2id 当前参数为 `m=19456 KiB,t=2,p=1,hash=32,version=19`，每账号随机 16-byte salt。服务端只保存 `HMAC-SHA256(AUTH_CREDENTIAL_PEPPER, derivedCredential)` verifier 和公开 KDF 参数；不得保存明文密码或浏览器派生凭据，也不得在服务端执行 PBKDF2/Argon2。
15. 会话 token 至少 256 bit 随机，数据库只存 token SHA-256 哈希。每次鉴权检查会话未撤销/未过期、session_version 一致和成员启用；停用、改密或管理员重置密码必须使旧会话失效。
16. `must_change_password` 为真时，只允许 `/api/me`、改密和退出等最小接口，不能访问业务数据或成员管理。
17. P2 导入批次的 chunk/validate/publish 都必须携带当前 `expectedVersion`；版本/状态守卫、源行或需求写入、幂等记录必须处于同一个 D1 batch。stale version 或并发竞争失败不得留下源行、需求、需求物资、错误发布状态或孤立幂等记录。
18. 需求有 `import` 与 `manual` 两类真实来源。文件导入使用同一源文件 SHA-256 + 工作表 + 源行做来源幂等；手工新增使用独立手工来源键，不得伪造文件、工作表或行号。两种入口使用同一业务校验；业务字段相同但来源不同只能标记疑似重复供人工核对，不能自动删除合法需求。凡存在批量导入入口的业务数据，必须同时提供手工新增入口。
19. Excel 导入先识别抽象需求业务键，再把同一需求的多行规范化为一个 `demands` 和 0..N 条 `demand_materials`；没有物资型号/数量的需求行也可以合法发布。所有源行写入 `demand_source_rows`，不能因为归并而丢失来源追溯。
20. 项目储备的 `project_demand_links` 与 `project_material_requirements` 必须分开维护。关联需求只说明来源；项目物资可独立新增、换型、增减数量，并把每次调整的原因、前后快照写入 `project_material_revisions`。
21. 项目物资数量和单价使用定点整数：`required_quantity_scaled` 为万分之一单位、`unit_price_scaled` 为万分之一元，明细金额精确四舍五入到分；`unit_price_scaled=null` 表示未知，0 表示明确零价。同一型号不同单位不得合并。
22. 当前储备类别金额只统计尚未发生项目级出库的当前有效 `project_material_requirements`。施工费/其他费不强行摊入项目物资储备大类；缺价物资单独计数，不当作零价。
23. 储备确认写入不可变 `project_versions` 快照并递增 `reserve_version`；后续项目物资调整回到草稿并形成新的修订历史，再次确认生成新版本，不能覆盖旧快照。
24. P4 预算草稿与预算发生流水是不同事实。预算确认只生成不可变 `budget_versions` 和协议分配快照，不得自动插入 `financial_entries`；框架当前预算合计只计每个预算对象最新确认版本，旧版本仅留历史。
25. 预算确认和资金流水的协议分配必须属于项目当前框架，且在需要确认/发生的业务日期处于有效状态；分配金额合计必须精确等于预算/流水金额。同一协议可服务多个项目，同一项目可拆多个协议，但金额不得因关联数量重复放大。
26. `financial_entries` 仅保存独立口径的 `budget_occurrence` 与 `actual_cost`，原流水不硬删除。更正使用独立负数冲销记录并通过 `reverses_entry_id` 关联；同一原流水最多冲销一次。
27. 协议 90% 和框架 80% 警示使用整数交叉相乘判断真实比例，不得用四舍五入后的展示基点提前触发；预算合计仅在严格大于框架总额时提示超框架。0 分母返回未配置，不返回 Infinity 或伪造 100%。
28. P4 可变资金对象的 `expectedVersion` guard、历史版本、审计和幂等记录必须在同一 D1 batch 中。幂等重放应优先于因首次成功后产生的版本/状态冲突判断，确保相同键和相同 payload 返回原响应而不重复落账。
29. `project_releases` 是项目级进入执行阶段的一次性节点。只有已确认储备项目才能出库；出库保存当前项目需求来源和项目物资不可变快照，并推进 `projects.version`。新业务不得生成逐物资 `release_lines`。
30. 只有存在项目级出库后才能建立 `project_tasks`。同一项目可以建立多个任务；任务需求范围合计受项目需求关联约束，任务物资分配累计不得超过对应当前项目物资。项目物资已经分配到任务后，不得删除、换型或缩减到任务累计分配量以下。
31. 任务物资供应使用独立 `supply_version`，实施使用独立 `implementation_version`，结算使用独立 `settlement_version`；不同业务线互不要求先后顺序。供应累计必须满足 `arrived <= shipped <= reported <= required`；相同版本并发写只有一个成功。
32. 实施与结算分别按 `task_demand_scopes` 记录数量事实。部分完成只展示进度，不能把 60/100 判成完成；结算允许先于实施。最终结算必须覆盖任务全部需求范围；首次实施后创建/更新结算提醒，最终结算完成后关闭提醒。
33. 需求四状态由所有关联任务的需求范围事实回投：已实施已结算 / 已实施未结算 / 未实施已结算 / 未实施未结算。实施完成和结算完成是两个独立维度；项目状态由任务汇总。附件仍只存私有 R2 键并重新执行项目范围授权。
34. P6 月计划、规则和报告快照必须可版本追溯；历史月报保存当时的 rule version、规则 JSON 和完整 snapshot，当前规则修改不得覆写旧修订。年度目标为 0 时分析返回未配置。
35. P6 预警 crossing、持续 daily summary、recovery 与 recross 是不同生命周期事件；通知 outbox 使用唯一幂等键、领取租约、失败退避和 `unknown` 状态，结果不确定时不得无限重发。
36. P6 年度事项保留 `month/day/unknown` 日期精度；只有月份时不得补造具体日期。完成事项停止提醒。
37. P6 储备类别分析以“尚未发生项目级出库的项目当前物资”为口径，直接汇总当前有效 `project_material_requirements.amount_fen`；已项目级出库项目整体退出储备金额分析，不再按旧 `release_lines` 数量比例折算。施工/其他费用不进入项目物资储备类别。
38. P6 D1→`ObjectStorePort` 备份按表和小分片可续跑，每个 chunk 保存 SHA-256，完成后生成 manifest；实际恢复需从 manifest/chunk 回灌独立 D1 并对账，`auth_sessions` 不恢复。分片读取不具备跨表快照隔离；正式迁移前须停写并对账，manifest 只含附件 key，需另校验附件本体。当前 production provider 为 Notion，R2/Filesystem 为可替换实现。

建议索引至少覆盖：来源幂等键；需求年度/类别/线路；需求物资分配；框架和协议归属；项目及财务条目的业务月；到期且待处理的通知；附件所属对象。按实际查询计划验收读行数。

## 5. API 合同

当前已实现 P1/P1.2/P2/P3/P4/P5/P6 接口：

```http
GET /api/health
GET /api/auth/status
POST /api/auth/kdf
POST /api/auth/bootstrap
POST /api/auth/login
POST /api/auth/logout
POST /api/auth/change-password
GET /api/me
GET /api/members
POST /api/members
PATCH /api/members/:id
POST /api/members/:id/reset-password
GET /api/settings
GET /api/settings/:key/history
PUT /api/settings/:key
GET /api/dictionaries?key=...
GET /api/scopes/:scopeType/:scopeId/check
GET /api/import-mappings
POST /api/import-mappings
GET /api/materials
POST /api/materials
GET /api/master/voltage-levels
POST /api/master/voltage-levels
PATCH /api/master/voltage-levels/:id
DELETE /api/master/voltage-levels/:id
GET /api/master/lines?voltageLevelId=...
POST /api/master/lines
PATCH /api/master/lines/:id
DELETE /api/master/lines/:id
POST /api/master/lines/:id/rename
GET /api/master/lines/:id/name-history
GET /api/master/towers?lineId=...
POST /api/master/towers
PATCH /api/master/towers/:id
DELETE /api/master/towers/:id
POST /api/master/towers/:id/rename
GET /api/master/towers/:id/number-history
POST /api/master/lines/:lineId/towers/:towerId/move
POST /api/master/lines/:id/towers/import-chunk
POST /api/master/lines/:id/towers/reorder
POST /api/master/lines/:id/towers/batch   # 兼容/内部低层批量合同；产品 UI 不直接暴露技术排序字段
POST /api/imports
POST /api/imports/:id/chunks
POST /api/imports/:id/validate
GET /api/imports/:id
POST /api/imports/:id/publish
POST /api/demands
GET /api/demands
GET /api/demands/:id
POST /api/demands/:id/materials
GET /api/reserve-projects
POST /api/reserve-projects
GET /api/reserve-projects/:id
PUT /api/reserve-projects/:id/demands
PUT /api/reserve-projects/:id/materials
GET /api/reserve-projects/:id/material-revisions
POST /api/reserve-projects/:id/confirm
POST /api/project-releases
GET /api/project-releases
POST /api/project-tasks
GET /api/project-tasks
POST /api/task-material-supply-events
POST /api/task-implementations
POST /api/task-settlements
GET /api/projects/:id/execution
GET /api/demands/:id/execution
GET /api/reserve-categories
POST /api/reserve-categories
GET /api/category-mappings
PUT /api/category-mappings/:demandCategory
GET /api/finance/projects
GET /api/frameworks
POST /api/frameworks
PUT /api/frameworks/:id
GET /api/frameworks/:id/history
GET /api/agreements
POST /api/agreements
PUT /api/agreements/:id
GET /api/agreements/:id/history
PUT /api/projects/:id/framework
GET /api/budgets
POST /api/budgets
PUT /api/budgets/:id
POST /api/budgets/:id/confirm
GET /api/budgets/:id/history
GET /api/financial-entries
POST /api/financial-entries
POST /api/financial-entries/:id/reverse
GET /api/finance/summary
POST /api/attachments
GET /api/attachments
GET /api/attachments/:id/content
GET /api/analysis/dashboard
GET /api/analysis/reserve-remaining
GET /api/analysis/rules
PUT /api/analysis/rules
GET /api/analysis/plans
PUT /api/analysis/plans/:projectId/:year/:month
GET /api/analysis/frameworks/:id/progress
GET /api/analysis/projects/gaps
POST /api/reports/monthly
GET /api/reports/monthly
POST /api/milestones
GET /api/milestones
GET /api/milestones/due
PUT /api/milestones/:id/status
POST /api/alerts/evaluate
GET /api/alerts
POST /api/notification-contacts
GET /api/notification-contacts
GET /api/notification-outbox
POST /api/notification-outbox/claim
POST /api/notification-outbox/:id/result
POST /api/backups
GET /api/backups
POST /api/backups/:id/step
POST /api/backups/:id/verify
```

`/api/health` 当前仍返回 `stage: "p6"`，表示 P6 分析/提醒/备份能力层级，不代表继续采用旧 P5 数据模型。业务接口先验证系统自身会话 Cookie，再根据 D1 成员启用状态、角色和范围授权；不解析 Cloudflare Access JWT，也不信任任何请求头 username/email/role。最终业务链中，需求/储备/项目级出库由 `admin/project_manager` 管理；执行任务与实施/供应由 `admin/project_manager/implementation` 操作；任务结算由 `admin/project_manager/finance` 操作。P4 框架/协议/预算/资金流水权限维持原边界。附件及所有业务读取仍按 `all/framework/project` scope 服务端过滤。未知 `/api` 路径返回 JSON 404，不回退到前端 HTML。旧 `/api/projects` allocation、`/api/release-batches`、旧 implementation/settlement 接口仍为历史兼容面，不作为新 UI 或最终业务主路径。

P7 不新增另一套核心接口族；需求数据主路径使用系统生成的标准模板填报并回导，真实业务值用于抽样核对，不要求通过任意历史 Excel 反推字段结构。其余重点是用真实 Cloudflare/D1/当前对象存储/邮件资源和目标地区网络对上述合同做端到端验收，必要改动仍需保持现有不变量与版本/幂等约束。

通用响应沿用 `packages/shared` 的 `ApiResponse<T>`。列表默认50项、最大100项，返回 `items` 和不透明 `nextCursor`；P3 待分配候选池和 P4 资金流水都按该约束分页，归并建议与资金汇总在数据库内做集合聚合，不能通过逐对象 N+1 查询或单请求无限制返回全库。大导出同样使用分页。

每个创建/确认/出库/发生/结算等变更请求携带 `Idempotency-Key`；更新携带相应版本。P2 多步导入用批次 `expectedVersion`；储备项目用 `projects.version`；任务物资供应、实施、结算分别使用 `expectedSupplyVersion`、`expectedImplementationVersion`、`expectedSettlementVersion`，从而允许三条线独立推进。P4 资金对象继续使用自己的版本守卫。错误使用明确状态：400格式、401未认证、403无权限、404不存在、409版本/幂等冲突、422业务校验、429限流。接口不接受前端提交的汇总值、剩余数量、状态或最终权限判断为事实；这些均由服务端从有效事实明细重算。

每个阶段开始时先补齐该接口族的共享类型，再实现 API 和前端，保持类型、迁移和文档同步。生产鉴权只接受系统签发的服务端会话 Cookie；请求头 username、email、角色或 Cloudflare Access JWT 都不构成业务身份。
