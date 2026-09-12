# 下一位 AI：进入 P7 真实数据与正式环境验收

项目：`Evolution404/transmission-project-manager`

本地路径：`/Users/zhangyuxi/Desktop/项目管理`

分支：`main`

P0–P6 已完成并通过本地/合成数据验收。P6 主实现提交：`3f4a62d`（`feat: complete P6 analysis notifications and backups`）；P6 文档收口提交以当前 `main` HEAD 为准。

开始后先执行：

```sh
cd /Users/zhangyuxi/Desktop/项目管理
git status --short --branch
git fetch origin
```

必须确认工作区 clean 且 `HEAD == origin/main`，然后完整阅读：

1. `AGENTS.md`
2. `docs/AI_HANDOFF.md`
3. `docs/IMPLEMENTATION_PLAN.md`
4. `docs/DESIGN.md`
5. `docs/DATA_MODEL.md`
6. `docs/TESTING.md`
7. `docs/DEPLOYMENT.md`
8. `docs/P7_ACCEPTANCE.md` —— P7 验收矩阵、当前阻塞与证据要求
9. `docs/P7_RUNBOOK.md` 和 `docs/OPERATIONS_HANDOVER.md` —— 已完成的离线预检、部署模板、真实恢复与移交步骤
10. `docs/HANDOFF-P6-WIP-2026-09-12.md`（已更新为 P6 完成记录，文件名保留用于历史追溯）

认证基线永久锁定为系统自维护 `username + password`：浏览器 Web Worker 做 Argon2id，服务端只保存带运行时 pepper 的 HMAC verifier，使用 7 天 HttpOnly 会话。禁止恢复 Cloudflare Access、邮箱业务登录、邮箱验证码或服务端慢 KDF。

P6 最终门禁：**93/93 Node/workerd+D1 + 48/48 Vue/Vitest = 141/141 PASS**；TypeScript、Vite 生产构建、Worker dry-run 全绿。`AnalysisView` 约 19.48 kB（gzip 6.25 kB），ECharts 独立懒加载 chunk 约 488.44 kB（gzip 164.84 kB），Worker dry-run 上传约 411.87 KiB（gzip 78.17 KiB）。独立 D1 实际恢复测试已通过，但只代表本地合成环境。

P7 不扩写新的业务模块，重点逐项完成真实验收：

- 用户真实原始 Excel 映射抽检；
- “一年工作早知道”真实数据；
- 项目储备类别真实数据；
- 真实框架/协议/预算/实施/结算资料；
- 真实 Cloudflare Workers/D1/R2 CPU、免费额度与错误率；
- 正式域名与 HTTPS/Cookie；
- 真实邮件提供商、域名与收件配置；
- 目标地区网络实测；
- 正式 D1/R2 备份恢复演练；
- Cloudflare/GitHub 运维移交、account-owned CI token、旧维护人撤权演练；
- 正式发布与回退演练。

真实资料缺失时，不要伪造数据，也不要把合成测试改名为“真实验收”。先做不依赖缺失资料的 P7 基础工作：整理验收矩阵、资源/Secret 清单、真实数据导入检查工具、生产前自检脚本与发布/回退检查表，并明确每项所需外部输入。任何发现的真实数据口径差异必须先回到 P2–P6 已锁定的不变量核对，禁止为了适配样例而静默破坏数量、金额、版本、状态或权限约束。

## P7 本地准备交接

已补齐生产非 Secret config、离线预检/验收记录/文件哈希/备份完整性工具、发布迁移恢复回退手册和未启用部署模板。命令与限制见 `docs/P7_RUNBOOK.md`；普通 push 只跑 CI，手工 production preflight 仅 dry-run，没有生产 Token。不要把 `docs/templates/production-deploy.yml.example` 擅自启用或把 JSON 结构通过称为验收完成。

真实 P7-01～13 仍缺原始文件、正式资源/授权、通知适配器和现场网络等证据。先按矩阵收集输入；备份是多 tick JSON 分片，没有跨表快照隔离，迁移前需可靠停写和隔离恢复对账。当前没有年度/分类文件专用批量解析入口，按原件人工维护；`.xls` 需先转换。Excel 物理来源行号已修复空行/used-range 偏移，不自动重写旧批次。

当前 P7 准备门禁：完整 `npm run check` 一次通过，100/100 Node/workerd+D1 + 50/50 Vue/Vitest，共 150/150 PASS。历史 P6 的 141 项为此前基线，不是当前测试总数。源码唯一业务修正为导入物理源行号，无迁移/认证变更。
