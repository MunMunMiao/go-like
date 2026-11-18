# Архитектура

go-like — слой композиции. `@go-like/core` объявляет socket и реализует механизмы, которым не нужен сторонний клиент. Plug заполняет socket. Приложение создаёт нативный объект, собирает plug и выбирает, какому ярусу App он принадлежит.

Полезный вопрос такой: кто допускает этот объект, в каком ярусе он находится, кто наблюдает его конечный результат и какой runtime или backend придаёт этому результату смысл.

## Socket и plugs

```text
Application composition root
  |
  +--> Context, metadata, struct, health, resilience     core mechanisms
  |
  +--> Lifecycle
  |      telemetry(tel) -> resources(...) -> server(...) -> registrar
  |
  +--> External Web
  |      Handler on @go-like/core/web
  |      host on @go-like/core/web/node or @go-like/core/web/bun
  |
  +--> Internal calls
  |      Client, Server, Transport
  |      memory and Fetch transports in core; gRPC on @go-like/connectrpc
  |
  +--> State
  |      Config, Registry, Store, Cache sockets
  |      memory references in core; Consul, etcd, Vault, Kubernetes,
  |      ZooKeeper, mDNS, YAML, Redis, and file plugs
  |
  +--> Messages and jobs
  |      Broker and Job sockets
  |      memory broker in core; NATS, RabbitMQ, BullMQ, and Croner plugs
  |
  +--> Telemetry sockets
         LogHandler, TracerProvider, MeterProvider, Propagator
         filled by @go-like/otel, @go-like/pino/log, @go-like/winston/log,
         @go-like/prometheus/metric
```

Core записывает каждую единицу работы в фиксированном месте вызова. Plug не оборачивает `newClient` или Web Handler, чтобы добавить span. Направление импортов внутри core проверяет `test/portable-lane.test.ts`: нижние слои не импортируют корневую точку входа.

## Три яруса

`newApp(...options)` применяет параметры в порядке аргументов. Один и тот же объект не может стоять и в `resources(...)`, и в `server(...)`. Передача набора `Telemetry` в любой из этих списков — ошибка типа и runtime-`TypeError`.

| Ярус       | Параметр                                    | Start                                                                                                                                                                        | Stop                                                                                                                                              |
| ---------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Телеметрия | `telemetry(tel)` заменяет предыдущий набор  | Первым. Сначала обработчики логов, затем tracer, затем meters. У каждого `lifecycle.start` проверяется немедленный сбой. Сбой откатывает уже запущенные.                     | Последним, после `afterStop`, на собственном бюджете `stopTimeout`. Tracer и meters завершают drain вместе, затем обработчики логов.              |
| Ресурсы    | `resources(...)` заменяет предыдущий список | После `beforeStart`, до любого сервера. Порядок объявления. Каждый `start(ctx)` ожидается и должен завершиться, когда ресурс пригоден к использованию.                       | После остановки каждого запущенного сервера, в обратном порядке объявления. Сбой stop записывается, и следующий ресурс всё равно останавливается. |
| Серверы    | `server(...)` заменяет предыдущий список    | Все вызовы `start` выдаются, затем одна проверка немедленного сбоя. `start` может оставаться незавершённым, пока не закончится нативный объект. Необязательный `Endpointer`. | Параллельный `stop`, затем ожидается каждый Promise от `start`.                                                                                   |

Hooks: `beforeStart` выполняется до яруса ресурсов. `afterStart` выполняется после регистрации. `beforeStop` выполняется до снятия регистрации. `afterStop` выполняется после яруса ресурсов и до drain телеметрии. Hooks запуска прерываются при первой ошибке. Hooks остановки выполняются как очистка.

Регистрация использует только ярус серверов. Ресурс — зависимость, а не адрес для объявления.

```text
run()
  1  install signal() or another runtime option
  2  phase = starting
  3  admit telemetry
  4  open the start budget, if startTimeout is set
  5  beforeStart
  6  admit each resource and wait
  7  launch every server, then check for an immediate failure
  8  prepare endpoints and register, server tier only
  9  afterStart
 10  phase = ready; go_like.app.ready flips with the ready probe
 11  wait for stop or the first participant failure

stop()
  1  phase = stopping; the ready probe fails from this moment
  2  open the shared stop budget, if stopTimeout is set
  3  cancel the application Context
  4  join startup inside that budget
  5  beforeStop
  6  deregister
  7  cancel the server Context and stop launched servers concurrently
  8  join server start promises
  9  cancel the resource Context and stop owned resources in reverse order
 10  join resource start promises inside the same budget
 11  afterStop
 12  cancel the telemetry Context and stop the bundle on a fresh budget of the same length
```

`run()` одноразовый. `stop()` идемпотентен и делит один Promise. `App.stop()` не принимает Context. Побеждает первая причина остановки: `requested` для `App.stop()` и `signal()`, `context_canceled`, когда заканчивается родительский Context, `start_failed`, когда срывается запуск, `server_failed`, когда допущенный участник падает после ready. Одна ошибка выбрасывается как есть. Несколько ошибок становятся одним `AggregateError` в порядке фаз, телеметрия — последней.

У соседних серверов нет гарантии обратного порядка. Если worker должен остановиться раньше своей очереди, поместите очередь в `resources(...)`, а worker — в `server(...)`. Ярус ресурсов существует, чтобы такая комбинация дождалась допуска. Рукописный `Server`, чей `start` никогда не завершается, заблокирует допуск ресурсов; для нативного объекта используйте `newResourceServer`, а долгоживущего участника поместите в `server(...)`.

## Области Context

```text
parent
  -> appContext          canceled at the start of stop
       -> telemetryContext    canceled just before Telemetry.stop
       -> resourceContext     canceled just before the resource tier stops
       -> serverContext       canceled just before Server.stop
       -> startContext        appContext, plus startTimeout when configured
       -> stopContext         withoutCancel(appContext), plus the shared stopTimeout
       -> telemetryStop       a second stopTimeout, opened when the drain begins
```

Долгоживущий `start(ctx)` получает Context своего яруса. Этот Context жив, пока ярус не попросят остановиться, поэтому ресурс не видит отмену, пока серверы ещё завершают drain. Телеметрия использует собственный Context по той же причине: отмена `appContext` в начале stop не должна дренировать телеметрию раньше серверов, которые она наблюдает.

## Бюджеты и владение

`startTimeout` покрывает hooks, допуск ресурсов, подготовку endpoint, регистрацию и `afterStart`. Он не покрывает допуск телеметрии и не превращает `start` сервера в обещание readiness. Значение по умолчанию `0` означает отсутствие предела. `registrarTimeout` по умолчанию равен 10 секундам и ограничивает вызовы register и deregister.

`stopTimeout` — бюджет ожидания вызывающей стороны, общий для hooks, снятия регистрации, яруса серверов и яруса ресурсов. Drain телеметрии открывает второй бюджет той же длины, когда эта фаза начинается, поэтому экспорт ещё может завершиться после исчерпания общего бюджета. Drain, который никогда не завершается, заставляет `App.run()` ждать около двух `stopTimeout`. Значение по умолчанию `0` означает отсутствие предела для обоих. Когда общий бюджет уже исчерпан, последующие вызовы `stop` всё равно выдаются. Core не продолжает ждать, а timeout не является нативным конечным состоянием. Timeout, которыми владеет plug, остаются у plug: остановка OpenTelemetry по умолчанию ждёт 25 секунд, drain Pino по умолчанию — 25 секунд, а у Handler Winston собственного timeout drain нет.

После того как `start` завершился, участником владеет App. `newResourceServer({ open, terminal, close })` завершает `start`, когда заканчивается `open`, или сразу, если `open` опущен. `close` — единственный drain владельца; он вызывается с `withoutCancel` первого Context остановки. Если `open` падает, `close` не вызывается. Второй `start` отклоняется с `GO_LIKE_RESOURCE_ALREADY_STARTED`. Чистое завершение `terminal` до stop роняет App с `GO_LIKE_RESOURCE_CLOSED`. Разрешение в `Error` или rejection роняет App этой ошибкой. Promise завершения наблюдается приватно; это не публичное поле socket.

## Readiness

`readyProbe(registry, name?)` регистрирует синхронную пробу; имя по умолчанию — `"app"`. Она проходит только пока `run()` находится в фазе ready, и переключается в тот же момент, что gauge `go_like.app.ready`. Вне этого окна она выбрасывает `AppNotReadyError` (`GO_LIKE_APP_NOT_READY`) с `phase` `created`, `starting`, `stopping` или `stopped`. После того как `run()` завершился, проба снимается. App, который ни разу не запускался, остаётся в `created`.

`createHealthHandler(probes)` проецирует `/livez` и `/readyz`. Пустой liveness проходит. Пустой readiness закрыт в отказ, поэтому Handler без `readyProbe` или другой ready-пробы возвращает 503 для `/readyz`. Должна пройти каждая зарегистрированная ready-проба. Core не регистрирует пробу liveness.

Внутренний listener `newServer` по-прежнему отвечает на `GET` и `HEAD` `/healthz` пустым 200. Этот ответ означает, что унарный listener принял запрос. Это не registry проб.

## Listener и опубликованные порты

Примеры, которые привязываются к `127.0.0.1` и затем вызывают этот адрес, — правильная локальная форма. Опубликованный порт Docker может принять TCP через прокси до того, как контейнер обслуживает протокол. Достигайте Redis, AMQP, etcd и HTTP приложения в сети Compose по DNS сервиса, когда запущена именно эта топология.

`Server.start(ctx)` на ярусе серверов не означает ready. `Endpointer.endpoint(ctx)` возвращает адрес, который можно объявить. `afterStart` означает, что Core дошёл до этого hook.

`startRecoveringRabbitMqBroker` может допустить дескриптор брокера до того, как закончится настройка коннектора, поэтому HTTP может привязаться, не дожидаясь AMQP. Публикация остаётся закрытой, пока не появится поколение. Это допуск дескриптора, а не маршрут health.

## Путь запроса

```text
External Web
  Request -> framework or Handler -> Response -> host writes the body

Internal unary
  Context + operation
    -> Client middleware
    -> direct address or Discovery snapshot
    -> Filters, then Selector
    -> Transport
    -> POST /<service>/<endpoint>
    -> Server middleware, Struct decode, handler, Struct encode
```

Идентичность операции — `service/endpoint`, например `appointment-policy.v1/check`. Endpoint `ServiceInstance` — непрозрачный транспортный адрес, например `memory://orders` или `https://orders.example`.

## Переносимость runtime

Переносимые точки входа используют стандартные JavaScript и Web API либо возможности, которые внедряет вызывающий. Переносимая точка входа не обещает TCP-listener, сигналы процесса, наблюдение файлов, UDP multicast или клиент поставщика.

| Точка входа                                                                                        | Где выполняется                                                                                         |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Концептуальные точки входа `@go-like/core`, включая `/web`, `/transport/http`, `/transport/memory` | Переносимо. `/transport/http` набирает соединение через Fetch. Для прослушивания нужен внедрённый host. |
| `@go-like/core/node`, `/transport/http/node`, `/web/node`, `/config/node`                          | API Node. `/web/node` может работать и там, где эти API есть.                                           |
| `@go-like/core/web/bun`                                                                            | Host Bun.                                                                                               |
| `@go-like/mdns/registry/node`, `@go-like/zookeeper/registry/node`, `@go-like/file/store/node`      | Node-host этого plug. Соседняя точка входа остаётся переносимой поверх внедрённого host или фабрики.    |
| `@go-like/connectrpc`                                                                              | Переносимый Fetch Handler.                                                                              |
| `@go-like/connectrpc/node`                                                                         | Node-сервер и клиент gRPC.                                                                              |
| NATS, RabbitMQ, Redis, BullMQ                                                                      | Node и Bun, вслед за нативным клиентом.                                                                 |

Экспорты пакетов не используют условие `bun` или `node`. Импортируйте тот subpath, который имеете в виду. Библиотека TypeScript `DOM` поставляет типы. Это не полифил runtime.

## Композиция

```ts
import { newClient, withEndpoint, withTransport } from "@go-like/core/client"
import { afterStop, name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { address, newServer, transport as serverTransport } from "@go-like/core/server"
import { struct } from "@go-like/core/struct"
import { defineService } from "@go-like/core/transport"
import { newMemoryTransport } from "@go-like/core/transport/memory"
import { newNodeServer, port } from "@go-like/core/web/node"

const policy = defineService("policy", {
  check: {
    request: struct.object({ ok: struct.boolean() }),
    response: struct.object({ ok: struct.boolean() })
  }
})

const transport = newMemoryTransport()
const policyServer = newServer(serverTransport(transport), address("memory://policy"))
policy.registerHandler(policyServer, {
  check() {
    return { ok: true }
  }
})
const policyClient = newClient(withTransport(transport), withEndpoint("memory://policy"))
const webServer = newNodeServer((_request: Request) => new Response("ok"), port(3000))

const app = newApp(
  name("appointments"),
  server(policyServer, webServer),
  afterStop(async (ctx) => {
    await policyClient.close(ctx)
  }),
  signal()
)
void app
```

`newApp` не становится контейнером, а транспорт в памяти не становится сетью. Учётные данные, фабрики и остановка объектов, которые App не получал, остаются в корне композиции.

Более ранние проектные заметки используют имена вроде `ServerHandle` и `AppHandle`. Сигнатуры на этой странице — те, что экспортируются сегодня. `Server` и `Endpointer` экспортируются из `@go-like/core/lifecycle`, а не из корневой точки входа.
