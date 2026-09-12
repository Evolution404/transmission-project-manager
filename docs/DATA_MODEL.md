# 数据关系与接口约定

这是一份实现约定。P1.2 已将身份模型重整为系统自维护账号、浏览器派生凭据与服务端会话；P2 已实现导入批次、需求池、来源追溯与标准物资；P3 已实现储备项目、需求物资分配、估算、储备分类与确认版本；P4 已实现框架/协议版本、项目预算版本、预算发生/实际发生流水及资金汇总。当前开发 schema 不包含邮箱身份或 Cloudflare Access 认证字段。P5–P7 业务对象仍按阶段实现。表名和字段可在迁移中作不影响语义的细化；改变业务口径必须同步 DESIGN.md。使用 D1/SQLite，不依赖 PostgreSQL 专有语法。

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
| import_batches / import_rows | 文件哈希、工作表、映射版本、源行、原始JSON、错误、发布状态 | 批次分片幂等；未发布行不得计入正式报表 |
| demand_categories / field_definitions | 需求类别、字段类型、必填规则、版本 | 初始6个必备字段；扩展可配置 |
| demands | 来源、业务年份、线路、杆段、原始/核实电压、类别、负责人 | 同源业务ID可以关联版本；不按线路名直接去重 |
| materials | 标准编码、名称、型号、单位 | 原始型号通过人工确认映射；单位不同时不能直接汇总 |
| demand_materials | 原始需求ID、原始型号、标准物资ID、数量、单位 | 一需求可多物资；保留来源行关系 |
| projects / project_versions | 项目名称、年度、阶段、框架ID、负责人、储备版本 | 同一个项目ID用于储备和框架子项目；只属于一个框架 |
| demand_allocations | 需求物资ID、项目ID、已分配数量、有效版本 | 同一需求物资有效分配数量不超过需求量 |
| project_cost_lines | 项目版本、物资/施工/其他费、关联分配、单价、已知金额 | 物资费用可追溯数量；缺价不可当0 |
| release_batches / release_lines | 项目、出库日期、范围数量、需求/物资/预算快照 | 部分出库；已出库快照不可覆写 |
| implementation_records / implementation_lines | 日期、人员、完成量、实际用量、项目/出库/需求分配、历史标识 | 正常记录必须关联出库；历史记录可暂未关联项目 |
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

## 3. 必须保持的不变量

1. 需求数量 = 有效分配数量 + 未分配数量。每个分配的出库、实施范围可核对；历史未关联记录独立展示，关联后不重复计算。
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
18. 同一源文件 SHA-256 + 工作表 + 源行用于来源幂等；业务字段相同但来源不同只能标记疑似重复供人工核对，不能自动删除合法需求。未知标准物资保留原始型号并标警告，不能伪造成零价或已映射。
19. P3 的需求物资数量必须满足 `原始 quantity_scaled = 有效 demand_allocations 合计 + 剩余 quantity_scaled`。创建/替换分配的版本守卫、释放旧分配、写入新分配、审计和幂等记录必须处于同一个 D1 batch；并发竞争或 stale version 失败不能超分配或留下半笔数据。
20. P3 物资估算只使用定点整数：`quantity_scaled` 为万分之一单位、`unit_price_scaled` 为万分之一元，乘算使用精确整数并四舍五入到分。`unit_price_scaled = null` 表示未知，`0` 表示明确零价；任何固定费用或合计超过 JS 安全整数范围必须拒绝。
21. P3 同一型号不同单位不得合并。项目物资汇总和来源明细必须能反查到 `demand_materials`、需求线路/杆段以及源文件/工作表/行号。
22. 每条金额已知的 `project_cost_lines` 分类分摊合计必须精确等于该费用金额；共同费用允许拆分到多个 `reserve_categories`，但不能因多个类别重复增加项目金额。未知金额费用不能参与金额分摊。
23. 储备确认写入不可变 `project_versions` 快照并递增 `reserve_version`；后续修改当前项目只能形成新的草稿状态，再次确认生成新版本，不能覆盖旧快照。
24. P4 预算草稿与预算发生流水是不同事实。预算确认只生成不可变 `budget_versions` 和协议分配快照，不得自动插入 `financial_entries`；框架当前预算合计只计每个预算对象最新确认版本，旧版本仅留历史。
25. 预算确认和资金流水的协议分配必须属于项目当前框架，且在需要确认/发生的业务日期处于有效状态；分配金额合计必须精确等于预算/流水金额。同一协议可服务多个项目，同一项目可拆多个协议，但金额不得因关联数量重复放大。
26. `financial_entries` 仅保存独立口径的 `budget_occurrence` 与 `actual_cost`，原流水不硬删除。更正使用独立负数冲销记录并通过 `reverses_entry_id` 关联；同一原流水最多冲销一次。
27. 协议 90% 和框架 80% 警示使用整数交叉相乘判断真实比例，不得用四舍五入后的展示基点提前触发；预算合计仅在严格大于框架总额时提示超框架。0 分母返回未配置，不返回 Infinity 或伪造 100%。
28. P4 可变资金对象的 `expectedVersion` guard、历史版本、审计和幂等记录必须在同一 D1 batch 中。幂等重放应优先于因首次成功后产生的版本/状态冲突判断，确保相同键和相同 payload 返回原响应而不重复落账。

建议索引至少覆盖：来源幂等键；需求年度/类别/线路；需求物资分配；框架和协议归属；项目及财务条目的业务月；到期且待处理的通知；附件所属对象。按实际查询计划验收读行数。

## 4. API 合同

当前已实现 P1/P1.2/P2/P3/P4 接口：

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
POST /api/imports
POST /api/imports/:id/chunks
POST /api/imports/:id/validate
GET /api/imports/:id
POST /api/imports/:id/publish
GET /api/demands
GET /api/demands/:id
GET /api/projects/candidates
GET /api/projects/suggestions
GET /api/projects
POST /api/projects
GET /api/projects/:id
PUT /api/projects/:id/allocations
PUT /api/projects/:id/costs
PUT /api/projects/:id/category-allocations
POST /api/projects/:id/confirm
GET /api/projects/:id/history
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
```

`/api/health` 当前返回 `stage: "p4"`。业务接口先验证系统自身会话 Cookie，再根据 D1 成员启用状态、角色和范围授权；不解析 Cloudflare Access JWT，也不信任任何请求头 username/email/role。成员角色、启停和范围继续受服务端权限、版本/幂等/审计约束；最后一个启用管理员不可被停用或降权。P2/P3 生产写接口继续由 `admin/project_manager` 管理；P4 框架/协议结构写入为 `admin/project_manager`，预算和资金流水允许 `finance` 在其业务范围内操作；所有读写仍按 `all/framework/project` scope 服务端过滤。未知 `/api` 路径返回 JSON 404，不回退到前端 HTML。

其余待实现接口族：

| 接口族 | 能力 |
|---|---|
| `/api/projects`（后续扩展） | P5 增加出库批次；不得重做或绕过 P3/P4 已有储备身份、框架归属和预算版本 |
| `/api/implementations`、`/api/settlements` | 分批记录、历史导入关联、确认与更正 |
| `/api/reports`、`/api/milestones`、`/api/alerts` | 汇总、月报、年度事项、待办和预警 |
| `/api/attachments` | 私有文件分片上传、元数据、授权下载 |

通用响应沿用 `packages/shared` 的 `ApiResponse<T>`。列表默认50项、最大100项，返回 `items` 和不透明 `nextCursor`；P3 待分配候选池和 P4 资金流水都按该约束分页，归并建议与资金汇总在数据库内做集合聚合，不能通过逐对象 N+1 查询或单请求无限制返回全库。大导出同样使用分页。

每个创建/确认/出库/发生/结算等变更请求携带 `Idempotency-Key`；更新携带 `version`。P2 的多步导入、P3 的项目分配/估算/分类/确认，以及 P4 的框架/协议/项目归属/预算更新都使用 `expectedVersion` 显式推进对象版本。错误使用明确状态：400格式、401未认证、403无权限、404不存在、409版本/幂等冲突、422业务校验、429限流。接口不接受前端提交的汇总值、剩余数量、最终金额、使用率或最终权限判断为事实；这些均由服务端从有效版本与流水明细重算。

每个阶段开始时先补齐该接口族的共享类型，再实现 API 和前端，保持类型、迁移和文档同步。生产鉴权只接受系统签发的服务端会话 Cookie；请求头 username、email、角色或 Cloudflare Access JWT 都不构成业务身份。
