# P7 预检、发布与恢复操作手册

本手册描述 P7 的预检、正式操作和恢复步骤。历史上只完成过离线准备，不能据此推断当前线上资源或部署版本；每次正式 migration、Secret 变更、发信、部署和回退都必须获得当次授权，并以真实证据更新 P7-01～13 状态。

## 1. 本地工具（仓库根目录）

```sh
npm run p7:preflight
npm run p7 -- config apps/api/wrangler.production.jsonc
npm run p7 -- acceptance data/private/p7/evidence.json
npm run p7 -- inputs data/private/项目需求导入模板_已填报.xlsx
npm run p7 -- backup backups/drill/manifest.json backups/drill/objects
npm run check
```

- `p7:preflight` 运行迁移/认证守卫和 P7 工具测试，无网络、无云凭据。
- `config` 使用严格 JSON（也是 JSONC 合法子集），不接受注释或额外字段。检查唯一 DB/FILES/ASSETS 绑定、同域 API 路由、Cron、production 环境、账户/资源 ID 格式、关闭 workers.dev/preview。拒绝占位符及所有内联 Secret、旧认证变量和额外环境覆盖。不会检查远端资源存在性、账户归属、R2 私有性或 Secret 是否真的配置。
- `acceptance` 校验 13 个唯一编号、状态和证据元数据。退出码 0 表示记录结构齐全且都声明 passed；1 表示记录不合法；2 表示仍有未通过项。**它不验证证据真实性，不代替人员验收或上线许可。** P7-01～05 的环境必须为 `real-data`，06～13 必须为 `production`；本地合成结果不能填 passed。
- `inputs` 流式计算填报文件名、大小、SHA-256，旧 `.xls` 标记需转换并退出 2；不输出行内容，不上传、不导入。需求主流程使用系统下载的标准 `.xlsx` 模板，标准模板应自动映射；工具只记录证据，不能代替应用内回导和业务值核对。
- `backup` 按 P6 v1 manifest 检查每个分片的 SHA-256、表/行数、连续且唯一索引、安全对象路径及附件文件存在性；不打印业务行，拒绝路径穿越与逃出目录的符号链接，不恢复会话。退出 0 **只证明所给清单的局部完整性**，不能发现被同时删去的清单/分片，不能证明跨表一致、附件内容无损或数据库已恢复。附件额外校验见第 6 节。
- 工具不执行远端命令。所有真实输入、备份、配置和验收记录放已忽略目录；不要在公共 CI 上传这些文件或保存为 Actions artifact。错误不回显 JSON 解析原文，避免意外输出凭据。

模板入口：`apps/api/wrangler.production.example.json`、`docs/templates/p7-evidence.example.json`、`docs/templates/p7-release-record.md`。所有示例状态默认 blocked，生产配置占位值应使 `config` 检查失败。

## 2. 真实业务资料抽检

需求数据不以“适配任意历史 Excel”为目标。业务负责人先从系统下载标准需求模板并按模板填报；实际填报文件作为验收原件，记录 SHA-256。每个抽检样本记录模板版本/哈希、填报文件哈希、工作表、物理行、批次 ID、需求 ID、项目 ID、预期值、实际值、复核人及结论，记录留私有目录。历史自定义 Excel 只有明确需要兼容时才走已有字段映射能力，不作为 P7-01 的默认验收输入。

| 验收编号 | 必须核对的边界 |
|---|---|
| 01 | 先用真实电压等级/线路/杆塔清单维护基础台账，再下载标准模板回导真实需求；核对序号与结构化位置、0..N 物资子明细、实际填报源行反查、未知/停用台账对象阻断、未知标准物资告警、负数/过精度数量、同源恢复/疑似重复，以及分片上传/校验/发布。多工作表、空行、偏移起始区域属于兼容解析回归，不要求业务人员故意按非标准格式填报 |
| 02 | 原文件事项先人工核对再用事项页录入；目前没有年度文件批量解析入口。month/day/unknown、负责人、提前天数、跨月/跨年、完成停止提醒；仅月份不补具体日 |
| 03 | 原分类表人工核对并维护类别/映射；目前没有分类文件批量解析入口。同型号不同单位、共同费用分摊、缺价/null 与明确零价、未分类和金额守恒；储备类别只统计尚未发生项目级出库的项目当前物资，已出库项目整体退出该口径 |
| 04 | 框架/协议/预算版本、有效期与归属；预算确认不产生发生；多协议分摊、冲销；90%/80%及超 1 分边界；以整数分对账且各账目独立 |
| 05 | 核对需求来源与项目物资分离、项目物资修订、一次项目级出库、多执行任务、任务物资供应、部分实施、先结算后实施、最终结算/撤销；历史未关联不补造出库；四状态、范围保护、附件及跨范围拒绝 |

本次修正了解析器忽略空行和 used-range 起点导致的物理行号偏移。已有发布批次不会被自动重编号；若以后在旧批次发现偏移，先保留原批次/来源证据，制定带审计的数据修复，不能重传同哈希来静默替换历史。

## 3. 正式配置和 Secret 名称清单

获得授权后将示例复制到 `apps/api/wrangler.production.jsonc`，填写账户、Worker、D1 名称/ID、R2 桶和自定义域名。保留相对路径结构，并运行 `config` 后再 dry-run。名称校验采用本项目保守规范；有新配置需求先改测试和模板，不能为绕过检查随意删字段。

| 名称 | 放置/核对方式 |
|---|---|
| `PRODUCTION_CONFIG_JSON` | GitHub production Environment 的 Variable，保存验证后的非敏感严格 JSON；不是 Secret 值容器 |
| `AUTH_CREDENTIAL_PEPPER` | Worker Secret + 独立受控密钥备份；丢失后现存 HMAC verifier 无法验证；不可当普通无损轮换 Secret |
| `BOOTSTRAP_TOKEN` | 一次性 Worker Secret；明确首管理员 username；成功后验证 bootstrap 关闭并删除该 Secret |
| `NOTIFICATION_DELIVERY_URL` | 可选 Worker Secret；HTTPS 通知适配器端点，URL 不嵌 Token |
| `NOTIFICATION_DELIVERY_TOKEN` | 可选 Worker Secret；Bearer token，只在通知适配器中使用 |
| `CLOUDFLARE_API_TOKEN` | 将来启用生产发布时才配置的 GitHub Environment Secret；account-owned，按 Worker/D1/R2/路由实际命令的最小范围授权 |

P6 不使用 D1 HTTP export API，因此现有逻辑备份不需要额外 D1 导出 Token。Worker DB/FILES 绑定由平台注入。不要把运行时 Secret 放进 GitHub config Variable 或前端构建变量。

通知适配器接受 POST JSON：`notificationId,eventId,to,subject,text,ruleKey`，可选 Bearer；超时 8 秒，最多 10 条一批。第三方邮件供应商若 payload 不同，需要适配服务，不能直接把任意厂商 API URL 填上去。适配器应以 notificationId 去重。2xx 只表示 provider 接受，不等于收件箱投递；需对账 provider message ID、退信和实际收件。unknown 必须先查询 provider，勿盲目重新领取重发。enabled + verified 联系人需有真实验证依据，当前 verified 标记是管理员录入，系统没有邮箱验证挑战。

## 4. 生产发布准备和顺序

1. 明确资源所有者、操作者、授权范围、main SHA、schema lock SHA、备份/恢复记录、回退版本、维护窗口和联系人。先运行完整 `npm run check`。检查 `git status --short --branch`、fetch 后 HEAD 与 origin/main 一致。
2. 人工核对 Cloudflare account/zone/Worker/D1/R2 归属和计费计划；确认 R2 未开放 r2.dev/公开域名，API 同域且 HTTPS；建立域名/资源和 Secret 清单。**首次资源创建与付费开通不是运行本地脚本的隐含授权。**
3. 检查 GitHub production Environment 的 main 分支限制、审批人、禁止自批和管理员绕过策略；实际可用功能取决于当前仓库可见性/套餐，必须在真实 UI/API 验证，不能因 YAML 写了 environment 就宣称存在审批。若不可用，保留人工发布，不启用部署模板。
4. 记录远端 `d1 migrations list`。已有共享库先停写并暂停 Cron/其他写任务，保存当前部署/触发器配置和恢复时间点，备份并验证。首个空库也保留“空库、无业务/账号”的核对证据。
5. 把经过批准的迁移应用到**核对过 ID 的正式 DB**。迁移是单独显式操作，不放在自动启动、普通 push 或自动回退中。执行后核对已应用版本、关键计数/金额和错误。任何失败立即停止发布，不盲目重跑或改历史迁移。
6. 使用验证后的 production config dry-run，再受控发布准确 commit；记录 Worker version/deployment ID。发布模板只做代码发布，不执行数据库迁移。涉及不兼容 schema 的代码不得在旧代码仍写库时迁移，需单独兼容方案/维护窗口。
7. 首次管理员通过 HTTPS 页面输入 bootstrap token 建号；验证二次 bootstrap 拒绝，移除一次性 Secret。应用内另建第二管理员，验证首次改密、角色/范围、停用撤销旧会话和 7 天 Cookie；禁止在 shell/history/日志中记录密码、派生凭据或 Cookie。
8. 实测匿名 `/api/me` 拒绝、未知 API 返回 JSON 404、health 仅作为存活检查；浏览器验证已登录流程、附件权限和 Secure/HttpOnly/SameSite=Strict Cookie。关闭页面后检查 Cron，恢复业务写入并记录维护窗口结束。
9. 观察完整一个后台/备份周期以及实际业务量；按第 7 节记录 CPU、额度、网络和通知。完成 P7 真正必需证据后才批准正式使用。

仅在完成上述核对及授权后，从 `apps/api` 执行以下命令形状；`VERIFIED_DATABASE_ID`、`PREVIOUS_WORKER_VERSION` 由记录填写，禁止使用本地占位资源：

```sh
npm exec -- wrangler d1 migrations list VERIFIED_DATABASE_ID --remote --config wrangler.production.jsonc
npm exec -- wrangler d1 migrations apply VERIFIED_DATABASE_ID --remote --config wrangler.production.jsonc
npm exec -- wrangler deploy --dry-run --config wrangler.production.jsonc
npm exec -- wrangler deploy --config wrangler.production.jsonc
npm exec -- wrangler rollback PREVIOUS_WORKER_VERSION --config wrangler.production.jsonc
```

当前可执行 Actions 是 CI（push 只测试）与手工 `Production preflight (no deployment)`（只校验 Environment Variable 和打包，没有云 Token）。完整 `docs/templates/production-deploy.yml.example` **位于 workflows 外，不会运行**；只有获得上线授权、确认审批确实有效并配置 account-owned token 后，才复制到 workflows，设 `PRODUCTION_DEPLOY_ENABLED=true` 并提交审核。模板只接受 main 手工触发，要求完整 main SHA 与私有发布记录引用，绑定 production Environment、串行发布、禁止取消执行中的发布；它不自动判定人工证据真实性。

## 5. 回退

- 优先停止新写入/任务，保留故障版本和日志（脱敏）、当前数据备份、部署 ID、schema 版本。核实旧应用兼容当前 schema 再回退代码。Worker 回退不自动回退 D1、R2 或所有绑定/Secret/Cron 配置，逐项核对。
- Git revert 是新的代码提交；不要 reset/force-push main 去抹除审计。回退后重复鉴权、角色、金额/数量、列表和附件检查，再恢复任务。
- 数据回退一律恢复到隔离 D1，完成对账后受控切换绑定；不能把有新数据的正式库直接覆盖。首次上线后历史迁移冻结，只追加；不能删除新列/历史流水来配合旧程序。
- CI Token 可撤销重建；pepper 是凭据验证依赖，轮换需要独立账号重置/凭据迁移方案。恢复到新环境必须安全提供匹配的 pepper，不恢复历史会话；强制所有用户重新登录。

## 6. D1/R2 恢复演练

P6 JSON 分片不是 SQLite SQL dump，不可直接交给 `d1 execute --file`。备份按多次查询跨 tick 读取，没有全库快照隔离；正常业务持续写入时只能视为渐进备份，**不能直接担保资金一致性**。正式迁移前停写业务、暂停 Cron/其他消费者，并由单一操作者串行驱动备份 step；不要并发 step，也不要让保留策略删除本次恢复来源。应用未实现一键只读维护模式，停写应由已授权的运维措施保障并验证；若不能可靠停写，需改用独立验证的一致性备份方案后再发布。

1. 留存源 commit、所有迁移文件/lock、源库 ID、停写时间/业务截止点、备份 run ID、manifest 原始字节 SHA-256、每表计数及整数金额/数量对账。P6 manifest 本身未包含 schema 指纹/空表清单，需在发布记录补齐。
2. 将 manifest、全部 JSON chunks 和附件原件下载到受控私有目录。对象相对路径保留 R2 key。另生成附件 `key,size,SHA-256` 清单，在源 R2 与下载件逐一核对；P6 manifest 只有附件 key，没有附件内容 hash。不要把 D1 备份当作 R2 本体备份。
3. 运行离线 `backup` 检查，再从同一版本迁移创建**全新隔离** D1；不能给恢复库绑定正式 Cron/通知适配器或正式公开路由。它包含账号 verifier 和通知地址，按正式数据等级保护。
4. 在隔离库移除迁移默认数据，然后将每个 chunk 的 rows 按当前 schema 依赖顺序参数化插入，遵循 `tests/p6-analysis.test.mjs` 的 `restoreTableOrder` 和现有独立 D1 恢复测试；每步检查 foreign key/unique 约束，失败停止。禁止动态执行未经白名单/标识符转义验证的表名/列名；不要把不受信任的 JSON 拼成 SQL。当前没有面向生产的一键恢复写入 CLI，远端回灌由受托运维审阅脚本后执行。
5. `auth_sessions`、备份任务元数据、D1 migration metadata 不从业务 manifest 恢复；迁移 metadata 由同版本迁移创建。隔离恢复禁止真实发信，核对 outbox 的 pending/leased/unknown 与 provider，重新启用前处理重复发送风险。
6. 对所有业务表逐表计数；核对电压等级→线路→杆塔→需求位置关系、项目需求来源与项目物资分离、项目/任务物资数量边界、供应 `到货<=发货<=上报<=任务需求`、分类估算、按框架/协议/项目/类型的整数分流水、出库/实施/结算范围和四状态、规则版本及历史报告；运行 `PRAGMA foreign_key_check`，确认会话为 0，附件每个可授权下载且跨项目拒绝。
7. 记录备份耗时、恢复耗时/RTO、数据截止/RPO、结果和复核人。只有隔离恢复和应用对账通过后，才可按授权维护窗口切换 DB/FILES 绑定；保留旧库到经批准的保留期，不自动删除。

当前 daily 保留 7 份、monthly 保留 3 份已完成备份；每天 03:00 首个 tick 创建任务，每个 tick 只推进一个待备份任务的一步，实际完成时间随数据量增长。真实规模必须验证能否在下一周期前完成，以及保留清理的 CPU/操作成本。附件 30 天延迟删除/孤立对象周期清理仍是设计目标，当前没有该自动运维实现；不要提前启用可能删除备份引用对象的 R2 Lifecycle。

## 7. 性能、网络与运维交接证据

- Worker CPU 使用 Cloudflare 指标，按登录/KDF、导入 chunk/validate/publish、列表、统计、附件、Cron/备份分别记录样本数、P50/P95/P99/max、CPU limit 错误与请求失败率；本地墙钟、curl 时间或数据库等待不能当 Worker CPU。记录 Workers 实际套餐及核对日期，Free 10ms 是否满足由云上结果判断。
- 记录每种调用 D1 rows read/written、查询计划/索引、每日总量和空间，R2 字节/操作、通知量；70% 用量提醒与接收负责人须在 Cloudflare/外部监控实际设置和演练，业务预警不是云额度告警。
- 目标地区 × 电信/联通/移动 × 桌面/低性能手机，记录日期、冷/热缓存、设备浏览器、登录 Argon2id 本地时间、首页主要内容与列表 P95、分页、10 MiB 附件和错误；常用列表目标 P95 ≤ 3 秒，已登录首页 ≤ 5 秒。至少多个时段取样，原始明细留私有记录，不能用一次平均值代替 P95。
- 交接检查采用 OPERATIONS_HANDOVER.md，新增“旧维护人撤权后发布、迁移读取、回退、告警接收仍可完成”结果；记录 account-owned token ID/权限/到期（不记录值）、轮换前后 run ID 和紧急联系人。
