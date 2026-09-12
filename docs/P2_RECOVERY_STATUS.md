# P2 恢复与完成记录（2026-09-12）

## 1. 恢复时基线

本记录中的恢复起点是远端 `main` HEAD `ea72d8c`；该值只用于说明 P2 从何处恢复，不代表当前远端 HEAD。

P1.2 已完成并推送：
- `ad05dd0 feat: replace Access with local account authentication`
- `ea72d8c docs: record P1.2 completion`

P1.2 完整门禁结果：31/31 Node/workerd+D1 + 11/11 Vue，共 42 项 PASS。认证模型已经锁定：系统自维护 username/password；浏览器 Web Worker 执行 Argon2id；服务端只做 HMAC-SHA256 verifier；数据库不保存明文密码或浏览器派生凭据；7 天 HttpOnly 会话；邮箱/Cloudflare Access 不参与业务认证。

## 2. P2 WIP 恢复历史

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

## 3. 恢复后问题处理结果

恢复时的旧认证测试夹具已经修复：`DemandsView.test.ts` 改用 `authSource: 'session'`、删除 `email`，并补齐 P1.2 后必填的 `username`、`mustChangePassword`。随后 `npm run typecheck` 转绿。

进一步测试审计发现并修复了三个真实 P2 收尾问题：

1. 分片上传、校验和发布原先没有由客户端显式提交 `expectedVersion`，条件更新失败后存在返回 409 但前序语句已写入的半批风险。现在三类写操作都要求 `expectedVersion`，版本/状态守卫、业务写入和幂等记录处于同一个 D1 batch，并有 stale version/并发回归测试。
2. `/demands` 虽已有 `DemandsView.vue`，路由仍指向占位页。现已切换为真实页面，并改成懒加载以避免把 P2 重业务页塞进首屏主包。
3. `/api/health` 与界面阶段徽标仍停留在 P1.2。现已统一更新为 P2。

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

恢复到 P1.2 新认证基线后已经重新执行完整门禁，不再沿用旧测试结论。最终 `npm run check` 全绿：43/43 Node/workerd+D1 + 26/26 Vue/Vitest，共 69 项 PASS；TypeScript、Vite 生产构建和 Worker dry-run 同时通过。

## 5. 完成核对结果

1. `DemandsView.test.ts` 旧认证夹具已迁到 P1.2 当前模型。
2. P2 定向后端测试 11/11、P2/路由相关前端测试全部通过。
3. `0002_p2_import_demands_materials.sql` 已与当前 `0001` 对齐，并加入 `tests/migrations.lock.json` checksum 锁。
4. P1.2→P2 数据保留测试覆盖成员、scope、活动会话、自定义设置和审计。
5. 分片上传、校验、发布均覆盖 stale version 和并发原子性，失败写入不会留下半批数据。
6. `/demands` 已懒加载真实 `DemandsView.vue`；生产构建主入口 JS 降至约 458.65 kB，不再触发 500 kB 主包警告。
7. 完整 `npm run check` 已全绿，实施计划、测试策略、完整交接和短交接均已更新。
8. 恢复用 stash 仍保留作本机备份；P2 已完成，后续入口改为 P3。除非明确需要清理，本次不 drop stash。

## 6. 不能回退的决定

- 不恢复 Cloudflare Access / 邮箱登录。
- 不把 Argon2/PBKDF2 慢 KDF 放到 Worker 服务端。
- 当前尚未正式上线，因此 P1.2 已重整开发 schema；从现在 P2 开始按当前 `0001` 为基础继续。
- 测试先于业务代码；发现缺陷先补回归测试。
- 不提交真实 Excel、账号密码、pepper、bootstrap token、生产数据库或备份。
