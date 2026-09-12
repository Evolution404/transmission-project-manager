# 给下一位 AI 的交接

## 当前状态

P0、P1、P1.1、P1.2、P2 已完成并通过本地验收。业务登录现为系统自维护 `username + password`：浏览器 Web Worker 执行 Argon2id，服务端保存带运行时 pepper 的 HMAC verifier，并使用 7 天 HttpOnly 服务端会话。邮箱和 Cloudflare Access 均不参与业务认证。

P2 已完成 Excel/CSV 浏览器解析、字段映射模板、分片导入/校验/发布、需求池列表/详情、来源追溯和标准物资字典。chunk/validate/publish 都使用显式 `expectedVersion`；版本守卫、业务写入和幂等记录处于同一个 D1 batch，stale version 及并发上传/校验/发布的失败请求不会留下半批数据。`/demands` 已懒加载真实需求页，不再指向占位页。

P2 恢复阶段使用的 Git stash `wip P2 before P1.2 local account auth` 仍保留在本机作为备份，但当前代码和测试已经独立完成，不依赖 stash。`docs/P2_RECOVERY_STATUS.md` 只保留恢复历史和完成结论，不再是待办入口。

**下一步进入 P3：储备归并、数量分配、估算及分类。** Cloudflare 仍是托管路线，但不参与业务身份认证；继续保留 P1.2 的账号、会话和权限中间件，不得把旧 Access/邮箱身份代码带回来。对外简短交接直接使用 `docs/NEXT_AI.md`。

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
- 未测：真实 Cloudflare Workers CPU/配额与目标地区网络、低性能手机 Argon2id 体验、完整业务、真实文件映射、真实发信与恢复。
- P2 完整本地门禁已全绿：43/43 Node/workerd+D1 + 26/26 Vue/Vitest，共 69 项；覆盖 P1.2 认证回归、P1.2→P2 数据保留、浏览器表格解析、P2 workflow、需求追溯、物资字典、stale version 和并发写入原子性。CI 实际结果以仓库 Actions 为准。

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
- 后续状态：P2 stash 已于同日 apply 到工作区，冲突已解决；恢复历史见 `docs/P2_RECOVERY_STATUS.md`。

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

每完成阶段在此追加：阶段、提交号、完成内容、测试、未完成/未验证项和明确下一步。不要删除原始边界说明。
