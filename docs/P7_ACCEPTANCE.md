# P7 真实数据与正式环境验收

版本：2026-09-12。

P0–P6 已完成本地/合成数据验收。P7 不新增另一套核心业务功能，目标是用真实业务资料、真实 Cloudflare 资源、真实通知链路和目标地区网络证明现有系统可以正式使用、恢复和移交。

## 1. P7 入口基线

P6 完成基线：

- 主实现：`3f4a62d feat: complete P6 analysis notifications and backups`
- 收口文档：`33c0528 docs: record P6 completion and P7 handoff`
- P6 门禁：93/93 Node/workerd+D1 + 48/48 Vue/Vitest，共 141/141 PASS
- TypeScript、Vite production build、Worker dry-run PASS
- 本地独立 D1 实际恢复测试 PASS
- 当前业务认证：系统自维护 username/password；浏览器 Argon2id；服务端 HMAC verifier + 7 天 HttpOnly session

上述结果只证明本地/合成环境，不代表已正式上线。

## 2. 验收矩阵

| 编号 | 领域 | 验收内容 | 当前状态 | 完成证据 |
|---|---|---|---|---|
| P7-01 | 原始需求 Excel | 使用用户真实原始文件验证工作表、字段映射、5 万行级分片、来源追溯、疑似重复和错误分类 | 阻塞：仓库无真实文件 | 抽检记录 + 导入结果 + 源行反查 |
| P7-02 | 一年工作早知道 | 导入/录入真实年度事项，核对 month/day/unknown 日期精度及提醒日期 | 阻塞：真实资料未提供 | 事项抽检表 + 提醒结果 |
| P7-03 | 储备类别 | 使用真实分类文件核对需求类别→储备大类映射、共同费用分摊和金额守恒 | 阻塞：真实资料未提供 | 映射对照表 + 分类金额对账 |
| P7-04 | 项目与资金 | 使用真实框架、协议、预算、预算发生、实际费用核对归属、版本、阈值和逐笔对账 | 阻塞：真实资料未提供 | 框架/协议/项目对账表 |
| P7-05 | 出库实施结算 | 使用真实出库、实施、结算历史核对部分完成、先结算后实施、历史关联、四状态和附件 | 阻塞：真实资料未提供 | 项目逐项抽检 + 状态对照 |
| P7-06 | Cloudflare 资源 | 创建/确认正式 Worker、D1、R2、Cron、Static Assets、自定义域名；正式 config 不含 Secret | 阻塞：未配置正式资源 | 资源清单 + 非敏感配置快照 |
| P7-07 | Secret / bootstrap | 配置 `AUTH_CREDENTIAL_PEPPER`、一次性 `BOOTSTRAP_TOKEN`；创建首管理员后验证 bootstrap 关闭 | 阻塞：需正式 Worker | Secret 名称清单 + bootstrap 验收记录，不记录 Secret 值 |
| P7-08 | 真实 CPU / 免费额度 | 真实部署测 Worker CPU、D1 read/write rows、R2 用量、Cron 与错误率；核对 Free 边界 | 阻塞：需正式资源 | Cloudflare 指标截图/导出 + 测试记录 |
| P7-09 | 正式通知 | 配置真实通知 provider、发送域名、SPF/DKIM/收件配置；验证 sent/failed/unknown/retry | 阻塞：provider/域名未提供 | 测试消息与 outbox/provider 对账 |
| P7-10 | 目标地区网络 | 在实际使用地区与运营商验证登录、首页、列表、附件、通知 | 阻塞：需正式域名与现场网络 | 时间、网络、操作、耗时、错误记录 |
| P7-11 | 正式备份恢复 | 正式 D1 先备份，再恢复至隔离 D1；核对数量、金额、状态、规则、附件清单；不恢复会话 | 阻塞：需正式 D1/R2 | manifest + 对账表 + 恢复步骤 |
| P7-12 | 发布与回退 | 使用受保护 GitHub Environment + account-owned token 做受控发布、迁移、代码回退演练 | 阻塞：CI 服务身份未配置 | Workflow run + 版本/迁移/回退记录 |
| P7-13 | 运维移交 | 受托维护人使用自己的 Cloudflare/GitHub 身份；Token 轮换；旧维护人撤权后仍可运维 | 阻塞：人员/权限未配置 | 移交检查表签收 + 演练记录 |

## 3. 真实数据验收原则

真实资料进入系统时必须沿用 P2–P6 已锁定的不变量，不允许为了“导得进去”而静默放宽规则：

- 原始数量、有效分配和剩余数量必须守恒；
- 同型号不同单位不得合并；
- 缺价格不等于零价格；
- 金额使用整数分/定点运算，不做浮点累计；
- 预算、预算发生、实际发生、结算、协议额度保持独立；
- 已出库/实施/结算历史不能被储备调整覆盖；
- 实施和结算独立投影四状态；
- 历史月报不可被当前规则覆盖；
- 月份精度事项不得捏造具体日期。

如果真实文件暴露出新的列名、编码或业务类别，优先扩展字段映射/字典配置；只有确认现有业务模型确实不满足真实规则时，才按“测试先行 → 设计更新 → schema/API/UI 变更 → 完整门禁”的方式修改核心模型。

## 4. 正式 Cloudflare 资源清单

P7-06 开始前需要明确以下非敏感标识；Secret 只记录名称，不记录值：

- Cloudflare account / zone 归属；
- 正式 Worker 名称；
- 正式 D1 database 名称与 ID；
- 正式 R2 bucket 名称；
- 自定义域名；
- Cron 配置；
- GitHub production Environment 名称；
- CI 使用的 account-owned API token 对应权限范围；
- `AUTH_CREDENTIAL_PEPPER` Secret；
- `BOOTSTRAP_TOKEN` Secret；
- `NOTIFICATION_DELIVERY_URL` / `NOTIFICATION_DELIVERY_TOKEN`（启用通知时）。

禁止把 Cloudflare 密码、Global API Key、个人长期 Token、Secret 明文写入仓库或本验收文档。

## 5. 生产发布门禁

任何正式部署前必须同时满足：

1. 当前 main 工作区 clean，`HEAD == origin/main`；
2. 完整类型、构建、Worker dry-run、Node/workerd+D1、Vue/Vitest 门禁全绿；
3. 正式 D1/R2 资源名和绑定已人工核对；
4. 生产配置 `APP_ENV=production`，`workers_dev=false`、`preview_urls=false`；
5. 生产 Secret 已配置且不出现在 Git diff / 日志；
6. 正式 D1 迁移前已生成可验证备份；
7. 有明确发布版本、迁移版本、回退路径和执行人；
8. 普通 push 不直接发布生产，生产 workflow 使用受保护 Environment；
9. 首次正式发布后，历史迁移冻结为只追加模式。

## 6. 回退边界

代码回退和数据回退必须分开：

- 代码问题优先回退应用版本，不自动删除数据库新字段/新数据；
- migration 一旦进入正式/共享数据环境不得回改历史文件；
- 需要数据恢复时从经过验证的正式备份恢复到隔离数据库，完成对账后再切换；
- R2 附件通过 manifest/对象清单核对，不因 D1 恢复而假定附件天然完整；
- 恢复后不得复活旧 `auth_sessions`。

## 7. 当前可立即执行与外部阻塞

当前仓库已经具备 P0–P6 的本地验证能力，但尚未发现：

- 用户真实 `.xlsx/.xls/.csv`；
- `wrangler.production.jsonc` 或其他正式资源配置；
- 生产部署 GitHub workflow；
- P7 专用真实验收记录。

因此 P7 当前可以继续做生产前自检、验收记录模板和受保护部署流程的代码准备，但 P7-01～P7-13 中标记为“真实”的项目只有获得相应真实文件、云资源、域名、通知 provider 或现场网络后才能完成。不得用合成数据替代这些完成证据。
