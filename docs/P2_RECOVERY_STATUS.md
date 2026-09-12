# P2 恢复状态（2026-09-12）

## 1. 当前基线

远端 `main` 当前 HEAD：`ea72d8c`。

P1.2 已完成并推送：
- `ad05dd0 feat: replace Access with local account authentication`
- `ea72d8c docs: record P1.2 completion`

P1.2 完整门禁结果：31/31 Node/workerd+D1 + 11/11 Vue，共 42 项 PASS。认证模型已经锁定：系统自维护 username/password；浏览器 Web Worker 执行 Argon2id；服务端只做 HMAC-SHA256 verifier；数据库不保存明文密码或浏览器派生凭据；7 天 HttpOnly 会话；邮箱/Cloudflare Access 不参与业务认证。

## 2. P2 WIP 当前工作区状态

P2 在 P1.2 重构前保存于：
`stash@{0}: On main: wip P2 before P1.2 local account auth`

该 stash 已执行 `git stash apply`，**stash 本身仍保留**，作为恢复备份，不要立即 drop。

恢复时产生的三处内容冲突已经人工合并并用 `git add` 标记 resolved：
- `apps/api/src/app.ts`
- `packages/shared/src/index.ts`
- `tests/migrations.test.mjs`

合并原则：保留 P1.2 当前账号/会话认证，只接回 P2 业务路由和类型；禁止恢复旧 Access/邮箱身份代码。

P2 迁移已调整为当前开发基线后的：
- `0001_p1_identity_and_config.sql`
- `0002_p2_import_demands_materials.sql`

P2 当前新增/恢复文件主要包括：
- `apps/api/migrations/0002_p2_import_demands_materials.sql`
- `apps/api/src/p2.ts`
- `apps/web/src/imports/parser.ts`
- `apps/web/src/imports/import.worker.ts`
- `apps/web/src/imports/workerClient.ts`
- `apps/web/src/imports/workflow.ts`
- `apps/web/src/views/DemandsView.vue`
- `apps/web/tests/DemandsView.test.ts`
- `apps/web/tests/import-parser.test.ts`
- `apps/web/tests/import-worker-client.test.ts`
- `apps/web/tests/import-workflow.test.ts`
- `tests/p2-import.test.mjs`

P2 路由已经重新挂载：`app.route('/api', p2App)`。

## 3. 当前已知失败点

恢复并解决冲突后已运行：
`npm run typecheck`

API 和 shared 类型检查通过；Web 只剩两个旧认证测试夹具错误，均在：
`apps/web/tests/DemandsView.test.ts`

错误：
1. `authSource: 'development'` 已不再合法，应改为 `authSource: 'session'`。
2. `CurrentUser` 已没有 `email` 字段，应删除该测试夹具中的 `email`。

先修这两个测试夹具，再重新运行 `npm run typecheck`。

## 4. P2 已有实现/测试意图

P2 目标仍是：Excel 导入、需求池、物资字典。

此前测试驱动已经覆盖/实现过的能力包括：
- `.xlsx` / UTF-8 `.csv` 浏览器解析；`.xls` 明确拒绝。
- 浏览器 Web Worker 解析，不把完整 Excel 放 Worker API 服务端解析。
- CSV 中文乱码已通过回归测试修复。
- CSV/XLSX 标量标准化，避免同一业务因文件格式不同得到不同类型。
- 20 行上传分片；服务端二次校验。
- 导入批次、行级错误/警告、校验、发布、来源追溯。
- 同源文件/行幂等，合法相同业务需求不做错误字符串去重。
- 导入中断后继续上传/校验/发布。
- 映射模板持久化。
- 需求列表/详情与标准物资维护。
- 失败校验应展示工作表、源行号、错误/警告明细。

在 P1.2 插入前，P2 的核心 API、解析器、Worker、workflow 测试曾分别转绿，但恢复到新认证基线后必须重新跑完整门禁，不能沿用旧结论直接标完成。

## 5. 下一步顺序

1. 修 `DemandsView.test.ts` 两个旧认证夹具。
2. 运行 `npm run typecheck`。
3. 运行 P2 定向测试：`tests/p2-import.test.mjs` 和 `apps/web/tests/*import*`、`DemandsView.test.ts`。
4. 检查 `0002_p2_import_demands_materials.sql` 与当前 `0001` 的外键/字段是否完全一致。
5. 补/恢复“P1.2 已有账号/范围/审计 → P2 迁移后数据不丢”的迁移测试。
6. 继续审查分片上传、校验、发布的原子性；特别确认失败/版本冲突不留下半批数据。
7. 把 `/demands` 路由从占位页切换到 `DemandsView.vue`（若尚未完成）。
8. 完整运行 `npm run check`。
9. 更新 `docs/IMPLEMENTATION_PLAN.md`、`docs/AI_HANDOFF.md`；P2 真正全绿后再提交、推送。
10. 确认 P2 提交稳定后才考虑 `git stash drop stash@{0}`。

## 6. 不能回退的决定

- 不恢复 Cloudflare Access / 邮箱登录。
- 不把 Argon2/PBKDF2 慢 KDF 放到 Worker 服务端。
- 当前尚未正式上线，因此 P1.2 已重整开发 schema；从现在 P2 开始按当前 `0001` 为基础继续。
- 测试先于业务代码；发现缺陷先补回归测试。
- 不提交真实 Excel、账号密码、pepper、bootstrap token、生产数据库或备份。
