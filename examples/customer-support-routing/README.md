# 客户支持工单路由

该示例演示客服工单路由微服务：标准 Fetch API 接收带语言和优先级的支持请求，先筛选符合技能约束的
客服实例，再调用 `@likego/registry` round-robin selector 分配实际 endpoint。

## 主要演示

- Registry `ServiceInstance` 快照与 selector 的应用侧显式组合。
- `@likego/context` 作为路由应用和存储操作的首个参数。
- 标准 Fetch Handler 与路由服务、实例选择、运行入口分离。
- 语言、资历与工单幂等规则的业务测试。

## 业务不变量

- 中文工单只能分给中文技能实例，英文工单只能分给英文技能实例。
- `urgent` 工单只能分给 `senior` 实例，`standard` 工单可以使用同语言的所有实例。
- 同一 case 的相同路由请求必须返回原分配；语言或优先级冲突的重放必须失败。
- 新工单只在同一候选集合内轮转，不跨语言污染游标结果。

## 接口

`POST /v1/support/cases/route`

```json
{
  "caseId": "case-1001",
  "language": "zh",
  "priority": "urgent"
}
```

## 文件结构

- `src/service.ts`：客服工单类型、校验和 Context-first 路由用例。
- `src/routing.ts`：客服实例快照、技能筛选、轮询和幂等分配。
- `src/http.ts`：标准 Fetch 请求解码与响应映射。
- `src/main.ts`：组装并运行 LikeGo HTTP App；这是唯一直接执行入口。
- `test/main.test.ts`：语言技能、优先级、幂等冲突、无实例和 HTTP 测试。

## 验证

```sh
bun run --filter @likego/example-customer-support-routing typecheck
bun run --filter @likego/example-customer-support-routing test
```

本示例使用静态的 resolver 结果来演示 selector，不宣称连接 Consul、etcd、Kubernetes 或客服平台，
因此不需要 Docker。

## 直接运行

```sh
bun run --filter @likego/example-customer-support-routing start
```

看到 `LIKEGO_EXAMPLE_READY=...` 后提交一个真实路由请求：

```sh
curl -sS http://127.0.0.1:3000/v1/support/cases/route \
  -H 'content-type: application/json' \
  -d '{"caseId":"case-demo","language":"zh","priority":"urgent"}'
```

按 `Ctrl+C` 发送 `SIGINT`，或执行 `kill -TERM <pid>`，LikeGo 会有序停止 HTTP Server。
