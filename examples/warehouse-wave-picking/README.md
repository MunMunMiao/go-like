# 仓储波次拣货租约

该示例演示仓储任务的租约与 fencing token：有效租约只能由一个工人持有，
租约过期后可以恢复执行，但旧持有者不能再用过期 token 完成任务。

## 架构与职责

- `src/service.ts`：任务与租约规则、递增 fencing token 的内存仓储及获取、完成用例。
- `src/worker.ts`：把工人的租约所有权实现为结构式 go-like `Server`；
  `start` 获取租约，Core 反向排空时由 `stop` 释放租约。
- `src/http.ts`：标准 Web API 请求解析与响应映射。
- `src/main.ts`：唯一可执行入口，组合租约 Worker、HTTP Server 与进程信号。

## HTTP 接口

- `POST /v1/pick-tasks/{taskId}/lease`
- `POST /v1/pick-tasks/{taskId}/complete`

本示例验证调度算法，不声明已接入 BullMQ、数据库锁或分布式租约服务。
`newApp(server(worker))` 证明 worker 不需要继承框架基类：只要实现
`start(ctx): Promise<void>` 与 `stop(ctx): Promise<void>`，Core 就能管理租约生命周期。

## 直接运行

```bash
HOST=127.0.0.1 PORT=3000 bun run --filter @go-like/example-warehouse-wave-picking start
```

看到 `GO_LIKE_EXAMPLE_READY` 后，为预置任务 `wave-1` 获取租约：

```bash
curl -sS http://127.0.0.1:3000/v1/pick-tasks/wave-1/lease \
  -H 'content-type: application/json' \
  -d '{"workerId":"picker-1","leaseMs":60000}'
```

程序还让结构式 Worker 持有独立的 `worker-task`，用于演示 Core 的租约释放。前台按 `Ctrl-C` 或向 Node 进程发送 `SIGTERM` 会停止 HTTP Server，并释放 Worker 租约。
