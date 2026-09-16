# 输电项目全流程管理台

面向 20 人以内团队的项目管理应用，计划采用 Cloudflare Workers、D1、R2，免费额度内运行，支持电脑和手机访问。

**当前状态：P0–P6、最终业务模型、基础台账对象化、后端可移植化和全站 UI 重构均已完成并发布生产；Cloudflare Workers + D1 是当前生产基线，Node + SQLite + Filesystem 第二运行时保持可用。当前施工重点转为工程化加固与 P7 真实业务、性能、网络、恢复和运维移交。**
当前业务认证完全由系统自身维护：用户使用 `username + 密码` 登录，浏览器 Web Worker 负责 Argon2id 派生，服务端只保存带运行时 pepper 的 HMAC verifier，并签发 7 天 HttpOnly 会话。邮箱不参与账号体系。需求、储备、资金、实施结算、提醒与分片备份均已有本地实现。

## 交给其他 AI 的入口

1. 先看 [文档导航](docs/README.md)，不要从历史 dated handoff 猜当前基线。
2. 当前代码交接只使用 [AI 交接说明](docs/AI_HANDOFF.md)，避免维护多份容易漂移的 handoff。
3. 业务事实以 [当前业务基线](docs/BUSINESS_BASELINE.md)、[设计方案](docs/DESIGN.md)、[数据模型](docs/DATA_MODEL.md) 为准。
4. 开发前阅读 [测试策略](docs/TESTING.md)：所有新阶段和缺陷修复必须先写验收/回归测试，再改生产代码。
5. 正式环境按 [生产验收矩阵](docs/PRODUCTION_ACCEPTANCE.md) 和 [预检/发布/恢复手册](docs/PRODUCTION_RUNBOOK.md) 执行；不可用合成数据代替真实验收。

## 本地运行

建议 Node.js 24、npm 11（`.nvmrc` 已固定主版本）。仓库根目录 `Makefile` 是常用工程操作的统一入口；`make help` 可查看全部命令。不需要 Cloudflare 账号或令牌即可运行本地开发环境。`make dev` 会复用正式 `npm run dev` 入口并检查/重建本地开发 D1 基线；空库首次打开时通过一次性 bootstrap 创建首个管理员，不再注入合成账号 seed。

```sh
make install
make dev
```

- 前端：<http://127.0.0.1:5173>
- Workers 本地接口：<http://127.0.0.1:8787/api/health>
- Vite 将 `/api` 请求代理到本地 Workers。
- `Ctrl+C` 停止两个服务。Wrangler 使用本地 D1/R2 模拟数据，不访问正式库。

## 检查与构建

```sh
make check      # TypeScript + build + Node/Web 全量门禁
make test       # make check + Headless Chromium UI E2E（复用 check 已生成的 Web build）
make test-ui    # 仅运行真实无头 UI 验收
make audit      # Git 真源工程卫生 + production dependency security audit
```

该命令是统一质量门禁：运行生产代码和测试代码 TypeScript 检查、前端构建、Worker **dry-run** 打包、当前开发迁移基线检查、真实本地 workerd + D1 集成测试、production 认证、会话/权限/并发/原子性，以及 Vue 行为合同测试。Node 测试均使用独立临时 D1，不污染日常本地库。详细规则见 `docs/TESTING.md`。

`make build`/`npm run build` 都不会发布网站。生产发布仍只能走受保护的 GitHub `Production promote` workflow；`make production` 只是安全的一键入口，会先要求当前位于 clean、与 `origin/main` 完全同步的 `main`，再触发并等待该 workflow，**不会直接执行 `wrangler deploy`**。只读预检与资源清单分别使用 `make production-preflight`、`make production-inventory`。

## 目录

```text
apps/web/                Vue 3 + Vite + Router + Naive UI 管理台
apps/api/                Hono + Workers 业务接口与 Wrangler 配置
apps/api/migrations/     当前开发期 D1 数据库基线；正式上线后改为追加式迁移
packages/shared/         按业务域拆分的前后端共享契约，@tpm/shared 保持统一公共入口
tests/                   迁移守卫、Workers+D1、并发/原子性、production 鉴权测试
apps/web/tests/          Vue 行为合同测试
docs/                   完整设计、实施计划、测试策略、数据模型、部署与 AI 交接
.github/workflows/       CI、只读生产预检/清单与受保护 Production promote
```

## 已确定的业务边界

基础台账采用“电压等级 → 线路 → 杆塔”，正式需求位置只引用台账对象。业务主线为“抽象需求 → 项目储备 → 一次项目级出库 → 多执行任务 → 任务物资供应 / 实施 / 结算三线并行 → 四状态回投需求”。出库指项目获准进入实施，不是仓库发货。业务账号由系统自己维护 username、密码、会话、角色和授权范围；不依赖 Cloudflare Access，也不要求邮箱验证。Cloudflare 仅作为托管/网络基础设施，后续技术维护使用受托人的独立 Cloudflare 身份和 CI 服务身份。

P7 仍需要代表性的真实业务资料完成抽样验收，包括需求填报、年度事项、储备分类、框架/协议/费用和执行历史。仓库不保存这些原件；是否已经取得、当前版本和保管位置必须在受控环境中现场确认，不能根据旧文档状态推断。

参考：[WorkBuddy 基本示例](https://www.workbuddy.link/p/plhvulKoyaQX5vic8Oaeoy?source=2)。参考页面中的数据仅用于理解功能，不随仓库发布为正式台账。

## 上线与费用

参见 [Cloudflare 运行与部署](docs/DEPLOYMENT.md)。默认目标是免费起步，域名另计；免费配额不是 SLA，R2 超额可能计费。全球网络不等于大陆加速，正式上线前必须实测目标用户网络。

本仓库不附加开源许可证，默认保持私有。原始业务文件、备份、密钥及本地数据库不应提交到 Git。
