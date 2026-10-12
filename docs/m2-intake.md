# M2 限定来源采集：本地试点指南

## 范围与前提

M2 只做 Vanish 指定会话、Confluence 指定页面的读取，以及可编辑产品草案。开发、测试、发布仍是模拟。
采集进程与桌面 Codex 已连接的 MCP 不自动共享认证或传输配置；需为这个本地进程配置可启动的 MCP server，
或在本机提供经认证的 MCP HTTP 地址。没有配置时控制台可登记范围，但 `intake:once/watch` 无法读取。
不要把真实公司正文、MCP 凭证、`.env`、本地连接器配置提交到 Git。

试点负责人先确认：具体会话名称和稳定 sessionCode、具体页面和数字 pageId、账号读取权限、
是否允许本地持久化正文、历史读取窗口、保留/删除要求。只对已确认的范围点选“添加范围”。
Vanish 会话名称不是 sessionCode；先通过可信方式核对代码。Confluence 链接需提取页面 ID，
当前不支持按 URL 直接抓取、搜索空间、跟随子页面或附件。

## 启动与配置

先按 README 启动数据库、迁移和 API。已有 M1 `.env` 运行 `npm run setup:intake`，然后重启 API。
新安装运行 `npm run setup:local` 会生成三个不同的令牌。采集器只用 `INTAKE_API_TOKEN`；
操作台仍使用 `CONTROL_API_TOKEN`，模拟 Worker 使用 `WORKER_API_TOKEN`。

将 `.mcp-connectors.example.json` 复制为 `.mcp-connectors.local.json`，填入本机真实服务配置。
支持 `stdio` 的绝对可执行程序路径和参数，或 `http` 的 loopback MCP 地址。
HTTP 仅允许 localhost/127.0.0.1/::1；配置文件不会进入 Git。不要把包含密钥的命令行参数或 URL 放进可共享日志。
若公司 MCP 只存在于 Codex 内部连接，需先提供独立客户端可用的安全连接方式；平台不会借用聊天权限。

在操作台创建/选择项目，添加允许读取的范围。首次建议只登记一个会话和一个页面，
手动运行一次：

```sh
npm run intake:once
```

核对来源快照、扫描状态、条目数和最近来源版本，必要时停用范围。
确认后可运行 `npm run intake:watch`，约每 60 秒扫描一次；Ctrl-C 停止。
Vanish 每轮最多读取前 5 页，每页 50 条；超出显示 `partial`，不表示已覆盖全部历史。
Confluence 每轮仅读指定页面。没有稳定增量游标，也不保证检测删除、权限撤回或未返回的历史修改。
不应长期无人值守运行；事件、收据和正文尚无自动清理。

## 产品草案与来源变更

操作台选择当前来源，生成草案。初稿只抽取标题、原文片段并加入阻塞问题，
不是 AI 对 PRD 的理解。人工需填写本次范围、具体需求、验收方法与预期结果，清空阻塞问题，
保存修订，再批准。批准产生不可变的 ready Requirement；启动的交付仍只运行模拟四阶段。
控制台目前编辑单条需求/单条验收草案；复杂多条结构使用 API。

来源内容变化后以新 revision 存储；旧 review 草案及 draft/ready 需求标记 `stale`。
已有交付保留原绑定摘要并标记 `input_stale=true`，不会悄悄修改输入或自动取消。
负责人应查看差异后决定是否取消原模拟、生成新草案和新交付。

## 故障与核对

- `access_denied`：检查 MCP 身份及该会话/页面的授权，勿扩大到其他范围试探。
- `invalid_provider_response`：实际 MCP 输出与严格适配格式不同；在私有环境核对字段，不把原始正文写入公开测试。
- `transport_error`：检查独立 MCP server 是否可由本地采集器启动或访问。
- `partial`：分页上限仍有更多内容；不能视作全量归档。调整试点窗口或经审查增加分段回补能力。
- `source_revision_conflict`：同一远端 ID/revision 返回不同正文；需查明提供方版本语义，不能覆盖旧记录。

MCP 客户端有合成 stdio 握手测试、工具白名单测试；PostgreSQL 集成测试覆盖扫描去重、
失败记录、来源失效和原子回滚。真实 Vanish/Confluence 响应、权限与分页行为仍需使用上述限定试点验证。
