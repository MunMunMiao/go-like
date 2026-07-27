# 广告活动投放

## 主要演示

演示一个广告投放微服务：在标准 Fetch 入口完成流量准入，选择出价最高的有效活动，通过受熔断器保护的素材源加载创意，并在创意成功后原子扣减预算。

## 独有业务不变量

- 只有版位和受众都匹配的启用活动可以竞价。
- 每次展示选择最高有效出价；预算不足的活动自动退出竞价。
- 同一 `requestId` 重试只扣减一次预算，不同内容复用该 ID 必须冲突。
- 素材加载失败时不得扣减活动预算。

## 源码结构

- `src/campaigns.ts`：活动、定向、竞价资格和幂等规则。
- `src/ad-resources.ts`：预算仓储、素材源和 Memory Cache 网关。
- `src/service.ts`：组合限流、素材读取、预算提交、Fetch Handler 与立即可用的 Memory Cache。
- `src/http.ts`：广告投放的标准 Fetch 路由。
- `src/main.ts`：唯一 App 组装根，预置演示活动并管理 HTTP 生命周期。

## LikeGo 能力

本例实际运行 `@likego/cache-memory`、`@likego/resilience` 的 Token Bucket 与 Circuit Breaker；Memory Cache 不伪造 Server 生命周期。测试证明缓存命中、限流、熔断以及失败不扣预算，而不是只在依赖清单中声明能力。

## 验证

```bash
bun run --filter @likego/example-ad-campaign-serving typecheck
bun run --filter @likego/example-ad-campaign-serving test:unit
```

本例无需 Docker：素材源、预算仓储和 Cache 都是明确的进程内实现，不宣称具备多实例预算一致性。生产环境应以具备条件更新的预算数据库和共享缓存替换它们。

## 直接运行

```bash
bun run --filter @likego/example-ad-campaign-serving start
```

`start` 会先构建本地 LikeGo 包，再由 `start:prepared` 把 `src/main.ts` 构建为
`.artifacts/main.mjs` 并启动。程序预置一项首页体育活动和素材。看到
`LIKEGO_EXAMPLE_READY` 后请求广告：

```bash
curl -i http://127.0.0.1:3000/v1/ads:serve \
  -H 'content-type: application/json' \
  -d '{"requestId":"demo-1","placement":"home","audienceSegment":"sports"}'
```

Core App 拥有 HTTP Server 的生命周期；Creative Cache 随服务对象内存释放。可用 `HOST`、`PORT` 覆盖地址；按 `Ctrl-C` 或发送 `SIGTERM` 停止。
