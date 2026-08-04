# 智慧农业灌溉

该示例演示智慧农业灌溉决策微服务：标准 Fetch API 接收土壤湿度观测，应用从
`@go-like/config` 的当前不可变配置读取阈值、传感器最大时效和单次水量上限。

## 主要演示

- `@go-like/config` 管理完整灌溉策略；Core hook 在 HTTP Server 启动前执行 `load`，停止后执行 `close`。
- `@go-like/context` 贯穿请求、应用用例与配置读取边界。
- `@go-like/web` 提供 runtime 无关的标准 Fetch Handler。
- 业务策略与配置 provider、HTTP 载体相互独立。

## 源码结构

- `src/irrigation-policy.ts`：湿度、观测时效和水量决策规则。
- `src/irrigation-config.ts`：灌溉策略 Config 构造。
- `src/service.ts`：从 Config 当前值执行 Context-first 灌溉决策。
- `src/http.ts`：灌溉决策的标准 Fetch 路由。
- `src/main.ts`：唯一直接执行入口，由 Core hook 管理 Config，并由 Server 生命周期管理 HTTP。

程序入口通过 Core hook 管理 Config；业务测试直接使用与 go-kratos 对齐的 `load / close` 契约。

## 业务不变量

- 未来时间或超过 `maxReadingAgeMs` 的观测一律 fail closed，不执行灌溉。
- 湿度达到阈值时水量必须为零。
- 干旱观测的计划水量不得超过 Config 当前值中的 `maxLiters`。
- 湿度百分比必须位于 0 到 100，时间和水量必须使用安全数值。

## 接口

`POST /v1/irrigation-decisions`

```json
{
  "fieldId": "field-1",
  "soilMoisturePercent": 20,
  "observedAt": 1784736000000,
  "requestedLiters": 80
}
```

## 验证

```sh
bun run --cwd examples/smart-agriculture-irrigation typecheck
bun run --cwd examples/smart-agriculture-irrigation test:unit
```

## 直接运行

```bash
HOST=127.0.0.1 PORT=3000 bun run --filter @go-like/example-smart-agriculture-irrigation start
```

`start` 会先构建本地 go-like 包，再由 `start:prepared` 把 `src/main.ts` 构建为
`.artifacts/main.mjs` 并启动。看到 `GO_LIKE_EXAMPLE_READY` 后提交新鲜观测；决策会读取
Config 发布的当前灌溉策略：

```bash
NOW=$(($(date +%s) * 1000))
curl -sS http://127.0.0.1:3000/v1/irrigation-decisions \
  -H 'content-type: application/json' \
  -d "{\"fieldId\":\"field-1\",\"soilMoisturePercent\":20,\"observedAt\":$NOW,\"requestedLiters\":80}"
```

前台按 `Ctrl-C` 或向 Node 进程发送 `SIGTERM`，Core 会停止 HTTP Server，并在 `afterStop` hook 中关闭 Config。

本示例不模拟阀门、传感器网络、天气服务或数据库；生产系统应将固定 Config source 替换为
已支持的配置中心，并由设备控制微服务消费已接纳的决策。
