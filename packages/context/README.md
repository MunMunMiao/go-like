# @likego/context

`@likego/context` 为 LikeGo 包和应用提供可移植、Go 风格的取消、截止时间、原因和值传播能力。公共行为以
[Go 1.26.5 `context`](https://go.dev/src/context/context.go) 的可观察语义为基准，再映射到 TypeScript 与标准
Web API。

## 使用方式

```ts
import { afterFunc, background, cause, withCancelCause, withTimeout } from "@likego/context"

const [operation, cancelOperation] = withCancelCause(background())
const [request, cancelRequest] = withTimeout(operation, 5_000)

const stop = afterFunc(request, () => {
  console.log("request context completed", cause(request))
})

cancelOperation(new Error("service is stopping"))
cancelRequest()
stop()
```

父 Context 的取消会向后代传播；取消子 Context 不会影响父 Context。第一次终止状态转换和第一次原因设置生效。

## 宿主语义

- `done()` 返回 `AbortSignal`，而不是 Go 中关闭的 channel。代码若在终止后添加事件监听器，必须先检查
  `signal.aborted`；终止后 `signal.reason` 与 `err()` 返回的 `canceled` 或 `deadlineExceeded` 哨兵对象同一。
- 截止时间使用 `Date`，因此精度为毫秒。定时 Context 每次调用 `deadline()` 都会根据已保存的数值创建新的
  `Date`；无 deadline 时返回 Go zero time 对应的 `0001-01-01T00:00:00.000Z` 和 `false`。
- `afterFunc()` 通过 `queueMicrotask` 接纳回调，而不是通过 goroutine。回调接纳与成功停止之间只会有一个
  胜者；structural Context 的原型方法也按正常 JavaScript 方法查找参与委托。
- Context key 遵循 JavaScript 标识同一性语义；对象 key 仅与同一个对象引用匹配，`null` 和 `undefined`
  key 会像 Go 的 nil key 一样被拒绝。
- structural wrapper 只有在自身 `err()` 已报告终止、且继续委托 `value(key)` 时才会保留内部取消原因；若外层
  `err()` 返回 `null`，`cause()` 像 Go 一样立即返回 `null` 且不读取私有 value key。`withoutCancel()` 会显式
  截断该原因。
- 内建父子取消链使用迭代传播，因此 20,000 层后代不会耗尽 JavaScript 调用栈；若在父级 abort listener
  重入创建 child，child 会在构造返回前同步继承父级 `err()` 与 cause，不会短暂暴露为 active 或误建 timer。
- 一次取消在返回前同步终止所有已接纳后代；资源清理采用后序顺序，先清理后代、再清理祖先，同时保持同一
  Context 内 cleanup 的注册顺序。这使嵌套 deadline timer 与 Go 一样先停止子 timer，再停止父 timer。
- 生产代码仅依赖标准 ECMAScript 和 Web API，不依赖 Bun、Node.js 或 Deno 全局对象。

运行时测试覆盖 Bun `1.3.14`、Node `24.18.0` / `26.5.0` 与 Deno `2.9.4`。标准 Web API 无法要求一个已被冻结
或挂起的 Document、Worker 或 isolate 在暂停期间执行 timer，因此这类宿主的 deadline 唤醒只能服从其调度；
这不是 `Context` 可以伪装消除的差异。

## 取消原因

`err()` 只返回 `canceled`、`deadlineExceeded` 或 `null`。若调用方提供了自定义取消或截止原因，
`cause()` 返回该原因；否则返回对应的哨兵值。

`withoutCancel()` 保留值查找能力，同时移除父 Context 的取消、错误、原因和截止时间。
