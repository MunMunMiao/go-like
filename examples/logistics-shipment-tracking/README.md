# 物流轨迹状态推进

该示例处理物流事件常见的乱序和重复问题：包裹状态只能向前推进，旧事件
和重复事件不能让当前状态倒退，同一个事件标识也不能被复用于不同内容。

## 架构与职责

- `src/service.ts`：物流状态规则、事件去重、单调推进仓储与轨迹接收用例。
- `src/cache.ts`：当前物流快照 Cache 与缓存轨迹服务组合。
- `src/http.ts`：标准 Web API 请求解析与响应映射。
- `src/main.ts`：唯一可执行入口，组合缓存轨迹服务、HTTP Server 与进程信号。

`POST /v1/tracking-events` 返回 `applied`、`duplicate` 或 `stale`。
本示例不声明已连接承运商消息总线或持久化数据库。
缓存保存的是经过乱序与重复判定后的当前快照，而不是未经验证的入站事件；旧事件因此无法污染查询侧状态。
Memory Cache 构造后即可使用，不需要伪造 Core `Server` 生命周期。

## 直接运行

```bash
HOST=127.0.0.1 PORT=3000 bun run --filter @likego/example-logistics-shipment-tracking start
```

看到 `LIKEGO_EXAMPLE_READY` 后提交轨迹；HTTP 链路会把确认后的当前投影写入 LikeGo Cache：

```bash
curl -sS http://127.0.0.1:3000/v1/tracking-events \
  -H 'content-type: application/json' \
  -d '{"eventId":"event-1","shipmentId":"shipment-1","status":"created","occurredAt":1784736000000}'
```

前台按 `Ctrl-C` 或向 Node 进程发送 `SIGTERM`，Core 会依次停止 HTTP Server 与投影缓存。
