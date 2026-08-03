# 房地产搜索索引

## 主要演示

演示一个房地产搜索微服务：接收带版本号的房源投影更新，为城市、价格和卧室数查询建立缓存，并在新版本应用后精确失效受影响城市的查询结果。

## 独有业务不变量

- 只有启用且同时满足城市、最高价格和最少卧室数的房源可以返回。
- 旧版本更新不能覆盖新投影。
- 同一版本出现不同内容必须报告冲突。
- 新版本应用后，受影响城市的旧查询缓存必须失效；重复查询可直接命中缓存。

## 调用链

```text
Fetch Request
  -> http.ts（索引与搜索 API）
  -> service.ts（版本校验、缓存读写与城市级失效）
  -> repository.ts（内存房源投影）
  -> Memory Cache（由业务服务直接持有）
```

- `src/service.ts`：房源版本、查询边界和 Context-first 索引与搜索用例。
- `src/repository.ts`：版本感知的内存投影仓储。
- `src/http.ts`：标准 Fetch Handler。
- `src/cache.ts`：组合标准 Handler，并暴露真实 Memory Cache 与投影仓储资源。
- `src/main.ts`：唯一创建 Core App 的可执行入口，只挂载拥有真实监听资源的 HTTP Server。
- `test/main.test.ts`：查询边界、修订冲突、缓存命中和失效测试。

## LikeGo 能力

本例使用构造后即可工作的 `@likego/cache-memory`，完成缓存写入、读取和更新后的删除。测试通过仓储查询计数证明第二次查询命中缓存、版本更新后重新读取权威投影。

## 验证

```bash
bun run --filter @likego/example-real-estate-search-index typecheck
bun run --filter @likego/example-real-estate-search-index test:unit
```

## 直接运行

```bash
HOST=127.0.0.1 PORT=3000 bun run --filter @likego/example-real-estate-search-index start
```

看到 `LIKEGO_EXAMPLE_READY` 后写入投影并查询：

```bash
curl -sS http://127.0.0.1:3000/v1/listings \
  -H 'content-type: application/json' \
  -d '{"listingId":"listing-1","city":"Shanghai","priceMinor":50000000,"bedrooms":2,"active":true,"revision":1}'
curl -sS 'http://127.0.0.1:3000/v1/listings/search?city=Shanghai&maximumPriceMinor=60000000&minimumBedrooms=2'
```

查询真实的进程内 Memory Cache。前台按 `Ctrl-C` 或向 Node 进程发送 `SIGTERM` 可停止整个程序。

本例无需 Docker：索引和 Cache 都是明确的进程内实现，不宣称替代 Elasticsearch、OpenSearch 或共享缓存。需要跨实例查询时再引入真实搜索引擎并增加固定版本 Docker E2E。
