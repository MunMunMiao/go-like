# 实时游戏匹配

## 主要演示

演示一个面向在线游戏的匹配微服务：外部请求使用标准 Fetch API，应用层按地区和技能差进行组队，基础设施层使用 `@likego/registry` 的轮询 Selector 为已完成的对局选择游戏服节点。

## 独有业务不变量

- 不同地区的玩家绝不进入同一局。
- 技能分差超过配置上限的玩家不能配对。
- 同一玩家不能同时占据两个待匹配队列位置。
- 同地区连续对局在可用游戏服端点之间公平轮询。

## 源码结构

- `src/service.ts`：地区、技能差、对局身份和 Context-first 配对操作。
- `src/match-resources.ts`：进程内等待队列与 Registry 轮询 Selector。
- `src/registry.ts`：可选 Kubernetes EndpointSlice App 注册装配。
- `src/http.ts`：加入匹配的标准 Fetch 路由，并组合可复用 Handler。
- `src/main.ts`：唯一直接执行入口，预置游戏服快照并管理 HTTP 生命周期。

## LikeGo 能力

除 `@likego/context` 和 `@likego/web` 外，本例实际调用 `@likego/registry` 的
`newRoundRobinSelector`，并在测试中证明连续对局落到不同端点。默认节点来自显式内存快照。设置
`KUBERNETES_API_ADDRESS` 后，当前匹配服务会通过 `@likego/registry-kubernetes` 向指定 namespace
写入真实 EndpointSlice；业务游戏服快照仍保持显式，不把 App 自注册伪装成游戏服发现。

## 验证

```bash
bun run --filter @likego/example-live-game-matchmaking typecheck
bun run --filter @likego/example-live-game-matchmaking test:unit
```

默认模式无需 Docker。真实 Kubernetes 注册模式还需要 `KUBERNETES_NAMESPACE`、可选
`KUBERNETES_TOKEN`，以及对 EndpointSlice 的最小 RBAC；API 不可用或无权限时启动会失败，不会返回假成功。
生产系统仍应由真实 Discovery 快照替换静态游戏服节点，并迁移进程内等待队列。

## 直接运行

在仓库根目录启动常驻 HTTP 小程序：

```bash
bun run --filter @likego/example-live-game-matchmaking start
```

`start` 会先构建本地 LikeGo 包，再由 `start:prepared` 把 `src/main.ts` 构建为
`.artifacts/main.mjs` 并启动。看到 `LIKEGO_EXAMPLE_READY` 后，在另一个终端加入匹配队列：

```bash
curl -i http://127.0.0.1:3000/v1/matches \
  -H 'content-type: application/json' \
  -d '{"requestId":"demo-1","playerId":"player-1","region":"eu-west","skillRating":1000}'
```

可用 `HOST=0.0.0.0 PORT=3100` 覆盖监听地址。按 `Ctrl-C` 或向进程发送 `SIGTERM` 停止，LikeGo Core 会先关闭 HTTP Server 再退出。
