# Cloudflare 生产资源只读盘点

核对日期：2026-09-14。

## 目的

当 Cloudflare Dashboard 因安全验证暂时无法进入时，使用 GitHub Actions 的 `Production Cloudflare inventory (read-only)` 工作流读取正式账号的非敏感资源元数据，避免根据历史 acceptance 配置猜测生产资源。

此工作流只用于**资源识别和证据采集**，不代表生产配置、migration、发布或验收已经完成。

## 安全边界

工作流：`.github/workflows/production-cloudflare-inventory.yml`

- 仅 `workflow_dispatch`；
- 仅允许从 `main` 运行；
- 绑定 GitHub `production` Environment；
- `permissions.contents=read`；
- Cloudflare 调用全部为 HTTP GET；
- 不执行 Worker deploy；
- 不执行 D1 migration / D1 SQL；
- 不创建、修改或删除 Worker、D1、R2、Zone、域名；当前 production 使用 Notion，因此 R2 盘点仅作为可选能力；
- 不读取或输出 Secret 值；
- 不读取业务表行内容；
- 临时 API 响应只保存在 GitHub runner 的临时目录，结束时删除；
- GitHub Step Summary 只记录非敏感资源元数据。

## Token

生产资源盘点、D1 migration 和 Worker release 统一使用 GitHub `production` Environment Secret：

`CLOUDFLARE_API_TOKEN`

只维护这一把 Cloudflare CI Token，不再要求额外配置 `CLOUDFLARE_READ_API_TOKEN`。

Token 的权限范围应限制在本项目所在的 Cloudflare Account 和 `980923.xyz` Zone，禁止使用 Global API Key、浏览器 Cookie，禁止把 Token 写入仓库、PR、Issue、Actions 输出、普通文档或前端代码。

虽然 inventory 复用同一 Token，但 workflow 本身仍只有 GET 请求，因此盘点流程不会执行 deploy、migration、创建、修改或删除操作。

## 输入

手工运行时必须输入：

`account_id`
: 32 位 Cloudflare Account ID。

仓库历史 `wrangler.acceptance.jsonc` 中出现过 account id `642d30520d6c494dd418b1f4b3853aa6`，它只能作为历史线索，不能据此认定生产账号或生产资源。运行盘点前仍应由账号所有者确认目标 Account ID。

## 输出

工作流只在 GitHub Step Summary 输出：

- Workers：名称、创建/修改时间；
- D1：名称、UUID、表数量、文件大小、创建时间；
- R2：若已启用则列出 bucket 名称、位置、存储类别、创建时间；若 Cloudflare 返回 `10042`，记录为“R2 not enabled”并继续盘点，不视为 Notion production 的失败；
- Worker Custom Domains：hostname、绑定 Worker、Zone；
- Zones：域名、状态、类型、Zone ID。

D1 `file_size` / `num_tables` 可用于初步判断数据库是否只是空资源，但不能替代业务数据对账。真正决定是否可 migration 前，仍需按 `docs/P7_RUNBOOK.md` 对目标 D1 做停写、备份、migration 状态和业务数据核对。

## 使用顺序

1. 在 GitHub `production` Environment 中长期只配置 3 个 Secrets：`CLOUDFLARE_API_TOKEN`、`AUTH_CREDENTIAL_PEPPER`、`NOTION_API_TOKEN`；不配置 production Variables；
2. 从 `main` 手工运行 `Production Cloudflare inventory (read-only)`；workflow 直接从受审 `apps/api/wrangler.production.jsonc` 读取 Account ID；
3. 根据输出区分 production / acceptance / 其他历史资源；
4. 正式 Worker、独立 D1、自定义域名和对象存储 provider 的非敏感资源 ID 直接维护在 `apps/api/wrangler.production.jsonc`；当前 provider 为 Notion，R2 未启用不阻塞；
5. 运行 `Production preflight (no deployment)`；
6. 只有完成数据保护并确认 schema 需要升级时才运行独立 D1 migration；
7. schema ready 后才进入 `Production release`。

盘点成功本身不能标记 P7-06 或“生产发布完成”。
