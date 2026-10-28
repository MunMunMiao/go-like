# 冷链温度监控

该示例演示冷链监控微服务：标准 Fetch API 接收运输传感器读数，应用从 `@go-like/config`
的当前不可变配置读取允许温区，判定越界状态，并把每票货物的最后序列写入内存台账。

## 主要演示

- Core hook 在 HTTP Server 启动前加载 Config，并在停止后关闭 Config。
- `@go-like/context` 从入口一路传入监控应用和读数台账。
- 标准 Fetch Handler 与监控服务、Config、运行入口分离。
- 无外部 daemon 的可重复业务测试。

## 业务不变量

- 最低温必须小于最高温；边界值本身属于允许温区。
- 温度必须是 -100 到 100 摄氏度之间的有限数，读数序列必须是正安全整数。
- 同一票货物的序列只能递增；完全相同的序列重放幂等，冲突或过期读数失败。
- Config 发布前不得判定读数，构造后的调用方对象修改不能改变已发布规则。

## 接口

`POST /v1/cold-chain/readings`

```json
{
  "shipmentId": "shipment-1001",
  "sensorId": "sensor-a",
  "sequence": 12,
  "temperatureC": 4.5
}
```

## 文件结构

- `src/service.ts`：温区规则、读数校验和 Context-first 监控用例。
- `src/config.ts`：Config 构造与单调序列内存台账。
- `src/http.ts`：标准 Fetch 请求解码与响应映射。
- `src/main.ts`：通过 hook 加载 Config 并运行 HTTP Server；这是唯一直接执行入口。
- `test/main.test.ts`：温区边界、Config 当前值、序列幂等和未就绪测试。

程序由 Core hook 管理 Config；业务测试直接使用与 go-kratos 对齐的 `load / close` 契约。

## 验证

```sh
bun run --filter @go-like/example-cold-chain-monitoring typecheck
bun run --filter @go-like/example-cold-chain-monitoring test:unit
```

本示例不连接 IoT broker、时序数据库、告警平台或真实传感器，因此不需要 Docker；生产接入应替换
内存台账和固定 `objectSource`。

## 直接运行

```bash
bun run --filter @go-like/example-cold-chain-monitoring start
```

Core 的 `beforeStart` hook 加载 Config 并发布 `2°C..8°C` 规则。看到 `GO_LIKE_EXAMPLE_READY` 后上报读数：

```bash
curl -i http://127.0.0.1:3000/v1/cold-chain/readings \
  -H 'content-type: application/json' \
  -d '{"shipmentId":"shipment-demo","sensorId":"sensor-a","sequence":1,"temperatureC":4.5}'
```

可用 `HOST`、`PORT` 覆盖监听地址；按 `Ctrl-C` 或发送 `SIGTERM` 时，Core 会关闭 HTTP，并在 `afterStop` hook 中关闭 Config。
