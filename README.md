# 输电项目全流程管理台

面向 20 人以内团队的项目管理应用，计划采用 Cloudflare Workers、D1、R2，免费额度内运行，支持电脑和手机访问。

**当前状态：P0、P1、P1.1 已完成并通过本地验收；下一步进入 P2 Excel 导入、需求池与物资字典；尚未部署到 Cloudflare。**
已有 Vue Router + Naive UI 管理台框架、Cloudflare Access JWT 鉴权、D1 成员/范围/配置版本/字典/审计/幂等表、本地开发 seed、共享接口类型和 CI。需求、储备、资金、实施结算、提醒与备份仍未实现，页面中的后续模块保持真实空状态。

## 交给其他 AI 的入口

1. 阅读 [AGENTS.md](AGENTS.md)。
2. 阅读 [AI 交接说明](docs/AI_HANDOFF.md)，其中有可直接复制的任务提示词。
3. 按 [实施计划](docs/IMPLEMENTATION_PLAN.md) 从 **P2** 开始；P1.1 的成员生命周期、范围授权和运维移交边界已完成。
4. 业务依据为 [设计方案](docs/DESIGN.md)，数据与 API 约定见 [数据模型](docs/DATA_MODEL.md)。

## 本地运行

建议 Node.js 24、npm 11（`.nvmrc` 已固定主版本）。不需要 Cloudflare 账号或令牌即可运行本地开发环境。`npm run dev` 会先应用本地 D1 迁移并执行仅本地使用的合成身份 seed。

```sh
npm ci
npm run dev
```

- 前端：<http://127.0.0.1:5173>
- Workers 本地接口：<http://127.0.0.1:8787/api/health>
- Vite 将 `/api` 请求代理到本地 Workers。
- `Ctrl+C` 停止两个服务。Wrangler 使用本地 D1/R2 模拟数据，不访问正式库。

## 检查与构建

```sh
npm run check
```

该命令依次运行 TypeScript 检查、前端构建、Worker **dry-run** 打包，以及真实本地 workerd + D1 的 P1 集成测试。测试会应用本地迁移和合成 seed，覆盖身份、角色、范围、停用成员、配置版本/幂等、字典与API回退；测试使用端口 8799。

`npm run build` 不会发布网站。当前没有自动部署工作流，也没有生产凭据。

## 目录

```text
apps/web/                Vue 3 + Vite + Router + Naive UI 管理台
apps/api/                Hono + Workers 鉴权/基础配置接口与 Wrangler 配置
apps/api/migrations/     D1 追加式数据库迁移
apps/api/seeds/          仅本地开发/测试使用的合成数据
packages/shared/         前后端共享接口类型
tests/                   本地 Workers + D1 集成测试
docs/                   完整设计、实施计划、数据模型、部署与 AI 交接
.github/workflows/      仅检查、不部署的 CI
```

## 已确定的业务边界

需求 → 储备 → 项目出库 → 实施 → 结算。出库指项目获准进入实施，不包含完整物资仓库管理。需求转储备采用系统建议、人工确认，预算统计口径可配置，通知采用邮件。账号采用 Cloudflare Access 身份认证 + 应用内成员授权双层模型；日常业务成员管理不应要求资产所有者登录 Cloudflare，后续技术维护使用受托人的独立 Cloudflare 身份和 CI 服务身份。

尚未取得原始需求 Excel、“一年工作早知道”和“项目储备类别”文件；开发可以使用明确标注的合成数据，真实字段映射和价格规则需用原件验收。

参考：[WorkBuddy 基本示例](https://www.workbuddy.link/p/plhvulKoyaQX5vic8Oaeoy?source=2)。参考页面中的数据仅用于理解功能，不随仓库发布为正式台账。

## 上线与费用

参见 [Cloudflare 运行与部署](docs/DEPLOYMENT.md)。默认目标是免费起步，域名另计；免费配额不是 SLA，R2 超额可能计费。全球网络不等于大陆加速，正式上线前必须实测目标用户网络。

本仓库不附加开源许可证，默认保持私有。原始业务文件、备份、密钥及本地数据库不应提交到 Git。
