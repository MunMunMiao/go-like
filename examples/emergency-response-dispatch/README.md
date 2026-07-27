# 应急响应调度

## 主要演示

演示应急调度微服务如何先执行优先级专属响应时限，再从服务实例快照中筛出区域、能力和 readiness 都匹配的响应单位，最后交给 LikeGo Registry selector 做稳定轮询分配。

## 行业问题与不变量

- `critical` 事件必须在报告后 5 分钟内调度，`urgent` 事件必须在 15 分钟内调度；已经到期的命令拒绝分配。
- 只选择 `zone`、`service` 匹配且 `readiness=ready` 的实例，draining 实例不会收到新事件。
- 同一 `incidentId` 和相同命令稳定返回同一响应单位；更改命令会产生冲突。
- 调度入口和 Registry selector 都尊重调用方 Context 的取消状态。

## 文件职责

- `src/service.ts`：优先级、SLA、调度命令和 Context-first 幂等用例。
- `src/dispatch.ts`：进程内记录仓储和 Registry selector 响应单位目录。
- `src/http.ts`：标准 Fetch 调度入口和可嵌入服务组合。
- `src/main.ts`：配置演示响应单位并运行常驻 LikeGo HTTP App；这是唯一直接执行入口。
- `test/main.test.ts`：优先级时限、取消、readiness 过滤、轮询、幂等和无实例失败。

## LikeGo 能力

`@likego/registry` 的 `newRoundRobinSelector` 实际选择匹配实例并接收完成反馈。测试证明连续事件轮转到不同 endpoint、精确重试不重新选择、无可用实例时 fail closed。

```bash
bun run --filter @likego/example-emergency-response-dispatch typecheck
bun run --filter @likego/example-emergency-response-dispatch test:unit
```

## Docker 判定

本例使用确定性的进程内服务实例快照，没有声明 Consul、etcd 或任何外部 daemon，因此不需要 Docker。若改为动态服务发现，应增加固定版本 Registry provider E2E，并验证实例下线和 watch 重同步。

## 非目标

不实现 911/112 电话接入、地图路径规划、人员排班或真实无线电指令，也不把内存记录当作跨实例事件账本。

## 直接运行

```sh
bun run --filter @likego/example-emergency-response-dispatch start
```

看到 `LIKEGO_EXAMPLE_READY=...` 后，以当前时间提交调度请求：

```sh
NOW=$(($(date +%s) * 1000))
curl -sS http://127.0.0.1:3000/v1/emergency-dispatches \
  -H 'content-type: application/json' \
  -d "{\"incidentId\":\"incident-demo\",\"service\":\"medical\",\"zone\":\"north\",\"priority\":\"critical\",\"reportedAt\":$NOW,\"dispatchBy\":$((NOW + 300000))}"
```

按 `Ctrl+C` 发送 `SIGINT`，或执行 `kill -TERM <pid>`，LikeGo 会有序停止 HTTP Server。
