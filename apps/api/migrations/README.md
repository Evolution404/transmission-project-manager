# 数据库迁移

当前开发 schema 使用按编号递增的 D1 migration，最新要求由 `apps/api/src/schema.ts` 的 `REQUIRED_MIGRATION` 明确声明，并由仓库测试强制要求它始终等于最新 committed migration。

## 本地开发

正常从仓库根目录启动即可：

```sh
npm run dev
```

API 开发启动器会先执行全部待应用的本地 migration，再启动 Wrangler；运行期间如果 `apps/api/migrations/*.sql` 新增或变化，会自动再次执行 migration apply。业务 API 同时有 schema readiness 门禁：数据库落后于代码要求时返回 `503 SCHEMA_OUTDATED`，不会继续执行到缺表 SQL。

如需手工执行迁移：

```sh
npm exec --workspace @tpm/api -- wrangler d1 migrations apply transmission-project-manager-local --local
```

健康检查：

```sh
curl http://127.0.0.1:8787/api/health
```

应看到 `schema.ready=true`，且 `currentMigration` 已包含 `requiredMigration`。

本地数据位于 `.wrangler/`，已被 Git 忽略。初始化配置中的数据库 ID 是本地占位符。

## 正式环境

正式环境不得依赖用户访问页面时自动迁移，也不得把本地假数据或示例费用迁入正式库。发布流程必须先显式完成并验证正式 D1 migration，再切换新 Worker；migration 失败时停止发布。运行时 schema readiness 仍保留为最后一道 fail-closed 门禁。
