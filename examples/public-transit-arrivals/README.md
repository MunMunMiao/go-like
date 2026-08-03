# 公共交通到站预测

## 行业问题

公交和轨道交通到站屏只能展示足够新鲜的车辆观测。旧预测即使仍指向未来，也不能继续误导乘客；同一车辆的新观测必须替换旧观测。

## 独有业务不变量

- 查询结果只包含 freshness 窗口内的预测。
- 同一站点与车辆只保留最新观测。
- 迟到的旧观测不得覆盖较新的预测。

## 源码结构

- `src/service.ts`：到站模型、最新观测存储、freshness 查询和预测源 readiness。
- `src/http.ts`：预测写入、到站查询以及可复用 Handler。
- `src/main.ts`：唯一直接执行入口，挂载业务及健康路由并管理 HTTP 生命周期。

## LikeGo 能力

使用 `@likego/context` 贯穿发布和查询操作，使用 `@likego/web` 暴露标准 Fetch 的预测发布与到站查询入口，并使用 `@likego/health` 把实时预测源 freshness 纳入 readiness。

## 验证矩阵

| 场景                       | 证据                                  |
| -------------------------- | ------------------------------------- |
| 过滤过期预测               | `test/main.test.ts` 的 freshness 用例 |
| 最新观测胜出               | `test/main.test.ts` 的更新顺序用例    |
| 预测源 freshness readiness | `test/main.test.ts` 的健康探针用例    |
| 标准 Fetch 入口            | `test/main.test.ts` 的 HTTP 用例      |

```bash
bun run --filter @likego/example-public-transit-arrivals typecheck
bun run --filter @likego/example-public-transit-arrivals test:unit
```

## Docker 判定

本案例使用内存预测仓储，不声明已连接 GTFS-Realtime、车辆定位或站台屏系统，因此不需要 Docker。接入真实消息源后，应以可复现的固定数据流增加集成验证。

## 非目标

不计算道路 ETA、不解析 GTFS、不进行地图匹配，也不控制真实站台显示设备。

## 直接运行

```bash
bun run --filter @likego/example-public-transit-arrivals start
```

`start` 会先构建本地 LikeGo 包，再由 `start:prepared` 把 `src/main.ts` 构建为
`.artifacts/main.mjs` 并启动。看到 `LIKEGO_EXAMPLE_READY` 后发布一条实时预测，再查询到站数据：

```bash
NOW=$(($(date +%s) * 1000))
curl -i http://127.0.0.1:3000/v1/arrival-predictions \
  -H 'content-type: application/json' \
  -d "{\"stopId\":\"stop-demo\",\"vehicleId\":\"bus-7\",\"observedAt\":$NOW,\"arrivalAt\":$((NOW + 300000))}"
curl -i "http://127.0.0.1:3000/v1/stops/stop-demo/arrivals?now=$NOW&maxAgeMs=60000"
curl -i http://127.0.0.1:3000/readyz
```

可用 `HOST`、`PORT` 覆盖监听地址；按 `Ctrl-C` 或发送 `SIGTERM` 停止。
