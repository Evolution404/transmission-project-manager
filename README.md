# 输电项目全流程管理台

面向 20 人以内团队的项目管理应用，计划采用 Cloudflare Workers、D1、R2，免费额度内运行，支持电脑和手机访问。

**当前状态：仅完成项目初始化，业务功能尚未实现，未部署到 Cloudflare。**
已有 Vue 占位页、Hono 健康接口、共享接口类型、本地资源配置及 CI。健康检查成功只表示接口运行，不代表数据库、权限、邮件或业务功能已经可用。

## 交给其他 AI 的入口

1. 阅读 [AGENTS.md](AGENTS.md)。
2. 阅读 [AI 交接说明](docs/AI_HANDOFF.md)，其中有可直接复制的任务提示词。
3. 按 [实施计划](docs/IMPLEMENTATION_PLAN.md) 从 **P1** 开始，完成一个阶段后更新状态。
4. 业务依据为 [设计方案](docs/DESIGN.md)，数据与 API 约定见 [数据模型](docs/DATA_MODEL.md)。

## 本地运行

建议 Node.js 24、npm 11（`.nvmrc` 已固定主版本）。不需要 Cloudflare 账号或令牌即可运行本地骨架。

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

该命令依次运行 TypeScript 检查、前端构建、Worker **dry-run** 打包，以及真实本地 workerd 的静态资源/API 路由冒烟测试。`npm test` 单独运行时需先 `npm run build`；测试使用端口 8799。

`npm run build` 不会发布网站。当前没有自动部署工作流，也没有生产凭据。

## 目录

```text
apps/web/                Vue 3 + Vite 前端骨架
apps/api/                Hono + Workers 接口骨架与本地 Wrangler 配置
apps/api/migrations/     后续数据库迁移目录（当前无业务表）
packages/shared/        前后端共享接口类型
tests/                  本地 Workers 集成冒烟测试
docs/                   完整设计、实施计划、数据模型、部署与 AI 交接
.github/workflows/      仅检查、不部署的 CI
```

## 已确定的业务边界

需求 → 储备 → 项目出库 → 实施 → 结算。出库指项目获准进入实施，不包含完整物资仓库管理。需求转储备采用系统建议、人工确认，预算统计口径可配置，通知采用邮件。

尚未取得原始需求 Excel、“一年工作早知道”和“项目储备类别”文件；开发可以使用明确标注的合成数据，真实字段映射和价格规则需用原件验收。

参考：[WorkBuddy 基本示例](https://www.workbuddy.link/p/plhvulKoyaQX5vic8Oaeoy?source=2)。参考页面中的数据仅用于理解功能，不随仓库发布为正式台账。

## 上线与费用

参见 [Cloudflare 运行与部署](docs/DEPLOYMENT.md)。默认目标是免费起步，域名另计；免费配额不是 SLA，R2 超额可能计费。全球网络不等于大陆加速，正式上线前必须实测目标用户网络。

本仓库不附加开源许可证，默认保持私有。原始业务文件、备份、密钥及本地数据库不应提交到 Git。
