# 给下一位 AI 的交接

## 当前状态

P0、P1、P1.1、P1.2 已完成并通过本地验收。业务登录现为系统自维护 `username + password`：浏览器 Web Worker 执行 Argon2id，服务端保存带运行时 pepper 的 HMAC verifier，并使用 7 天 HttpOnly 服务端会话。邮箱和 Cloudflare Access 均不参与业务认证。

P2 的认证改造前 WIP 仍保存在 Git stash `wip P2 before P1.2 local account auth`，下一步应恢复该 stash、解决与新认证基线的冲突后继续 P2。当前已建立 npm workspaces、Vue Router + Naive UI 管理台、Hono API、账号/会话/成员范围/配置版本/字典/审计/幂等、完整认证页面和 42 项自动门禁。

尚未实现：Excel导入、需求/储备/物资业务表、框架协议预算、出库实施结算、分类分析、定时任务、发信、备份及正式Cloudflare部署。P7 还需要完成真实 Cloudflare/GitHub 运维身份、account-owned CI token 和完整移交演练。后续业务入口当前均为真实空状态，不得把页面框架解释为这些业务已完成。

**下一步恢复并继续 P2。** Cloudflare 仍是托管路线，但不参与业务身份认证；恢复 P2 时保留 P1.2 的账号、会话和权限中间件，不得把旧 Access/邮箱身份代码带回来。

## 阅读顺序

1. [AGENTS.md](../AGENTS.md)：工作约定与业务底线。
2. [DESIGN.md](DESIGN.md)：用户需求、口径、默认值和参考示例观察。
3. [DATA_MODEL.md](DATA_MODEL.md)：对象、数量金额约束与API规则。
4. [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)：P1–P7依赖、交付和验收。
5. [TESTING.md](TESTING.md)：先测试后生产代码、迁移锁、并发/原子性和阶段门禁。
6. [DEPLOYMENT.md](DEPLOYMENT.md)：本地与生产的区别、Cloudflare限制。

## 可直接复制给 AI 的提示词

```text
请接手这个仓库的后续实现。先阅读 AGENTS.md、docs/AI_HANDOFF.md、
docs/DESIGN.md、docs/DATA_MODEL.md、docs/IMPLEMENTATION_PLAN.md。
P0、P1、P1.1、P1.2 已完成。恢复 `wip P2 before P1.2 local account auth` 中的 P2 工作，
解决与当前账号/会话认证基线的冲突后继续 Excel 导入、需求池和物资字典；不要重做认证，也不要将 P3–P7 未实现能力标为完成。
严格遵守 docs/TESTING.md：先写 P2 验收/回归测试并验证测试确实有约束力，再修改生产代码；任何缺陷先补复现用例。
保持 Cloudflare 免费起步、Vue + TypeScript + Hono + D1 + R2 的架构。
不需要再次询问已经在文档中确定的需求。原始Excel缺失时使用明确标注的合成测试数据，
浏览器负责 Excel 解析，Worker 负责分片校验、暂存和发布；正式 Cloudflare/GitHub 运维移交演练留到 P7。
P2 完成后运行 npm run check 和该阶段验收，更新实施计划与交接说明，
总结完成范围、检查结果、迁移与未验证事项，并按当前任务授权提交代码。
```

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
- P1.2 本地门禁已全绿：31/31 Node/workerd+D1 + 11/11 Vue，共 42 项；覆盖 production 认证、客户端 KDF 合同、会话撤销、登录锁定、并发管理员保护和失败写入原子性。CI 实际结果以仓库 Actions 为准。

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
- 下一步：恢复 P2 stash，解决与 P1.2 新基线的冲突后继续 Excel 导入、需求池和物资字典。

每完成阶段在此追加：阶段、提交号、完成内容、测试、未完成/未验证项和明确下一步。不要删除原始边界说明。
