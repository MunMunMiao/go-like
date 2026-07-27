# 制造设备故障维保

## 行业问题

设备在一次连续故障窗口内会反复上报异常信号。如果每条信号都创建工单，维保团队会收到重复任务；只有设备恢复后再次故障，才应创建下一张工单。

## 独有业务不变量

- 同一设备的一个连续故障窗口只创建一张维保工单。
- 窗口内重复故障信号复用当前工单。
- 恢复信号关闭窗口，之后的新故障创建新工单。

## 源码结构

- `src/service.ts`：设备信号、连续故障窗口、工单去重操作和 readiness。
- `src/http.ts`：维保信号的标准 Fetch 路由。
- `src/main.ts`：唯一直接执行入口，挂载业务及健康路由并管理 HTTP 生命周期。

## LikeGo 能力

使用 `@likego/context` 贯穿故障处理，使用 `@likego/web` 暴露可由任意标准 Fetch 运行时承接的信号入口，并使用 `@likego/health` 对维保状态仓储执行服务 readiness 检查。

## 验证矩阵

| 场景             | 证据                               |
| ---------------- | ---------------------------------- |
| 单窗口单工单     | `test/main.test.ts` 的重复故障用例 |
| 恢复后开启新窗口 | `test/main.test.ts` 的恢复用例     |
| 仓储 readiness   | `test/main.test.ts` 的健康探针用例 |
| 标准 Fetch 入口  | `test/main.test.ts` 的 HTTP 用例   |

```bash
bun run --filter @likego/example-manufacturing-maintenance typecheck
bun run --filter @likego/example-manufacturing-maintenance test
```

## Docker 判定

本案例使用内存故障窗口仓储，不声明已连接 PLC、MES、CMMS 或工业消息系统，因此不需要 Docker。接入真实设备或消息代理时，应对其固定版本进行集成验证。

## 非目标

不采集真实传感器数据、不下发设备控制命令，也不执行备件、人员或停机计划排程。

## 直接运行

```bash
bun run --filter @likego/example-manufacturing-maintenance start
```

`start` 会先构建本地 LikeGo 包，再由 `start:prepared` 把 `src/main.ts` 构建为
`.artifacts/main.mjs` 并启动。看到 `LIKEGO_EXAMPLE_READY` 后提交设备故障；
`/livez` 与 `/readyz` 同时暴露真实健康探针：

```bash
curl -i http://127.0.0.1:3000/v1/maintenance-signals \
  -H 'content-type: application/json' \
  -d '{"signalId":"demo-1","machineId":"press-7","kind":"fault","faultCode":"overheat","occurredAt":1000}'
curl -i http://127.0.0.1:3000/readyz
```

可通过 `HOST`、`PORT` 改变监听地址；按 `Ctrl-C` 或发送 `SIGTERM` 可优雅停止。
