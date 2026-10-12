# M1 API 合同

服务地址默认 `http://127.0.0.1:4318`。JSON 响应中的数据库快照使用 snake_case；
命令输入和命令确认使用 camelCase。所有成功请求返回 200；失败为结构化错误，
例如 `{ "error": "lease_stale", "requestId": "..." }`。

## 认证和重试

控制端点：`Authorization: Bearer <CONTROL_API_TOKEN>`。
`/internal/` 端点：`Authorization: Bearer <WORKER_API_TOKEN>`。
两种密钥不能相同或互换。Worker ID 从服务端配置取得。
`GET /health` 和静态操作台不需要密钥，但不会返回业务数据。

所有 POST（heartbeat 除外）必须提供 `Idempotency-Key`，1–120 字符，仅字母、数字和 `_.:-`。
推荐每个逻辑命令一个 UUID。同一网络请求重试使用原 key，新的轮询或新命令使用新 key。
尤其注意：重复领取命令会重放原 job 或 null，不会重新调度。
心跳依赖当前租约进行校验，每次有效请求延长至 `min(now + leaseMs, deadline)`。

请求头需要 `Content-Type: application/json`。最大正文 64 KiB。

## 控制 API

| 方法 | 路径 | 输入/用途 |
| --- | --- | --- |
| GET | `/health` | 数据库连通性；200 或 503 |
| GET | `/v1/contracts` | 当前实际合同的 JSON Schema |
| GET | `/v1/projects` | 最近 100 个项目 |
| POST | `/v1/projects` | `{name}` |
| GET | `/v1/projects/:id/snapshot` | 项目、来源、需求和交付全量快照 |
| POST | `/v1/projects/:id/sources` | `{connector: manual\|fixture, externalId, sourceRevision, text}` |
| POST | `/v1/projects/:id/requirements` | 下方需求合同，初始 draft |
| POST | `/v1/requirements/:id/ready` | `{expectedRevision: 1}`，拒绝阻塞问题 |
| POST | `/v1/projects/:id/deliveries` | `{requirementId, requirementDigest, mode: simulation}` |
| GET | `/v1/deliveries/:id` | delivery、jobs、attempts、events；不返回租约 token |
| POST | `/v1/deliveries/:id/control` | `{action: pause\|resume\|cancel, expectedRevision}` |

需求示例（`sourceIds` 必须替换为同项目真实 Source ID）：

```json
{
  "schemaVersion": 1,
  "title": "验证四阶段模拟交付",
  "sourceIds": ["00000000-0000-4000-8000-000000000001"],
  "scope": { "in": ["验证调度协议"], "out": ["真实开发和发布"] },
  "requirements": [{ "id": "R1", "statement": "完成四阶段模拟" }],
  "acceptance": [{
    "id": "AC1",
    "requirementIds": ["R1"],
    "method": "检查模拟任务记录",
    "expected": "四阶段模拟完成"
  }],
  "blockingQuestions": []
}
```

`createRequirement` 返回 `{id, digest, revision: 1, status: draft}`。
保存返回的 digest 创建交付，不能在客户端随意重新排序数组后替换摘要。
控制命令前获取最新交付 revision；普通 Job 事件不一定增加 revision，交付的 phase/control
发生变化时增加。409 revision_conflict 应刷新状态并由调用方重新决策，不能无条件覆盖。

## Worker API

| 方法 | 路径 | 输入/用途 |
| --- | --- | --- |
| POST | `/internal/v1/jobs/claim` | `{capability: simulation}` → `{job: null\|ClaimedJob}` |
| POST | `/internal/v1/jobs/:id/heartbeat` | `{lease: {token, epoch}}` |
| POST | `/internal/v1/jobs/:id/complete` | 成功或失败联合类型 |

ClaimedJob：`id, deliveryId, step, inputDigest, attempt, lease: {token, epoch}, leaseExpiresAt`。
成功结果必须保留领取到的 step 和 inputDigest：

```json
{
  "lease": { "token": "00000000-0000-4000-8000-000000000002", "epoch": 1 },
  "outcome": "succeeded",
  "result": {
    "kind": "simulation",
    "step": "plan",
    "inputDigest": "0000000000000000000000000000000000000000000000000000000000000000",
    "summary": "仅模拟，不代表业务需求实现"
  }
}
```

失败结果：`{lease, outcome: failed, reason: policy_denied, retryable: false}`。
即使 retryable 为 true，次数耗尽也会终止交付。

常见错误：

| HTTP | 代码 | 处理 |
| --- | --- | --- |
| 400 | invalid_request / invalid_json / idempotency_key_required | 修正输入 |
| 401 / 403 | unauthorized / cross_site_forbidden | 检查身份与调用来源 |
| 404 | *_not_found / route_not_found | 检查项目、资源和路径 |
| 409 | idempotency_conflict | 不得用原 key 发送不同命令 |
| 409 | source_revision_conflict | 新正文必须有新来源版本 |
| 409 | requirement_not_ready / requirement_blocked | 完成澄清后建立有效快照 |
| 409 | requirement_digest_conflict / revision_conflict | 刷新上下文并重新决策 |
| 409 | lease_stale | 立即停止提交旧尝试，不使用旧 token 重领 |
| 409 | delivery_terminal / invalid_control_transition | 不重开终态；检查当前控制状态 |
| 413 / 415 | body_too_large / json_required | 减少正文或设置 JSON 类型 |
| 422 | invalid_traceability / source_project_mismatch / result_input_mismatch | 修正语义或上下文 |
| 500 | internal_error | 通过 requestId 定位；无保证失败提交前不要换幂等键 |

现有 API 没有批量/删除/编辑/合并/发布/发消息端点。
