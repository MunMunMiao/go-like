# 媒体转码流水线

该示例演示媒体转码微服务：标准 Fetch API 接收转码任务，结构式 Worker 只有在
`@go-like/core` App 成功启动后才接受任务，并由 App 统一停止和等待 Server 的 `start(ctx)` Promise。

## 主要演示

- `@go-like/core` 管理自定义 Worker Server 的启动和停止。
- `@go-like/context` 作为任务提交和 Worker 生命周期操作的首个参数。
- `@go-like/web` 输出可嵌入任意支持标准 Fetch API 的 runtime Handler。
- 任务规则、Worker、HTTP 路由和进程生命周期按真实职责拆分。

## 源码结构

- `src/transcode-jobs.ts`：转码任务、输出键和幂等规则。
- `src/transcode-worker.ts`：实现 go-like `Server` 的进程内转码 Worker。
- `src/service.ts`：组合任务提交操作与 Fetch Handler，并向入口暴露 Worker Server。
- `src/http.ts`：转码任务的标准 Fetch 路由。
- `src/main.ts`：唯一 App 组装根，由 Core 按依赖顺序管理 Worker 和 HTTP Server。

## 业务不变量

- 媒体源必须使用 HTTPS，任务时长必须是正安全整数。
- profile 只有 `audio-aac` 和 `video-720p`，输出扩展名由 profile 唯一决定。
- 相同 `jobId` 与相同载荷的重试幂等；同 ID 不同载荷必须拒绝。
- Worker 未启动或已经停止时不得接受任务。

## 接口

`POST /v1/transcode-jobs`

```json
{
  "jobId": "job-1",
  "inputUrl": "https://media.example/input.mov",
  "profile": "video-720p",
  "durationSeconds": 60
}
```

## 验证

```sh
bun run --cwd examples/media-transcoding-pipeline typecheck
bun run --cwd examples/media-transcoding-pipeline test:unit
```

## 直接运行

```bash
HOST=127.0.0.1 PORT=3000 bun run --filter @go-like/example-media-transcoding-pipeline start
```

`start` 会先构建本地 go-like 包，再由 `start:prepared` 把 `src/main.ts` 构建为
`.artifacts/main.mjs` 并启动。看到 `GO_LIKE_EXAMPLE_READY` 后提交任务：

```bash
curl -sS http://127.0.0.1:3000/v1/transcode-jobs \
  -H 'content-type: application/json' \
  -d '{"jobId":"job-1","inputUrl":"https://media.example/input.mov","profile":"video-720p","durationSeconds":60}'
```

请求由 Core 已启动的 Transcode Worker 处理。前台按 `Ctrl-C` 或向 Node 进程发送 `SIGTERM` 可触发完整排空。

本示例不伪装 FFmpeg、对象存储、GPU 或消息队列；内存 Worker 只验证 go-like 对自定义
后台 Server 生命周期的承接方式。接入真实转码器时保留相同 `Server` 和 Context 边界即可。
