# 餐厅后厨工单路由

该示例演示餐饮门店的后厨路由微服务：标准 Fetch API 接收制作工单，在分配前通过
`@likego/health` 检查目标档口的实时就绪状态，再用 `@likego/registry` round-robin selector
在该档口的多个厨房实例之间分配工作。

## 主要演示

- 用 readiness probe 阻止工单进入暂停或故障档口。
- 用 Registry selector 在同类厨房实例之间公平轮转。
- `@likego/context` 作为应用与基础设施操作的首个参数。
- `service.ts`、`routing.ts`、`http.ts` 与唯一运行入口 `main.ts` 的职责拆分。

## 业务不变量

- 制作数量必须是 1 到 50 的安全整数，工单与档口标识必须来自受控集合。
- 未就绪档口不得产生新分配，其他档口不受影响。
- 同一工单只能绑定一个档口；相同请求重放返回原分配，冲突档口请求失败。
- 同档口的新工单按稳定的实例集合轮转。

## 接口

`POST /v1/kitchen/tickets/route`

```json
{
  "ticketId": "ticket-1001",
  "station": "grill",
  "itemCount": 3
}
```

## 文件结构

- `src/service.ts`：工单类型、业务校验和 Context-first 路由用例。
- `src/routing.ts`：健康探针、厨房实例快照和轮询分配。
- `src/registry.ts`：可选的真实 Node mDNS App 注册装配。
- `src/http.ts`：标准 Fetch 请求解码与响应映射。
- `src/main.ts`：组装并运行 LikeGo HTTP App；这是唯一直接执行入口。
- `test/main.test.ts`：就绪隔离、幂等冲突、轮询和 HTTP 边界测试。

## 验证

```sh
bun run --filter @likego/example-restaurant-kitchen-routing typecheck
bun run --filter @likego/example-restaurant-kitchen-routing test:unit
```

默认模式只使用内存工单表、健康探针和静态厨房实例，因此不需要 Docker，也不宣称接入 POS、KDS 或真实
厨房设备。若门店局域网需要发布该路由服务，可显式启用 `@likego/registry-mdns`：

```bash
MDNS_REGISTRY=1 MDNS_INTERFACE=en0 HOST=192.168.1.20 \
  bun run --filter @likego/example-restaurant-kitchen-routing start
```

`HOST` 必须是所选网卡的真实地址。启用后使用 Node UDP multicast host 完成实际注册与注销；socket 或协议
失败会直接使生命周期失败，不会退回静态 Registry。`MDNS_DOMAIN` 可覆盖默认 discovery domain。

## 直接运行

```bash
bun run --filter @likego/example-restaurant-kitchen-routing start
```

看到 `LIKEGO_EXAMPLE_READY` 后路由一张厨房工单：

```bash
curl -i http://127.0.0.1:3000/v1/kitchen/tickets/route \
  -H 'content-type: application/json' \
  -d '{"ticketId":"ticket-demo","station":"grill","itemCount":3}'
```

默认监听 `127.0.0.1:3000`，支持 `HOST`、`PORT` 覆盖；按 `Ctrl-C` 或发送 `SIGTERM` 停止。
