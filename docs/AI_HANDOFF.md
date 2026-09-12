# 给下一位 AI 的交接

## 当前状态

用户要求本轮只初始化项目、将计划写入仓库并提交GitHub，剩余业务实现交给其他AI。

已建立：npm workspaces、Vue占位页、Hono `/api/health`、共享API类型、Wrangler本地D1/R2占位配置、构建/类型检查/workerd冒烟测试入口、GitHub CI和完整设计文档。

尚未实现：业务数据库迁移、Excel导入、需求/储备/物资、框架协议预算、出库实施结算、登录权限、分类分析、定时任务、发信、备份及正式Cloudflare部署。页面“接口已连接”只验证进程存活，不能代表这些功能完成。

**下一步从 P1 开始。** 不要重新搭建仓库或推翻已确认的Cloudflare路线。

## 阅读顺序

1. [AGENTS.md](../AGENTS.md)：工作约定与业务底线。
2. [DESIGN.md](DESIGN.md)：用户需求、口径、默认值和参考示例观察。
3. [DATA_MODEL.md](DATA_MODEL.md)：对象、数量金额约束与API规则。
4. [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)：P1–P7依赖、交付和验收。
5. [DEPLOYMENT.md](DEPLOYMENT.md)：本地与生产的区别、Cloudflare限制。

## 可直接复制给 AI 的提示词

```text
请接手这个仓库的后续实现。先阅读 AGENTS.md、docs/AI_HANDOFF.md、
docs/DESIGN.md、docs/DATA_MODEL.md、docs/IMPLEMENTATION_PLAN.md。
当前只有初始化骨架。按实施计划先完成 P1（身份权限、配置、迁移和应用框架），
不要将其他未实现阶段标为完成，也不要用示例数据伪造真实业务。
保持 Cloudflare 免费起步、Vue + TypeScript + Hono + D1 + R2 的架构。
不需要再次询问已经在文档中确定的需求。原始Excel缺失时使用合成测试数据，
将真实文件核验留到 P7；缺少Cloudflare生产凭据时先完成本地可验证实现。
完成 P1 后运行 npm run check 和该阶段验收，更新实施计划与交接说明，
总结完成范围、检查结果、迁移与未验证事项，并按当前任务授权提交代码。
```

## 本地命令

```sh
npm ci
npm run dev
# 另一个终端，或停止开发服务器后：
npm run check
```

开发端口：5173/8787，冒烟测试端口：8799。生产资源ID未配置，无需登录Cloudflare即可运行骨架。`npm run build:worker`只是dry-run打包，不发布资源。

## 不能遗漏的设计细节

- 预算总额和预算发生流水是两回事，切换报表口径不能混加各账目。
- 需求物资分配表保证数量守恒；储备项目与框架子项目同ID。
- 混合类别项目按金额分摊，大类映射全系统共用；缺价不能变成零价。
- 历史实施可以没有出库，但必须显式标记；后续关联不能重复统计。
- 实施/结算独立、允许先结算；部分进度不等于全量完成。
- 提醒在服务端调度，关闭浏览器仍应执行。免费10ms是CPU时间，不是网络等待；异步不绕过CPU限制。
- 默认全球网络、不备案、不买服务器，不承诺大陆必然快速或固定香港路由。

## 外部材料与待验证项

- 可读参考：https://www.workbuddy.link/p/plhvulKoyaQX5vic8Oaeoy?source=2 。仅作为功能和布局参考。
- 尚缺：原始需求Excel、“一年工作早知道”、“项目储备类别”、真实单价/框架/协议资料。
- 尚缺：生产Cloudflare账户资源、可用自定义域名、Access成员名单和验证后的邮件收件人。
- 未测：完整业务、真实文件映射、Cloudflare线上CPU/配额、大陆网络、真实发信与恢复。
- 已提供的本地测试只覆盖骨架集成路由。CI实际结果查看仓库Actions。

## 后续交接记录

每完成阶段在此追加：阶段、提交号、完成内容、测试、未完成/未验证项和明确下一步。不要删除原始边界说明。
