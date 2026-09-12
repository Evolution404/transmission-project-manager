# 数据库迁移

当前没有业务表，也没有应用任何迁移。首个实施任务需根据 `docs/DATA_MODEL.md`
编写版本化 SQL，使用 `0001_identity_and_settings.sql` 等递增文件名。

本地执行（在仓库根目录）：

```sh
npm exec --workspace @tpm/api -- wrangler d1 migrations apply transmission-project-manager-local --local
```

本地数据位于 `.wrangler/`，已被 Git 忽略。初始化配置中的数据库 ID 是本地占位符。
正式库使用单独配置，不得把本地假数据或示例费用当作正式数据迁入。
