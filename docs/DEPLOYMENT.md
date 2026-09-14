# Cloudflare 运行、成本与部署说明

核对日期：2026-09-14。**P0–P6、最终业务模型、基础台账对象化和本轮后端可移植化代码施工均已完成。Cloudflare Workers Free + D1 + R2 仍是当前部署基线；同一 Hono 应用已通过 `PersistencePorts` 注入在 Node + SQLite + Filesystem 第二运行时完成应用级 E2E 和旧库升级演练。P7 真实数据与正式环境验收仍未完成；本轮未升级远端 D1、未合并 `main`、未正式发布。生产环境实际版本必须以部署记录和 `/api/health` 实测为准。**

## 1. 本地开发

建议 Node.js 24、npm 11，执行：

```sh
npm ci
npm run dev
```

`npm run dev`先构建前端静态资源，再同时启动Vite（5173）和Wrangler（8787）。Vite代理 `/api` 到本地Workers，Wrangler用本地workerd模拟D1/R2，状态写在忽略目录 `.wrangler/`。

本地配置 `apps/api/wrangler.jsonc` 的数据库ID为全零占位符，桶名也只是本地标识。其目的仅是本地开发与dry-run，不是可直接使用的生产配置。

```sh
npm run check
```

检查包括 Cloudflare 与 Node 两套类型边界、前端产物、Worker dry-run 打包、真实 workerd + 本地 D1 的认证/权限/并发/原子性测试，以及真实 Hono app + 文件型 SQLite + Filesystem 的第二运行时 E2E。Node 门禁还顺序执行 P7-era SQLite → 0012 的升级演练，并验证升级后应用可启动和读取历史事实。测试不需要 Cloudflare 账号或真实 Secret，也不会污染日常本地开发库。健康接口成功只表示对应运行时存活及 schema readiness，不等于生产验收。

本轮可移植化不改变当前正式部署目标。业务/认证层只接收 `RuntimeBindings.PERSISTENCE`；Cloudflare D1/R2 adapter 仅在 Worker `index.ts` 基础设施入口组装，Node 则使用 SQLite/Filesystem adapter。业务/API 层不得重新直接依赖 D1/R2。Node 第二运行时用于未来普通服务器快速切换，当前不替代 Cloudflare 部署基线，也不代表已经完成 Node 生产进程托管、反向代理、备份介质和运维方案。

## 2. 部署拓扑

```text
电脑/手机浏览器
  → 自定义域名 / Cloudflare 网络层
  → Workers Static Assets（Vue静态应用）
  → /api/*（Hono，验证系统会话 Cookie、成员角色及业务范围）
      → D1：业务表、流水、任务、快照
      → 私有 R2：附件、JSON 分片备份（原始文件需另行留存）
      → Email：已验证团队邮箱
  → Cron：领取分批任务、预警、发信和备份
```

静态文件尽量直接由资源层提供；`/api`和`/api/*`必须优先进入Worker，未知API不能返回SPA页面。保持前端与API同域，不为图表、字体或库添加不必要的境外第三方加载链路。

## 3. 免费额度与CPU

| 服务 | 已核对的免费边界 |
|---|---|
| Workers | 10万请求/天，普通请求及Cron每次CPU10ms，128MB内存 |
| Static Assets | 直接静态资源请求免费且不限量；若主动先执行Worker则计入其调用 |
| D1 | 500万读取行/天、10万写入行/天；单库500MB，账户合计5GB |
| D1单次操作 | 免费每Worker调用50次查询、每SQL最多100个绑定参数 |
| R2标准存储 | 10GB-month/月、100万A类操作、1000万B类操作；超额计费 |
| Cron | 免费账户5个触发器 |
| Email | 向账户内已验证收件地址发送免费；任意收件人发送需付费Workers |

CPU是执行代码的时间，网络/数据库等待不计入。JS解析大JSON、大Excel解压/生成、排序归并、批量验证、构造大量SQL及序列化仍占CPU；图表渲染和浏览器解析不占Worker CPU，但占用户设备资源。超CPU限制会失败，`async`、后台执行或`waitUntil()`不提高CPU限额。

免费方案验证用真实部署的CPU指标和请求结果；本地workerd只验证行为，不代表Cloudflare Free CPU、配额或网络已达标。每批20行是初始值，不是平台保证的安全值。注意50次查询和100个参数是不同限制，20行×多个字段不能盲目拼成单个超参数SQL。

如果实测需要大量工程补偿才满足10ms，可提议Workers Paid：最低$5/月，HTTP请求默认CPU30秒、可配置至5分钟；付费Cron按间隔有不同CPU上限。资源超套餐另计。该升级不购买传统服务器，也不自动获得大陆线路加速。

用量监控不能假定硬封顶：R2需开通计费订阅；私有桶、认证、文件大小/总量限制、孤立上传清理和容量监控一起控制成本。预算告警只提醒，不能表述为绝不会产生账单。

## 4. 生产准备与可移交运维（P7实施）

### 4.1 责任与身份分离

生产环境不得依赖资产所有者个人 Cloudflare 登录态。应用管理员、Cloudflare 技术运维和 CI/CD 使用不同身份：

- **应用管理员**只在本系统内管理业务成员、角色、项目/框架范围和规则，不需要 Cloudflare 权限。
- **技术运维人员**使用自己的 Cloudflare Account Member 身份处理域名、Workers、D1/R2、Secrets、WAF、迁移与故障，禁止共享资产所有者账号密码。业务账号不在 Cloudflare 管理。
- **受托运维负责人**如果需要在资产所有者不介入的情况下继续邀请/撤销 Cloudflare 成员、创建或轮换 account-owned API token，则必须在交接时明确授予其 Super Administrator 等足够权限。Cloudflare 当前要求 Super Administrator 才能管理 Account Members，创建/更新 account-owned API token 也需要 Super Administrator 权限；这是高权限角色，只授予明确的受托负责人。
- **CI/CD 服务身份**使用 Cloudflare account-owned API token，按实际发布所需最小权限配置并存入 GitHub Secrets/Environment Secrets。禁止使用资产所有者的 Global API Key、个人长期 API Token 或浏览器登录 Cookie 作为自动化依赖。
- **资产所有者**可保留 Super Administrator 作为紧急兜底，但日常发布、迁移、基础设施调整和业务账号管理不应要求其登录。

若资产所有者当前是唯一 Super Administrator，首次完整移交仍需要其完成一次性的受托负责人授权；授权完成后，后续日常运维不再依赖资产所有者账号。

### 4.2 系统账号与认证 Secret

业务账号完全在应用内维护，不配置 Cloudflare Access。生产至少需要两个与业务数据分离的运行时 Secret：`AUTH_CREDENTIAL_PEPPER` 和一次性 `BOOTSTRAP_TOKEN`；只放 Worker Secrets / 部署密钥管理中，不进入 Git、前端或日志。首管理员创建成功后 bootstrap 普通路径关闭；后续账号、重置密码、角色和范围均由应用管理员处理。

慢 KDF 在浏览器 Web Worker 执行 Argon2id，Worker 服务端只做 HMAC-SHA256 verifier 和会话校验，因此登录不会为了密码慢哈希消耗大量 Worker CPU。P7 仍需实测真实 Workers 请求 CPU，以及不同手机/浏览器执行 Argon2id 的耗时和交互体验。

### 4.3 上线步骤

以下步骤在 P7 执行；逐项状态和证据要求见 [P7_ACCEPTANCE.md](P7_ACCEPTANCE.md)：

1. 以当前已验证功能基线完成本地检查和主要业务验收，准备正式账号与自定义域名；显式确定首个真实应用管理员 username，并生成一次性 bootstrap secret。
2. 由已授权的受托技术运维身份创建/配置 D1、R2 和 Workers；提供 `apac` 位置提示。提示不能锁定具体机房，也不承诺香港路由。采用全球网络，不接入中国大陆网络。
3. 将 `apps/api/wrangler.production.example.json` 复制为被Git忽略的 `apps/api/wrangler.production.jsonc`，写入真实D1/R2绑定、`APP_ENV=production`、自定义域名和正式Worker名称；移除占位符。配置使用严格 JSON 子集，运行 `npm run p7 -- config apps/api/wrangler.production.jsonc` 检查；模板不含 Secret。
4. 保持 `workers_dev=false`、`preview_urls=false`。生产认证只接受系统会话 Cookie；不得启用 `X-Dev-User-*`、Cloudflare Access JWT 或其他请求头身份兜底。
5. 通过 Worker Secrets 配置 `AUTH_CREDENTIAL_PEPPER`、`BOOTSTRAP_TOKEN`；不写入前端和 Git。首管理员创建后验证 bootstrap 再次调用已关闭。
6. 如后续启用邮件通知，再单独设置通知邮箱/域名与 SPF/DKIM；业务账号不要求邮箱，邮件基础设施验证不得重新变成登录前提。
7. 在本地/测试库完成迁移与恢复演练，备份现有正式库，再对准确数据库执行正式迁移。确认版本和资源名后部署。
8. 开启分批定时任务、备份及用量告警；测试浏览器关闭后仍能提醒，以及发送失败的恢复行为。
9. 在目标地区的移动/联通/电信测试账号密码登录、7天会话、首次改密、首页、列表、附件和可选邮件；记录结果再决定正式使用。
10. 完成运维移交演练：由受托维护人或 CI 服务身份在资产所有者不登录 Cloudflare 的情况下完成一次受控发布、一次迁移演练和一次回退；验证旧维护人撤权、CI Token 轮换后系统仍可运行，并记录紧急恢复路径。

生产部署命令形状（从仓库根目录执行，只有完成上述准备且获得当次授权后才使用）：

```sh
npm run check
npm exec --workspace @tpm/api -- wrangler deploy --config wrangler.production.jsonc
```

仓库默认普通 push CI 只做检查；手工 production preflight 只校验非敏感配置并 dry-run，不应携带云凭据。`docs/templates/production-deploy.yml.example` 是未激活模板；实际生产是否已经存在其他受控发布流程必须读取当前 GitHub/Cloudflare 配置确认，不能仅根据模板状态推断。任何启用/修改生产发布流程都必须先获得授权并验证 Environment 分支/审批规则和 account-owned API token。完整操作顺序、证据与回退边界见 [P7_RUNBOOK.md](P7_RUNBOOK.md)。

## 5. 数据备份和回退

- 当前实现通过 D1 绑定逐表读取，每 100 行写入私有 R2 JSON 分片，附 SHA-256 和 manifest；不使用 D1 HTTP SQL 导出 API，不需要单独导出 Token。
- 北京时间 03:00 创建任务，Cron 每次只推进一个分片步骤；daily 保留 7 份、monthly 保留 3 份已完成备份。完成时间和保留清理 CPU 须按真实数据规模测量。
- 分片备份不是跨表一致快照。正式迁移备份须可靠停写并暂停并发 Cron/step，留存 schema 指纹、截止时间和逐表对账；无法保证停写时必须使用另行验证的一致性方案。
- manifest 仅列附件 key，不含本体或内容 hash；附件需独立下载、核对大小/hash。30 天延迟删除和周期孤立对象清理尚未实现，不应假定已经启用。
- 恢复先在隔离 D1 应用同版本迁移并回灌 JSON，核对行数、金额/数量、状态、规则、外键和附件，`auth_sessions` 不恢复；只校验 checksum 不等于恢复成功。
- 代码回退不等于数据回退。首次正式/共享环境使用后历史迁移冻结；保持旧应用与新 schema 兼容，数据恢复经隔离核对后再切换，不直接覆盖正式库。
- P6 已实现业务预警、通知 outbox 和备份任务状态；Cloudflare CPU/额度/容量及外部可用性告警仍需 P7 正式配置并验证负责人收得到。

## 6. 官方依据

- [Workers价格](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers资源与CPU限制](https://developers.cloudflare.com/workers/platform/limits/)
- [静态资源路由](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/)
- [Wrangler配置](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [D1价格](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1限制](https://developers.cloudflare.com/d1/platform/limits/)
- [D1位置提示](https://developers.cloudflare.com/d1/configuration/data-location/)
- [D1批量事务](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [D1导出至R2](https://developers.cloudflare.com/workflows/examples/backup-d1/)
- [D1导出API限制](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/export/)
- [R2价格](https://developers.cloudflare.com/r2/pricing/)
- [R2开通与订阅](https://developers.cloudflare.com/r2/get-started/)
- [Email价格及已验证收件人](https://developers.cloudflare.com/email-service/platform/pricing/)
- [Cloudflare中国大陆网络](https://developers.cloudflare.com/china-network/)
- [Cloudflare Account Members 与权限](https://developers.cloudflare.com/fundamentals/manage-members/)
- [Cloudflare Account Roles](https://developers.cloudflare.com/fundamentals/manage-members/roles/)
- [Cloudflare Account-owned API Tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)

所有价格/限制上线前需再次核对。免费不等于无限额或可用性保证；全球网络不等于中国大陆加速。
