# Вызовы сервисов

Внутренний унарный вызов собирается из небольших компонентов. `@go-like/client` передаёт снимок `Discovery` в `Selector`, а затем выполняет один обмен `send`/`recv` через `Transport`. Для сборки используются функциональные опции:

```ts
import {
  newClient,
  withDiscovery,
  withFilter,
  withSelector,
  withService,
  withTransport
} from "@go-like/client"
import { filterLabel, filterVersion, type Filter } from "@go-like/registry"

const client = newClient(
  withDiscovery(discovery),
  withService("orders"),
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

Корневой API Registry экспортирует тип `Filter`, а также `filterVersion(...)` и `filterLabel(...)`; `withFilter(...)` добавляет эти фильтры к вызову. Фильтры выполняются в порядке объявления до `Selector.select`. Для прямого назначения создайте `newClient(withTransport(serviceTransport), withAddress(serviceAddress))`; `withAddress(...)` обходит Discovery, но проходит через тот же Selector, что и снимки Discovery. Client с Discovery использует вместе `withService(serviceName)` и `withDiscovery(discovery)`, лениво открывает один watcher на сервис и выбирает узел из последнего полного снимка. По умолчанию вызов делает ровно одну попытку; после подтверждения безопасного повтора `withRetry(...)` явно задаёт ограниченное число попыток, классификацию ошибок и необязательную задержку, а каждая разрешённая попытка заново выбирает узел из последнего снимка. Когда Client больше не нужен, вызовите `client.close(ctx)`. `closeTimeout(...)` ограничивает только очистку логического клиента `Transport`; повторным использованием физических соединений владеют Transport и runtime.

`@go-like/server` проецирует handlers на Transport и открывает фактически связанный адрес. Создайте Server с `transport(...)`, `address(...)`, `middleware(...)` и `listenOption(...)`, затем до запуска зарегистрируйте маршрут через `server.registerHandler(...)`. `listenOption(...)` передаёт в `Transport.listen` значения `ListenOption`, специфичные для провайдера. `endpoint(ctx)` возвращает тот же фактический endpoint, который использует `start(ctx)`. Core App, собранный как `newApp(registrar(registry), server(serviceServer))`, публикует этот endpoint как `ServiceInstance` и снимает его при остановке. Это рекомендуемый жизненный цикл: пользователю не нужны регистрационный токен, DSL готовности или отдельный вспомогательный метод регистрации Server.

Каждая унарная попытка добавляет на стороне клиента в Context транспорта `TransportInfo` с фактической целью, стабильной операцией `service/endpoint` и реальными транспортными заголовками. Сервер добавляет соответствующий `TransportInfo` перед вызовом бизнес-handler. Client и Server кодируют многозначные метаданные из Context в ограниченную каноническую оболочку `Go-Like-Metadata`, которую провайдер Transport переносит как непрозрачный заголовок Message. `propagateToClientContext(...)` копирует серверные метаданные в клиентский контекст только через явный список разрешений `exact` или `prefix`.

Вызов ждёт feedback и возврата логического Transport Client в pool либо его закрытия, когда это необходимо. Успешный клиент сохраняется по умолчанию; `poolSize(0)` отключает это хранение. Ошибка очистки после получения ответа сохраняет ответ в `AggregateError.cause`, а упорядоченные ошибки — в `errors`; операция не повторяется. По окончании работы закройте владельца через `client.close(ctx)`.
