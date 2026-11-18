# Вызовы сервисов

Внутренний вызов сервиса — один обмен Fetch. Имя операции и транспортный адрес — разные значения. Типизированный вызов добавляет валидацию Struct для JSON-тела. Сгенерированный Protobuf RPC — отдельный путь; см. [Потоки](/ru-Cyrl/guide/streaming).

## Идентичность операции и адрес

`defineService("appointment-policy.v1", { check })` называет операцию `appointment-policy.v1/check`. `withEndpoint("memory://appointment-policy.v1")` и `address("memory://appointment-policy.v1")` называют, куда идут байты. `ServiceInstance` реестра хранит транспортные URL в `endpoints`. Filters и selectors выбирают среди этих URL. Операцию они не выбирают.

## Типизированный Memory Transport

Используйте один `newMemoryTransport()` для обеих сторон. Он действует в пределах процесса и приватен для экземпляра. Это форма из `examples/healthcare-appointments`:

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { background } from "@go-like/core/context"
import { name, newApp, server } from "@go-like/core"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { struct } from "@go-like/core/struct"
import { defineService, serviceError } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"

const math = defineService("math", {
  add: {
    request: struct.object({ left: struct.number(), right: struct.number() }),
    response: struct.object({ sum: struct.number() })
  }
})

const transport = newMemoryTransport()
const rpc = newServer(serverTransport(transport), address("memory://math"))
math.registerHandler(rpc, {
  add(_ctx, request) {
    if (!Number.isFinite(request.left) || !Number.isFinite(request.right)) {
      throw serviceError("math_rejected", "operands must be finite", 400)
    }
    return { sum: request.left + request.right }
  }
})

const client = newClient(withTransport(transport), withEndpoint("memory://math"))
const api = math.newClient(client)
const app = newApp(name("math"), server(rpc))
const running = app.run()
await rpc.endpoint(background())
try {
  const result = await api.add(background(), { left: 2, right: 3 })
  console.log(result.sum)
} finally {
  await client.close(background())
  await app.stop()
  await running
}
```

`service.registerHandler` связывает каждый типизированный Handler до start. `service.newClient(client).add(ctx, value)` проверяет запрос и ответ. `client.close(ctx)` — очистка приложения. В реальном процессе закрывайте клиент из `afterStop` и отдайте время жизни `app.run()`.

`newHTTPTransport()` — переносимый Fetch-клиент. Он не слушает. Node-listener использует `newNodeHTTPTransport()` из `@go-like/core/transport/http/node` и на сервере, и на Node-клиенте. Передача `newHTTPTransport()` в `newServer` проходит проверку типов, а затем падает на listen с `GO_LIKE_TRANSPORT_UNSUPPORTED_CAPABILITY`.

И `@go-like/core/server`, и `@go-like/core/client` экспортируют `middleware` и `use`. Импортируйте один из них как пространство имён, когда файлу нужны оба.

## Одна попытка

Вызов по умолчанию делает одну попытку. Клиент строит `POST` с `content-type: application/json`, набирает соединение или повторно использует транспорт и читает ответ. JSON-тело не-2xx, которое совпадает с конвертом ошибки сервиса, становится `ServiceError`. Узнайте его через `isServiceError` из `@go-like/core/transport`, прежде чем читать `code`, `status` или `metadata`. `ServiceError.code` принадлежит приложению. Это не код `GO_LIKE_*`.

Сырой `client.call` принимает `{ service, endpoint, headers, body }` и возвращает Fetch `Response`. Вызывающий читает тело или отменяет его.

Metadata путешествует на Context. `@go-like/core/metadata` даёт `newClientContext`, `fromServerContext` и `propagateToClientContext`. Распространение явно. Входящие metadata не копируются на следующий переход, пока это не сделает Handler.

## Discovery, filters и selection

`newDiscoveryResolver` из `@go-like/core/registry` наблюдает один сервис и хранит полный замещающий снимок. Пустой снимок авторитетен: selection падает с `GO_LIKE_NO_AVAILABLE_ENDPOINT`, а не переиспользует предыдущие экземпляры.

```ts
import { newClient, withDiscovery, withEndpoint, withSelector } from "@go-like/core/client"
import { newP2CSelector } from "@go-like/core/registry"

const client = newClient(
  withDiscovery(registry),
  withEndpoint("discovery:///pricing"),
  withSelector(newP2CSelector())
)
void client
```

`withDiscovery` принимает `Discovery`. Клиент строит приватный resolver. Вызывайте `newDiscoveryResolver(discovery)` только когда коду приложения нужны снимки вне клиента. Два resolver на одном Discovery не делят наблюдателей.

Filters чистые и упорядоченные. `filterVersion` и `filterLabel` — встроенные; их передают на вызов через `withFilter`. Selectors — это `newRoundRobinSelector`, `newWeightedRoundRobinSelector`, `newRandomSelector`, `newP2CSelector` и `newEWMASelector`. P2C и EWMA принимают синхронную обратную связь после попытки. Это состояние отдельно от `circuitBreakerMiddleware`, который привязывает breaker к операции.

`withBlock()` ждёт первый непустой снимок. Прямой список адресов `withEndpoint` — статический снимок и всё равно проходит через selector. `withEndpoint("discovery:///name")` называет сервис, который нужно наблюдать.

## Retry — это разрешение на повтор

`withRetry` из `@go-like/core/client` требует:

- `authorization`: `"idempotent"` или `"caller-approved"`;
- `maxAttempts`: положительное целое, считая первую попытку;
- `shouldRetry(ctx, error, attempt)`, возвращающий boolean.

Разрешение — объявление вызывающего. Core не инспектирует побочные эффекты. Каждая попытка заново входит в discovery и selection. Ответ, который уже получен, а затем сопровождался сбоем обратной связи или очистки, не воспроизводится снова.

`retry` и `exponentialBackoff` в `@go-like/core/resilience` — та же идея для кода приложения вне клиента. `newCircuitBreaker` и `circuitBreakerMiddleware` открываются на сбоях, которые определил вызывающий. `circuitOpen` — sentinel, который выбрасывается, пока breaker открыт. `newTokenBucketLimiter` и `rateLimitMiddleware` отклоняют избыточные вызовы.

## Очистка

- Закрывайте клиенты и наблюдатели конфигурации в `afterStop` либо допускайте нативное соединение через `newResourceServer`.
- Сохраняйте Context запроса для вызова. Замена его на `background()` теряет отмену и текущий span.
- Сопоставляйте сбои по sentinel, `isServiceError` или задокументированному `code`. Сообщение оставьте для диагностики. Каталог — [Обработка ошибок](/reference/errors).
