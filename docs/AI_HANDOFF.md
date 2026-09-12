# 给下一位 AI 的交接

## 当前状态

P0、P1（身份权限、基础配置、初始迁移、应用框架）和 P1.1（成员管理与可移交运维）已完成并通过本地验收。

已建立：npm workspaces、Vue Router + Naive UI 管理台框架、Hono API、Cloudflare Access JWT 验证、D1 成员/范围/生命周期/配置版本/字典/审计/幂等表、首管理员 bootstrap、完整成员新增/编辑/启停/范围管理、本地 seed、共享接口类型、Wrangler 本地 D1/R2 配置、构建/类型检查/workerd+D1 集成测试入口、GitHub CI和完整设计文档。

尚未实现：Excel导入、需求/储备/物资业务表、框架协议预算、出库实施结算、分类分析、定时任务、发信、备份及正式Cloudflare部署。P7 还需要完成真实 Cloudflare/GitHub 运维身份、account-owned CI token 和完整移交演练。后续业务入口当前均为真实空状态，不得把页面框架解释为这些业务已完成。

**下一步从 P2 开始。** 不要重新搭建仓库、重做 P1/P1.1 或推翻已确认的 Cloudflare 路线。

## 阅读顺序

1. [AGENTS.md](../AGENTS.md)：工作约定与业务底线。
2. [DESIGN.md](DESIGN.md)：用户需求、口径、默认值和参考示例观察。
3. [DATA_MODEL.md](DATA_MODEL.md)：对象、数量金额约束与API规则。
4. [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)：P1–P7依赖、交付和验收。
5. [DEPLOYMENT.md](DEPLOYMENT.md)：本地与生产的区别、Cloudflare限制。

## 可直接复制给 AI 的提示词

```text
请接手这个仓库的后续实现。先阅读 AGENTS.md、docs/AI_HANDOFF.md、
docs/DESIGN.md、docs/DATA_MODEL.md、docs/IMPLEMENTATION_PLAN.md。
P0、P1、P1.1 已完成。按实施计划直接进入 P2（Excel导入、需求池与物资字典），
不要重做身份/成员管理框架，也不要将 P3–P7 的未实现能力标为完成。
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

开发端口：5173/8787，集成测试端口：8799。`npm run dev` 会先应用本地迁移并执行 `apps/api/seeds/local.sql`，该 seed 只含 `.invalid` 合成身份且不会随生产迁移部署。生产资源ID未配置；`npm run build:worker`只是dry-run打包，不发布资源。

## 不能遗漏的设计细节

- 预算总额和预算发生流水是两回事，切换报表口径不能混加各账目。
- 需求物资分配表保证数量守恒；储备项目与框架子项目同ID。
- 混合类别项目按金额分摊，大类映射全系统共用；缺价不能变成零价。
- 历史实施可以没有出库，但必须显式标记；后续关联不能重复统计。
- 实施/结算独立、允许先结算；部分进度不等于全量完成。
- 提醒在服务端调度，关闭浏览器仍应执行。免费10ms是CPU时间，不是网络等待；异步不绕过CPU限制。
- 默认全球网络、不备案、不买服务器，不承诺大陆必然快速或固定香港路由。
- 不共享资产所有者 Cloudflare 密码/Global API Key/个人长期 Token。业务管理员在应用内管理成员；技术维护人使用自己的 Cloudflare Account Member 身份；生产 CI 最终使用 account-owned API token。
- 普通新用户不得通过首次 Access 登录自动创建账号；应用管理员预建成员，Access 身份与启用成员匹配后才进入系统。

## 外部材料与待验证项

- 可读参考：https://www.workbuddy.link/p/plhvulKoyaQX5vic8Oaeoy?source=2 。仅作为功能和布局参考。
- 尚缺：原始需求Excel、“一年工作早知道”、“项目储备类别”、真实单价/框架/协议资料。
- 尚缺：生产Cloudflare账户资源、可用自定义域名、Access成员名单和验证后的邮件收件人。
- 未测：真实 Cloudflare Access 租户/JWT、完整业务、真实文件映射、Cloudflare线上CPU/配额、大陆网络、真实发信与恢复。
- P1.1 本地集成测试已扩展到 12 项，覆盖首管理员 bootstrap、成员新增/重复邮箱、首次登录生命周期、成员幂等更新、最后管理员保护、停用成员、角色越权、跨项目/框架范围、配置版本与幂等、字典和 API 回退；CI 实际结果以仓库 Actions 为准。

## 后续交接记录

### P1 · 2026-09-12

- 主要实现提交：`4880918`（`feat: complete P1 identity and app framework`）。
- 完成：Access JWT 鉴权；成员角色/范围；基础设置版本；字典、审计与幂等；Vue Router + Naive UI 应用壳；规则与成员读取页；本地 seed 与 P1 集成测试。
- 测试：从空本地 D1 执行 `npm run check` 全绿，9/9 集成测试 PASS；前端路由拆包后主包约 363KB；生产模式缺 Access 配置实测 fail-closed（503）。
- 未验证：真实 Access 租户、线上资源、正式成员名单；不影响进入 P2，本事项留生产部署/P7 验证。
- 后续设计更新：新增 P1.1，补齐成员新增/编辑/范围授权、首次登录状态、首管理员 bootstrap、最后管理员保护，并建立可完全移交的运维责任边界。

### P1.1 · 2026-09-12

- 完成：成员新增/编辑/启停、角色与 `all/framework/project` 范围；成员邀请/首次/最近登录生命周期；一次性首管理员 bootstrap；最后一个启用管理员保护；完整前端成员管理界面。
- 数据：新增追加式迁移 `0002_p1_1_member_lifecycle.sql`，未修改 P1 已交付迁移；本地 seed 仍只用于 `.invalid` 合成身份。
- 运维：新增 `docs/OPERATIONS_HANDOVER.md`，将资产所有者、应用管理员、技术运维负责人和 CI/CD 服务身份分离；正式 Cloudflare/GitHub 移交演练仍留 P7。
- 测试：`npm run check` 全绿，12/12 workerd+D1 集成测试 PASS；测试从空临时 D1 执行 bootstrap 开始。
- 未验证：真实 Access 租户、正式成员邮箱、线上 D1/R2、account-owned CI token 与真实移交；不影响进入 P2。
- 下一步：P2 Excel导入、需求池与物资字典。

每完成阶段在此追加：阶段、提交号、完成内容、测试、未完成/未验证项和明确下一步。不要删除原始边界说明。
