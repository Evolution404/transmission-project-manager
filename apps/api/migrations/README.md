# 数据库 Schema 基线

当前项目仍处于开发阶段，数据库采用**单一可重建基线**：

`0001_initial_schema.sql`

## 开发阶段规则

- migrations 目录只能存在这一个 SQL 文件。
- 除非用户明确要求兼容已有数据或保留升级路径，否则禁止新增 `0002+` migration。
- schema 变化直接修改 `0001_initial_schema.sql`，并同步更新 `tests/migrations.lock.json` 中唯一 checksum。
- 本地开发启动器检测到 `0001` checksum 变化或旧 migration 历史时，会重建本地 D1，再使用 Wrangler 标准 migration 命令重新应用当前基线。
- 不保留旧 schema 兼容层，不编写补丁 migration，不为历史开发版本增加升级 workaround。

## 何时允许追加 migration

只有用户明确要求“兼容已有数据 / 保留升级路径”后，才进入版本化 migration 模式。届时应先冻结当前基线，再为后续变化新增 migration，并补充真实的数据保留、升级和回退测试。

## 本地验证

```sh
npm exec --workspace @tpm/api -- wrangler d1 migrations apply transmission-project-manager-local --local
```

标准命令必须能够从空数据库一次应用 `0001_initial_schema.sql`；不得依赖 `d1 execute --file`、手工写 `d1_migrations` 或其他特殊处理。
