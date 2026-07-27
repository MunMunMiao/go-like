# 末端配送派单

## 行业问题

末端配送系统需要把订单分配给仍有承载余量且当前健康可用的配送员。只看距离而忽略容量或健康状态，会产生无法履约的派单。

## 独有业务不变量

- 不得向不健康的配送员派单。
- 累计分配容量不得超过配送员容量。
- 相同配送请求重试必须返回同一结果，冲突复用请求标识必须失败。

## 架构与职责

- `src/service.ts`：派单规则、容量扣减、幂等仓储、用例与 readiness 探针。
- `src/http.ts`：标准 Web API 请求解析与响应映射。
- `src/main.ts`：唯一可执行入口，组合派单服务、HTTP Server 与进程信号。

## LikeGo 能力

使用 `@likego/context` 把取消状态传入派单仓储，使用 `@likego/web` 暴露可嵌入任意标准 Fetch 运行时的入口，并使用 `@likego/health` 把健康配送容量纳入服务 readiness。

## 验证矩阵

| 场景                        | 证据                               |
| --------------------------- | ---------------------------------- |
| 跳过不健康配送员            | `test/main.test.ts` 的健康过滤用例 |
| 容量上限与幂等              | `test/main.test.ts` 的容量用例     |
| 容量耗尽触发 readiness 失败 | `test/main.test.ts` 的健康探针用例 |
| 标准 Fetch 入口             | `test/main.test.ts` 的 HTTP 用例   |

```bash
bun run --filter @likego/example-last-mile-dispatch typecheck
bun run --filter @likego/example-last-mile-dispatch test
```

## Docker 判定

本案例使用明确的内存配送员目录，不声明已连接地图、车队或订单外部系统，因此不需要 Docker。接入真实调度服务后，应针对该服务增加固定版本的集成验证。

## 非目标

不实现路径规划、地图匹配、司机定位、计价或移动端推送。

## 直接运行

```bash
bun run --filter @likego/example-last-mile-dispatch start
```

看到 `LIKEGO_EXAMPLE_READY=...` 后提交配送派单请求：

```bash
curl -sS http://127.0.0.1:3000/v1/dispatches \
  -H 'content-type: application/json' \
  -d '{"deliveryId":"delivery-demo","requiredCapacity":2}'
```

按 `Ctrl+C` 发送 `SIGINT`，或执行 `kill -TERM <pid>`，LikeGo 会有序停止 HTTP Server。
