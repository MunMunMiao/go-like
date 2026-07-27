# Вызовы сервисов

Внутренний унарный вызов собирается из небольших компонентов. `@likego/client` передаёт снимок `Discovery` в `Selector`, а затем выполняет один обмен `send`/`recv` через `Transport`. Для сборки используются функциональные опции:

```ts
import { newClient, withDiscovery, withFilter, withSelector, withTransport } from "@likego/client"
import { filterLabel, filterVersion, type Filter } from "@likego/registry"

const client = newClient(
  withDiscovery(discovery),
  withSelector(selector),
  withTransport(serviceTransport)
)
const filters: readonly Filter[] = [filterVersion("v1"), filterLabel("zone", "a")]
const reply = await client.call(
  ctx,
  {
    service: "orders",
    endpoint: "Orders.Get",
    message: { header: {}, body: requestBytes }
  },
  withFilter(...filters)
)
```

Корневой API Registry экспортирует тип `Filter`, а также `filterVersion(...)` и `filterLabel(...)`; `withFilter(...)` добавляет эти фильтры к вызову. Фильтры выполняются в порядке объявления до `Selector.select`. Клиенту только для прямых вызовов достаточно `newClient(withTransport(serviceTransport))`; `withAddress(...)` обходит `Discovery` и `Selector`. Client с Discovery лениво открывает один watcher на сервис и выбирает узел из последнего полного снимка. По умолчанию вызов делает ровно одну попытку; после подтверждения безопасного повтора `withRetry(...)` явно задаёт ограниченное число попыток, классификацию ошибок и необязательную задержку, а каждая разрешённая попытка заново выбирает узел из последнего снимка. Когда Client больше не нужен, вызовите `client.close(ctx)`. `closeTimeout(...)` ограничивает только очистку логического клиента `Transport`; повторным использованием физических соединений владеют Transport и runtime.

`@likego/server` проецирует handlers на Transport и открывает фактически связанный адрес. Его опции — `transport(...)`, `address(...)`, `handler(service, endpoint, fn)`, `middleware(...)` и `listenOption(...)`; последняя передаёт в `Transport.listen` значения `ListenOption`, специфичные для провайдера. `endpoint(ctx)` возвращает тот же фактический endpoint, который использует `start(ctx)`. Core App, собранный как `newApp(registrar(registry), server(serviceServer))`, публикует этот endpoint как `ServiceInstance` и снимает его при остановке. Это рекомендуемый жизненный цикл: пользователю не нужны регистрационный токен, DSL готовности или отдельный вспомогательный метод регистрации Server.

Каждая унарная попытка добавляет на стороне клиента в Context транспорта `TransportInfo` с фактической целью, стабильной операцией `service/endpoint` и реальными транспортными заголовками. Сервер добавляет соответствующий `TransportInfo` перед вызовом бизнес-handler. Client и Server кодируют многозначные метаданные из Context в ограниченную каноническую оболочку `Likego-Metadata`, которую провайдер Transport переносит как непрозрачный заголовок Message. `propagateToClientContext(...)` копирует серверные метаданные в клиентский контекст только через явный список разрешений `exact` или `prefix`.

SPI транспорта сохраняет роли go-micro: `Transport`, `Client`, `Listener` и `Socket`. `@likego/transport-http` реализует обе стороны поверх стандартного протокола Fetch, сохраняя различие между ошибками протокола, транспорта и сервиса. Ответ возвращается вызывающей стороне только после отправки принадлежащей вызову обратной связи (`feedback`) и закрытия (`close`) логического клиента Transport. Если обмен завершён, но один из этих шагов не удался, нативный `AggregateError` сохраняет ответ в `cause`, а ошибки feedback и close в этом порядке — в `errors`; такие поздние ошибки не запускают повторную попытку.
