# @go-like/croner

Croner `Schedule`。公开入口只有 `@go-like/croner/job`。它只计算下一次到期时间，不启动原生定时器，也不拥有一次运行。把结果交给 `@go-like/core/job` 的 `newScheduleServer`。

## 依赖

| 种类 | 包              | 范围     |
| ---- | --------------- | -------- |
| peer | `@go-like/core` | `0.0.1`  |
| 常规 | `croner`        | `11.0.0` |

没有可选 peer。`@go-like/core` 的 dev 依赖是 `workspace:*`。通道可移植。

`CronerScheduleOptions` 只接受时刻表选项：`timezone`、`utcOffset`、`domAndDow`、`dayOffset`、`mode`、`startAt`、`stopAt`。`paused`、`catch`、`protect`、`maxRuns` 属于 schedule server。

## 示例

```ts
import { newApp, server } from "@go-like/core"
import { newScheduleServer } from "@go-like/core/job"
import { newCronerSchedule } from "@go-like/croner/job"

const report = newScheduleServer(newCronerSchedule("*/10 * * * * *"), "report", async () => {})
const app = newApp(server(report))
void app
```

## 错误码

本包不定义 `GO_LIKE_` 错误码。空 pattern、非对象选项，或上面列出的时刻表选项之外的字段，抛出 `TypeError`。运行期状态错误来自 `@go-like/core/job`。
