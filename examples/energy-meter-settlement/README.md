# 电力计量结算

该示例演示电力计量结算微服务：标准 Fetch API 接收月度电表读数，应用从
`@likego/config` 的当前不可变配置读取固定分时费率，并以整数最小货币单位生成结算结果。

## 主要演示

- `@likego/config` 作为费率配置来源，由 Core hook 在 HTTP Server 启动前 `load`、停止后 `close`。
- `@likego/context` 作为所有应用操作的首个参数。
- `@likego/web` 将 Context-first 入口适配为标准 Fetch `Handler`。
- 结算规则、费率配置、HTTP 路由和进程生命周期按真实职责拆分。

## 源码结构

- `src/meter-settlement.ts`：电表读数、分时费率与纯结算规则。
- `src/tariff-config.ts`：固定费率 Config 构造。
- `src/service.ts`：从 Config 当前值执行 Context-first 电量结算。
- `src/http.ts`：计量结算的标准 Fetch 路由。
- `src/main.ts`：唯一直接执行入口，由 Core hook 管理 Config，并由 Server 生命周期管理 HTTP。

业务测试直接使用与 go-kratos 对齐的 `load / close` 契约。

## 业务不变量

- 计量周期必须是 `YYYY-MM`，用电量和费率必须是非负安全整数。
- `peak` 与 `offPeak` 费率必须显式匹配，不能回退到任意默认值。
- 金额只使用整数最小货币单位；乘积超出安全整数范围时 fail closed。
- Config 在构造时复制费率，调用方之后的对象修改不能改变运行中的结算结果。

## 接口

`POST /v1/energy-settlements`

```json
{
  "accountId": "account-1",
  "meterId": "meter-1",
  "period": "2026-07",
  "tariffBand": "peak",
  "kilowattHours": 12
}
```

## 验证

```sh
bun run --cwd examples/energy-meter-settlement typecheck
bun run --cwd examples/energy-meter-settlement test
```

本示例不模拟电网、抄表设备、数据库或动态配置中心；固定 `objectSource` 只用于证明 Config
加载、读取与关闭语义，生产系统应替换为已支持的 Consul、etcd 或 Vault Config provider。

## 直接运行

```bash
bun run --filter @likego/example-energy-meter-settlement start
```

`start` 会先构建本地 LikeGo 包，再由 `start:prepared` 把 `src/main.ts` 构建为
`.artifacts/main.mjs` 并启动。Core 的 `beforeStart` hook 加载 Config 并发布峰谷电价。看到
`LIKEGO_EXAMPLE_READY` 后执行结算：

```bash
curl -i http://127.0.0.1:3000/v1/energy-settlements \
  -H 'content-type: application/json' \
  -d '{"accountId":"account-demo","meterId":"meter-demo","period":"2026-07","tariffBand":"peak","kilowattHours":12}'
```

可用 `HOST`、`PORT` 覆盖监听地址；按 `Ctrl-C` 或发送 `SIGTERM` 时，Core 会关闭 HTTP，并在 `afterStop` hook 中关闭 Config。
