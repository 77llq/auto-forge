# Auto Forge

让产品、开发、测试 Agent 在同一条**可暂停、可恢复、可追溯**的交付流程中协作。

当前交付：**M1 本地模拟底座**。可以实际启动数据库、API、操作台与独立模拟 Worker，
运行 `需求录入 → 就绪确认 → plan → implement → verify → review → simulation_completed`。
这里的四个阶段是协议模拟，**没有调用模型，没有修改业务代码，没有执行真实回归测试，没有发布能力**。

## 快速启动

需要 Node.js 24、npm 和运行中的 Docker。默认仅在本机开放 API `127.0.0.1:4318`，
数据库 `127.0.0.1:55438`；不会使用或修改其他项目的数据库。

```sh
npm ci
npm run setup:local
npm run db:up
npm run db:migrate
npm run dev
```

在第二个终端中启动模拟 Worker：

```sh
npm run worker
```

打开 [本地操作台](http://127.0.0.1:4318)，从本地 `.env` 中复制 `CONTROL_API_TOKEN` 到连接框。
令牌只保留在页面内存中，不写入浏览器存储。不要将令牌复制到聊天或提交到 Git。
也可以在第三个终端运行：

```sh
npm run demo
```

演示会创建一套**合成数据**，等待四个模拟任务完成；需先启动 API 和 Worker。
API 重启后未处理事件继续调度；Worker 失联后租约到期可重领。默认租约 30 秒、
每个阶段最多 3 次领取、整个交付最多 1 小时（暂停期间时限仍在计算）。

`setup:local` 生成随机数据库密码和不同的控制/Worker 令牌，已有 `.env` 时不会覆盖。
如果 4318 被占用，可修改 `.env` 的 `PORT`；如果 55438 被占用，需同步修改
`compose.yaml` 端口映射及 `.env` 中的两个数据库 URL。

## 第一版具备什么

| 能力 | 当前实现 |
| --- | --- |
| 输入 | 手动/合成来源、来源版本去重、不可变需求快照、R → AC 验收映射 |
| 状态 | PostgreSQL 持久化，固定四阶段 recipe，事件时间线和原子状态变更 |
| 调度 | 并发领取、租约、epoch fencing、心跳、有限重试、整体超时 |
| 恢复 | 事务 outbox/inbox、幂等收据、调度重放、失联重领 |
| 控制 | 暂停、恢复、取消，版本冲突保护，旧 Worker 结果拒收 |
| 可见性 | 本地操作台、项目/交付一致性快照、结构化事件 |
| 边界 | 控制与 Worker 分离令牌；只绑定本机；不接入真实外部系统 |

产品、开发、测试角色暂时映射为 `plan`、`implement`、`verify` 阶段，`review` 是交付复核阶段。
它们还不是能自主完成业务任务的 Agent。

## 验证

```sh
npm run verify
```

这条命令运行类型检查、合同单元测试、**真实 PostgreSQL** 集成/HTTP 测试及编译。
测试不使用内存数据库替身。测试账户需能在专用 `auto_forge_test` 数据库创建 schema；
每个测试只创建并清理自己的随机 schema，不触碰应用数据。

主要覆盖：并发命令去重、来源版本冲突、跨项目来源校验、需求就绪门禁、固定 digest、
多 Worker 竞争、重复结果、过期租约、暂停/取消晚到结果、outbox 提交前故障、
重放不重复生成下一阶段、重连恢复、重试耗尽、整体超时，以及 API 认证/输入边界。

GitHub Actions 配置同样执行 `npm run verify`。本地通过不等于远端 CI 已通过；
以相应 GitHub 运行结果为准。

编译后可以从仓库根目录启动（保留 `db/` 和 `public/`）：

```sh
node --env-file=.env dist/src/cli/server.js
node --env-file=.env dist/src/cli/worker.js
```

停止服务和 Worker：在对应终端按 Ctrl-C。停止本项目数据库并保留数据：

```sh
npm run db:stop
```

不要通过删除数据库卷解决连接问题。现有卷的密码不会随 `.env` 修改而自动变化。

## 代码结构

```text
src/contracts.ts     严格输入合同与 JSON Schema
src/service.ts       命令、状态机、租约、事务调度和快照
src/db.ts            事务与带校验和的迁移
src/http.ts          本地 HTTP API、权限边界和安全响应
src/worker.ts        独立模拟执行器
src/cli/             API / Worker / 迁移入口
db/                  PostgreSQL 初始化和迁移
public/              无框架本地操作台
tests/               合同、数据库和 HTTP 故障测试
docs/                架构约束、API 和后续实施规范
```

## 文档与下一阶段

- [架构和可靠性规范](docs/architecture.md)
- [API 合同与调用规范](docs/api.md)
- [阶段路线与验收标准](docs/roadmap.md)
- [本地验收记录](docs/validation.md)

下一阶段优先接入**一个明确授权的消息来源 + 一个只读文档来源 + 一个试点仓库**。
先验证来源同步与需求澄清，再开放隔离开发和真实测试；自动发消息、修改任务系统、
合并代码及发布应有独立审批门禁。

不要把当前服务暴露到公网。它没有多人登录、租户权限、速率限制、数据保留策略、
生产监控、密钥管理或生产灾备。详细限制和上线门禁见架构文档。
