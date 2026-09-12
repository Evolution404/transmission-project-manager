# Cloudflare 运行、成本与部署说明

核对日期：2026-09-12。**本轮只初始化，未创建或部署任何Cloudflare资源。**

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

检查包括三个工作区的类型检查、前端产物、Worker dry-run打包，以及真实workerd的三组冒烟测试。测试使用8799端口，不需要Cloudflare密钥。当前健康接口不读取D1/R2，也没有业务迁移；其成功不表示数据库或业务已就绪。

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

## 4. 生产准备（P7实施）

以下是交接步骤，初始化不执行：

1. 完成P1–P6、本地检查和主要业务验收，准备正式用户与自定义域名。
2. 使用用户授权的Cloudflare账户创建D1，提供`apac`位置提示；R2选择亚太相关提示。提示不能锁定具体机房，也不承诺香港路由。采用全球网络，不接入中国大陆网络。
3. 将本地配置复制为被Git忽略的 `apps/api/wrangler.production.jsonc`，写入真实D1/R2绑定、`APP_ENV=production`、自定义域名和正式Worker名称；移除占位符。正式使用的配置结构随后可用不含密钥的模板固化。
4. 保持 `workers_dev=false`、`preview_urls=false`，配置Access应用覆盖前端/API。服务端验证JWT签名、issuer、audience和成员状态，不能只信任请求头邮箱。生产不启用开发身份兜底。
5. 通过Worker Secrets配置所需机密（如最小权限D1导出API令牌），不写入前端和Git。需要哪些Secrets由已实现适配器明确，不提前提交空的虚假凭据。
6. 设置专用邮件子域和已验证成员邮箱；配置SPF/DKIM等记录时不要覆盖用户已有主域邮箱MX配置。完成真实收件测试后再开启业务通知。
7. 在本地/测试库完成迁移与恢复演练，备份现有正式库，再对准确数据库执行正式迁移。确认版本和资源名后部署。
8. 开启分批定时任务、备份及用量告警；测试浏览器关闭后仍能提醒，以及发送失败的恢复行为。
9. 在目标地区的移动/联通/电信测试Access登录、首页、列表、附件和邮件；记录结果再决定正式使用。

生产部署命令形状（从仓库根目录执行，只有完成上述准备且获得当次授权后才使用）：

```sh
npm run check
npm exec --workspace @tpm/api -- wrangler deploy --config wrangler.production.jsonc
```

仓库CI只有类型/构建/测试，无云部署步骤、无生产Secrets。GitHub推送不会自动发布应用。

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

所有价格/限制上线前需再次核对。免费不等于无限额或可用性保证；全球网络不等于中国大陆加速。
