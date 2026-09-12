# Cloudflare 运行、成本与部署说明

核对日期：2026-09-12。**P1 身份与基础配置核心已完成；尚未创建或部署任何正式 Cloudflare 资源。**

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

检查包括三个工作区的类型检查、前端产物、Worker dry-run 打包，以及真实 workerd + 本地 D1 的 P1 集成测试。测试使用 8799 端口、独立临时 D1 和合成身份，不需要 Cloudflare 密钥，也不会污染日常本地开发库。健康接口成功只表示 Worker 存活；P2 以后业务仍未实现。

## 2. 计划中的部署拓扑

```text
电脑/手机浏览器
  → 自定义域名与 Cloudflare Access
  → Workers Static Assets（Vue静态应用）
  → /api/*（Hono，验证Access JWT及成员范围）
      → D1：业务表、流水、任务、快照
      → 私有 R2：原始文件、附件、SQL备份
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
| Access | 免费档最多50名用户，本项目初期20人以内 |
| Email | 向账户内已验证收件地址发送免费；任意收件人发送需付费Workers |

CPU是执行代码的时间，网络/数据库等待不计入。JS解析大JSON、大Excel解压/生成、排序归并、批量验证、构造大量SQL及序列化仍占CPU；图表渲染和浏览器解析不占Worker CPU，但占用户设备资源。超CPU限制会失败，`async`、后台执行或`waitUntil()`不提高CPU限额。

免费方案验证用真实部署的CPU指标和请求结果；本地workerd只验证行为，不代表Cloudflare Free CPU、配额或网络已达标。每批20行是初始值，不是平台保证的安全值。注意50次查询和100个参数是不同限制，20行×多个字段不能盲目拼成单个超参数SQL。

如果实测需要大量工程补偿才满足10ms，可提议Workers Paid：最低$5/月，HTTP请求默认CPU30秒、可配置至5分钟；付费Cron按间隔有不同CPU上限。资源超套餐另计。该升级不购买传统服务器，也不自动获得大陆线路加速。

用量监控不能假定硬封顶：R2需开通计费订阅；私有桶、认证、文件大小/总量限制、孤立上传清理和容量监控一起控制成本。预算告警只提醒，不能表述为绝不会产生账单。

## 4. 生产准备与可移交运维（P7实施）

### 4.1 责任与身份分离

生产环境不得依赖资产所有者个人 Cloudflare 登录态。应用管理员、Cloudflare 技术运维和 CI/CD 使用不同身份：

- **应用管理员**只在本系统内管理业务成员、角色、项目/框架范围和规则，不需要 Cloudflare 权限。
- **技术运维人员**使用自己的 Cloudflare Account Member 身份处理域名、Access、Workers、D1/R2、Secrets、迁移与故障，禁止共享资产所有者账号密码。
- **受托运维负责人**如果需要在资产所有者不介入的情况下继续邀请/撤销 Cloudflare 成员、创建或轮换 account-owned API token，则必须在交接时明确授予其 Super Administrator 等足够权限。Cloudflare 当前要求 Super Administrator 才能管理 Account Members，创建/更新 account-owned API token 也需要 Super Administrator 权限；这是高权限角色，只授予明确的受托负责人。
- **CI/CD 服务身份**使用 Cloudflare account-owned API token，按实际发布所需最小权限配置并存入 GitHub Secrets/Environment Secrets。禁止使用资产所有者的 Global API Key、个人长期 API Token 或浏览器登录 Cookie 作为自动化依赖。
- **资产所有者**可保留 Super Administrator 作为紧急兜底，但日常发布、迁移、Access 调整和业务成员管理不应要求其登录。

若资产所有者当前是唯一 Super Administrator，首次完整移交仍需要其完成一次性的受托负责人授权；授权完成后，后续日常运维不再依赖资产所有者账号。

### 4.2 Access 与新用户

Access 只做身份认证，应用成员表做业务准入。优先按稳定企业邮箱域或 IdP 组配置 Access 范围，使普通新成员由应用管理员在系统内新增即可，不需要逐个进入 Cloudflare。不得仅为了减少运维而把 Access 配成允许任意有效邮箱。确需新增现有 Access 策略之外的邮箱/域时，由受托技术运维人员使用自己的 Cloudflare 身份修改策略。

### 4.3 上线步骤

以下步骤在 P7 执行：

1. 完成 P1.1–P6、本地检查和主要业务验收，准备正式用户与自定义域名；显式确定首个真实应用管理员邮箱。
2. 由已授权的受托技术运维身份创建/配置 D1、R2、Workers 和 Access；提供 `apac` 位置提示。提示不能锁定具体机房，也不承诺香港路由。采用全球网络，不接入中国大陆网络。
3. 将本地配置复制为被Git忽略的 `apps/api/wrangler.production.jsonc`，写入真实D1/R2绑定、`APP_ENV=production`、自定义域名和正式Worker名称；移除占位符。正式使用的配置结构随后可用不含密钥的模板固化。
4. 保持 `workers_dev=false`、`preview_urls=false`，配置Access应用覆盖前端/API。服务端验证JWT签名、issuer、audience和成员状态，不能只信任请求头邮箱。生产不启用开发身份兜底。
5. 通过Worker Secrets配置所需机密（如最小权限D1导出API令牌），不写入前端和Git。需要哪些Secrets由已实现适配器明确，不提前提交空的虚假凭据。
6. 设置专用邮件子域和已验证成员邮箱；配置SPF/DKIM等记录时不要覆盖用户已有主域邮箱MX配置。完成真实收件测试后再开启业务通知。
7. 在本地/测试库完成迁移与恢复演练，备份现有正式库，再对准确数据库执行正式迁移。确认版本和资源名后部署。
8. 开启分批定时任务、备份及用量告警；测试浏览器关闭后仍能提醒，以及发送失败的恢复行为。
9. 在目标地区的移动/联通/电信测试 Access 登录、首页、列表、附件和邮件；记录结果再决定正式使用。
10. 完成运维移交演练：由受托维护人或 CI 服务身份在资产所有者不登录 Cloudflare 的情况下完成一次受控发布、一次迁移演练和一次回退；验证旧维护人撤权、CI Token 轮换后系统仍可运行，并记录紧急恢复路径。

生产部署命令形状（从仓库根目录执行，只有完成上述准备且获得当次授权后才使用）：

```sh
npm run check
npm exec --workspace @tpm/api -- wrangler deploy --config wrangler.production.jsonc
```

当前仓库 CI 只有类型/构建/测试，无云部署步骤、无生产 Secrets。P7 才增加受保护的生产部署工作流；GitHub 普通 push 不应默认直接发布生产，生产部署应使用受保护 Environment、明确分支/审批规则和 account-owned API token。

## 5. 数据备份和回退

- D1免费版Time Travel为7天；备份任务使用D1导出API把SQL写入私有R2，导出期间可能短暂不能查询，安排北京时间03:00。
- 备份保留7份日备份与3份月末备份，监控容量；文件附件使用不可覆盖版本键和30天延迟删除，并保留对象清单，避免只有SQL无法恢复附件。
- 恢复先在隔离数据库演练，核对行数、金额/数量、文件清单及规则版本，再按业务维护安排切换绑定。
- 代码回退不等于数据回退。迁移优先追加兼容变更，禁止用回退旧代码自动删除新数据。每次版本发布记录迁移版本、备份位置和恢复路径。
- 运维告警至少包含任务失败、邮件失败、备份失败、CPU超限、D1读写/空间及R2用量；当前均尚未实现。

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
- [Access套餐](https://www.cloudflare.com/plans/)
- [Cloudflare中国大陆网络](https://developers.cloudflare.com/china-network/)
- [Cloudflare Account Members 与权限](https://developers.cloudflare.com/fundamentals/manage-members/)
- [Cloudflare Account Roles](https://developers.cloudflare.com/fundamentals/manage-members/roles/)
- [Cloudflare Account-owned API Tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/)
- [Cloudflare Access Policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)

所有价格/限制上线前需再次核对。免费不等于无限额或可用性保证；全球网络不等于中国大陆加速。
