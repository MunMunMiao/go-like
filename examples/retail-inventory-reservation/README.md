# 全渠道零售库存预占

## 行业问题

门店、仓库与线上渠道并发抢占同一 SKU 时，系统必须保证不超卖；同一个请求重试不能重复扣减，而重复使用幂等键提交不同内容必须失败。

## 独有业务不变量

- `available >= 0` 始终成立。
- 同一 `requestId` 和相同内容返回同一预占；相同 ID、不同内容返回冲突。
- 失效时间必须晚于受理时刻。

## 架构与职责

```text
main（进程与生命周期）
  -> HTTP（Request / Response）
  -> inventory service（规则、用例、进程内仓储）
  -> LikeGo Cache Memory（库存查询缓存）
```

- `src/service.ts`：库存规则、进程内仓储、Cache 读写和 Context-first 用例。
- `src/http.ts`：标准 Web API 请求解析与响应映射。
- `src/main.ts`：唯一可执行入口，组合 LikeGo App、Cache、HTTP Server 与进程信号。

## LikeGo 能力

使用 `@likego/cache-memory` 缓存 `GET /v1/inventory/:sku` 的库存读模型；预占成功后写入最新可用量，避免返回旧库存。Memory Cache 构造后即可使用，`@likego/core` 只负责 HTTP Server 的启动和停止，`@likego/web` 暴露标准 Fetch Handler。

## 验证矩阵

| 场景             | 证据                                         |
| ---------------- | -------------------------------------------- |
| 并发模型下不超卖 | `test/main.test.ts` 的可用量断言             |
| 幂等重试与冲突   | `test/main.test.ts` 的同 ID 正反用例         |
| Cache 实际读写   | `test/main.test.ts` 的查询、预占、再查询用例 |
| 标准 Fetch 入口  | `test/main.test.ts` 的 POST 与 GET 请求用例  |

```bash
bun run --filter @likego/example-retail-inventory-reservation typecheck
bun run --filter @likego/example-retail-inventory-reservation test:unit
```

## 直接运行

在仓库根目录启动完整小程序：

```bash
bun run --filter @likego/example-retail-inventory-reservation start
```

看到 `LIKEGO_EXAMPLE_READY=...` 后，可查询预置的 `mug` 库存并提交预占：

```bash
curl -sS http://127.0.0.1:3000/v1/inventory/mug
curl -sS http://127.0.0.1:3000/v1/reservations \
  -H 'content-type: application/json' \
  -d '{"requestId":"demo-1","sku":"mug","quantity":2,"expiresAt":4102444800000}'
```

默认监听 `127.0.0.1:3000`，可使用 `HOST`、`PORT` 覆盖；按 `Ctrl-C` 或发送
`SIGTERM` 时，Core 会关闭 HTTP Server；进程内 Cache 随应用内存释放。

## Docker 判定

本案例只验证可移植的应用核心与单进程原子边界，不宣称数据库级并发，因此不需要 Docker。生产部署必须将仓储替换为带条件更新或事务约束的真实库存数据库；若案例加入该依赖，就必须增加固定版本 Docker E2E。

## 非目标

不实现订单、支付、商品目录或跨仓调拨，也不把内存仓储表述为多实例生产数据库。
