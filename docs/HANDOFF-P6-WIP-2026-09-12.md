# P6 收口完成交接 — 2026-09-12

> 文件名保留 `WIP` 仅用于历史追溯。本文已从“未提交工作保护说明”更新为 P6 最终完成记录。

## 1. 最终状态

项目：`Evolution404/transmission-project-manager`

本地路径：`/Users/zhangyuxi/Desktop/项目管理`

分支：`main`

P0、P1、P1.1、P1.2、P2、P3、P4、P5、P6 已完成本地/合成数据验收。

P6 主实现提交：

- `3f4a62d feat: complete P6 analysis notifications and backups`

P6 收口后不再有需要保护的未提交实现 WIP。后续开始 P7 前仍应先执行：

```sh
git status --short --branch
git fetch origin
```

并确认工作区 clean、`HEAD == origin/main`。

认证基线永久保持为系统自维护 `username + password`：浏览器 Web Worker 执行 Argon2id，服务端只保存带运行时 pepper 的 HMAC verifier，并使用 7 天 HttpOnly 服务端会话。禁止恢复 Cloudflare Access、邮箱业务登录、邮箱验证码或服务端慢 KDF。

## 2. P6 已完成能力

### 2.1 分析、计划与月报

新增迁移：`apps/api/migrations/0006_p6_analysis_notifications_backups.sql`。

已实现：

- `GET /api/analysis/dashboard`
- `GET /api/analysis/reserve-remaining`
- `GET/PUT /api/analysis/rules`
- `GET /api/analysis/plans`
- `PUT /api/analysis/plans/:projectId/:year/:month`
- `GET /api/analysis/frameworks/:id/progress`
- `GET /api/analysis/projects/gaps`
- `POST/GET /api/reports/monthly`

核心口径：

- 月计划可自定义，未配置时按年度目标均摊；
- 支持同期计划达到率和年度目标百分点缺口两种规则；
- 默认同期计划达到率阈值 80%；
- 阈值用整数精确判断，不以显示四舍五入结果判定；
- 年度目标为 0 时返回未配置；
- 季度状态按真实业务年份和 Asia/Shanghai 日期判断；
- 月报保存规则版本、规则 JSON 和完整快照，规则修改不会覆盖旧修订；
- 子项目缺口按计划累计减预算发生；
- 储备剩余金额按未出库数量比例折算，分类金额采用整数分配保持守恒。

### 2.2 年度事项

已实现：

- `POST/GET /api/milestones`
- `GET /api/milestones/due`
- `PUT /api/milestones/:id/status`

日期精度支持 `month`、`day`、`unknown`。只有月份时不补造具体日期；未知日期明确标记待补充；完成事项停止提醒。

### 2.3 预警生命周期与通知 outbox

已实现：

- `POST /api/alerts/evaluate`
- `GET /api/alerts`
- `POST/GET /api/notification-contacts`
- `GET /api/notification-outbox`
- `POST /api/notification-outbox/claim`
- `POST /api/notification-outbox/:id/result`

生命周期：

1. 第一次越线创建 crossing event 和首次通知；
2. 持续未恢复时不重复 crossing，而是每收件人每天最多一条摘要；
3. 恢复时关闭 active event 并生成 recovery event；
4. 同一周期恢复后再次越线会创建新的 crossing event；
5. outbox claim 使用租约，超时可重新领取；
6. failed 指数退避；provider 结果不确定记 `unknown`，不会无限重发。

通知地址与业务账号登录完全独立，只给 enabled + verified 地址投递。

### 2.4 服务端 cron 与通知适配器

`apps/api/wrangler.jsonc` 配置：

```text
*/5 * * * *
```

Worker `scheduled()` 调用 P6 tick，浏览器关闭后仍可执行。

运行时配置：

- `NOTIFICATION_DELIVERY_URL`
- `NOTIFICATION_DELIVERY_TOKEN`

未配置投递 URL 时不领取 outbox；配置后每个 tick 小批处理。HTTP 2xx 记 `sent`，明确非 2xx 记 `failed`，网络结果不确定记 `unknown`。

这里仅完成通用通知适配器。真实邮件供应商、正式发送域名和真实收件配置属于 P7。

### 2.5 D1 → R2 逻辑备份与独立恢复

已实现：

- `POST /api/backups`
- `GET /api/backups`
- `POST /api/backups/:id/step`
- `POST /api/backups/:id/verify`

备份按表、每 100 行小分片导出到私有 R2，每个 chunk 保存 SHA-256；完成后生成 manifest，并记录附件 R2 key 清单，不重复复制附件大对象。

Asia/Shanghai 03:00 对应的首个 5 分钟 tick 创建 daily backup；月末同时创建 monthly backup。

恢复测试不是仅做 checksum：测试从真实 manifest 和 chunk 创建第二个独立临时 D1，应用同版本 migrations，清理迁移自动默认数据，再按依赖顺序回灌并对账项目、资金、出库、实施、结算、分析规则等核心事实。`auth_sessions` 明确不恢复，避免恢复后复活旧会话。

### 2.6 真实前端页面

`/analysis` 已切换到真实懒加载 `AnalysisView`；Dashboard 使用 `/api/analysis/dashboard` 真实数据。

分析页覆盖：

- 进度与项目缺口；
- 月计划维护；
- 计划/实际图表；
- 储备剩余分类；
- 年度事项；
- 活动预警；
- 管理员通知与备份运维区。

ECharts 已改为按需注册并二次懒加载，避免图表库进入页面主 chunk。

## 3. 最终门禁结果

P6 收口时所有 `tests/*.test.mjs` 均实际运行，无 `.skip` / `.only` / `test.todo` 绕过。

最终结果：

```text
93/93 Node/workerd+D1 PASS
48/48 Vue/Vitest PASS
141/141 total PASS
TypeScript PASS
Vite production build PASS
Worker wrangler deploy --dry-run PASS
```

当前工具单次命令上限 300 秒，因此完整 Node 门禁按测试文件组分段执行；这不是减少覆盖，全部测试文件均已跑完。

最终生产构建关键大小：

```text
AnalysisView             19.48 kB / gzip 6.25 kB
echarts lazy chunk      488.44 kB / gzip 164.84 kB
Worker dry-run upload   411.87 KiB / gzip 78.17 KiB
```

生产构建不再出现 >500 kB chunk 告警。

## 4. P0–P6 必须继续保持的不变量

- P2：chunk/validate/publish 使用显式 `expectedVersion`，版本守卫、业务写入、幂等记录处于同一 D1 batch；
- P3：需求数量守恒，同型号不同单位不合并，缺价格不等于零价格，分类金额守恒；
- P4：预算、预算发生、实际发生、结算、协议预支是不同事实；90%/80% 阈值使用精确整数判断；
- P5：出库/实施/结算独立，四状态由实施与结算两维投影；P3 范围不能缩小到既有 P5 历史事实以下；
- P6：历史月报不可被当前规则覆盖；月份精度事项不得捏造具体日期；预警 daily/recovery/recross 生命周期不可退化；provider `unknown` 不得无限重发；浏览器定时器不能替代服务端 cron；备份 verify 不能冒充实际恢复。

## 5. P7 边界

P7 不扩写新的核心业务模块，重点完成真实数据与正式环境验收：

- 用户真实原始 Excel 映射抽检；
- “一年工作早知道”真实数据；
- 项目储备类别真实数据；
- 真实框架/协议/预算/实施/结算资料；
- 真实 Cloudflare Workers/D1/R2 CPU、免费额度与错误率；
- 正式域名、HTTPS 和 Cookie；
- 真实邮件提供商、发送域名与收件配置；
- 目标地区网络实测；
- 正式 D1/R2 恢复演练；
- Cloudflare/GitHub 运维移交、account-owned CI token、旧维护人撤权演练；
- 正式发布与回退演练。

真实资料缺失时不得编造，也不得把本地合成结果称为真实验收。可以先完成不依赖外部资料的 P7 验收矩阵、资源/Secret 清单、真实数据导入检查工具、生产前自检与发布/回退检查表。

## 6. P6 完成结论

P6 本地/合成数据验收已经完成，可以进入 P7；这不等于系统已经正式上线。真实邮件、真实 Cloudflare 配额/CPU、目标地区网络、真实业务数据、正式恢复和正式运维移交仍必须在 P7 单独验证。
