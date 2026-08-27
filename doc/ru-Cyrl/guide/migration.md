# Миграция и внедрение

Самое безопасное правило миграции таково: **сохраните плоскость данных и добавляйте ту границу, которую можете объяснить**.

Сохраните существующий Web-фреймворк, worker, scheduler, broker, logger или провайдер телеметрии. Добавьте вокруг реальной задачи жизненного цикла или вызова сервиса один явный контракт go-like. Прежде чем добавлять следующий провайдер, проверьте эту границу.

## Поэтапная миграция

1. Оставьте существующий bootstrap и код маршрутов/плоскости данных без изменений.
2. Определите одного владельца: listener, worker, scheduler, подписку брокера, место назначения логов или провайдер телеметрии.
3. Добавьте структурный адаптер `Server` или используйте готовый адаптер go-like. Опишите допуск к работе, остановку, timeout и наблюдение конечного состояния.
4. Подключите `@go-like/context` на настоящих границах отмены или deadline. Передавайте его первым аргументом операции.
5. Добавьте liveness и readiness с помощью `@go-like/health` и `@go-like/web/health`.
6. Добавьте один типизированный внутренний унарный вызов, используя `@go-like/transport-memory` в тестах.
7. Переносите этот вызов на `@go-like/transport-http` или `@go-like/transport-http/node` только тогда, когда действительно нужен wire или нативный Node host.
8. Добавляйте Registry, Config, Store, Cache, Broker, логирование, метрики или трассировку по одной возможности за раз.
9. Для каждой новой границы фиксируйте провайдер, runtime, владельца и уровень доказательности.

Не начинайте с переписывания всего сервиса. Смысл небольших контрактов в том, что единица миграции может оставаться небольшой.

## Матрица миграции фреймворков

| Существующая система | Оставьте нативным                                                                | Сначала добавьте                                                                                              | Текущая граница                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| NestJS               | Модули, контроллеры, декораторы, DI, interceptors, pipes, adapter                | Собственный структурный Server вокруг существующего приложения или отдельную внутреннюю границу Client/Server | В репозитории нет go-like-моста для Nest и автоматической интеграции DI                                                    |
| Fastify              | Маршруты, плагины, hooks, request/reply, нативный listener                       | Собственный wrapper жизненного цикла или явно реализованный Fetch-мост                                        | Текущая конвертация Fastify request/reply в go-like Handler не доказана                                                    |
| Hono                 | Маршруты, middleware, sub-apps, `app.fetch`                                      | `newNodeServer(app.fetch, ...)`, затем `newApp(...)`                                                          | Прямая интеграция с нативным Fetch показана в `examples/hono`                                                              |
| Elysia               | Дерево маршрутов, schema, decorators, derives, hooks, поведение Bun/Web Standard | Нативный `app.fetch` и Core host/lifecycle там, где это уместно                                               | Сохраняйте Bun-специфичную семантику `.listen()`; не объявляйте её межruntime API go-like                                  |
| H3                   | Роутер H3 и нативное преобразование handler                                      | Текущий Fetch-путь handler из примера H3                                                                      | Для H3 2.x показана форма `app.fetch`; рекомендации для старого `toWebHandler` требуют отдельного зафиксированного примера |
| Koa                  | Middleware и внешний роутер                                                      | Собственный wrapper владельца или внутренний вызов сервиса                                                    | `@go-like/web` не принимает Node-объект Koa request/reply без прикладного моста                                            |
| tRPC                 | Router, middleware процедур, парсеры input/output, adapter                       | Core lifecycle вокруг host или отдельно реализованную внутреннюю транспортную границу                         | go-like Endpoint не является роутером процедур tRPC                                                                        |

### Пример Hono

Вот форма интеграции, которая показана в репозитории:

```ts
import { Hono } from "hono"
import { name, newApp, server } from "@go-like/core"
import { signal } from "@go-like/core/node"
import { newNodeServer, port } from "@go-like/web/node"

const web = new Hono().get("/users/:id", (c) => c.json({ id: c.req.param("id") }))

const app = newApp(name("users"), server(newNodeServer(web.fetch, port(3000))), signal())

await app.run()
```

Текущий пример Hono оставляет владение маршрутами у Hono и передаёт нативный Fetch handler Node host. Он не добавляет таблицу маршрутов go-like и отдельный пакет-мост для Hono.

### Elysia и H3

Применяйте ту же границу к фреймворку, который предоставляет стандартный Fetch handler:

```text
framework route table
  -> framework native Fetch handler
  -> @go-like/web/node (when using the Node host)
  -> @go-like/core App
```

Перед импортом Node subpath проверьте runtime-адаптер фреймворка. Bun-адаптер Elysia и Web Standard adapter не имеют полностью одинаковой семантики `listen`. Для версий H3 и API преобразования handler также нужен зафиксированный пример. Не делайте обещание для любой версии фреймворка и любой комбинации runtime только на основании одного примера.

## Миграция сервиса Go

Читателю, пришедшему из Go или Kratos, лучше переносить понятия, а не написание имён:

| Понятие Go            | Понятие go-like                                                                                                    | Важное отличие                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `context.Context`     | `@go-like/context` `Context`                                                                                       | `done()` — это `AbortSignal` или `null`, а не канал Go                              |
| Жизненный цикл Server | Структурный `Server` Core                                                                                          | `start(ctx)` может длиться весь срок работы сервиса и не означает readiness         |
| App runner            | `newApp`, `App.run`, `App.stop`                                                                                    | `App.stop()` не получает Context вызывающей стороны и возвращает один общий Promise |
| RPC client            | `@go-like/client`                                                                                                  | Внутренние вызовы — унарные `Message`; retry включается явно                        |
| Transport             | `@go-like/transport`                                                                                               | Провайдеры и заголовки Message — контракты TypeScript/Web                           |
| Registry              | `@go-like/registry`                                                                                                | Watcher возвращает полные снимки-замены                                             |
| Selector              | `newRoundRobinSelector`, `newRandomSelector`, `newWeightedRoundRobinSelector`, `newP2CSelector`, `newEWMASelector` | Feedback синхронен и зависит от политики                                            |
| Protobuf/IDL          | Эквивалента в go-like нет                                                                                          | `Endpoint` + `Struct` — runtime-валидация, а не сгенерированный код схемы           |
| gRPC stream           | Текущего эквивалента в go-like нет                                                                                 | Публичный Web streaming отделён от внутреннего unary transport                      |

Первым постепенным шагом может быть типизированный вызов по прямому адресу через Memory Transport:

```ts
const transport = newMemoryTransport()
const server = newServer(
  serverTransport(transport),
  address("memory://pricing"),
  handler(pricingEndpoint, pricingHandler)
)
const client = newClient(withTransport(transport))

const result = await client.call(ctx, pricingEndpoint, request, withAddress("memory://pricing"))
```

Только после проверки этой границы вводите Discovery, настоящий Registry provider или HTTP transport. Так вы сохраняете доменный контракт, меняя лишь назначение и схему владения ресурсами.

## Внедрение в Kubernetes

Оставьте Kubernetes нативным:

- Deployments, Services, DNS, Ingress, RBAC, probes, стратегия rollout, HPA и network policy по-прежнему остаются ответственностью платформы;
- `@go-like/config-kubernetes` читает один ключ из одного namespaced ConfigMap или Secret через переданную Fetch capability;
- `@go-like/registry-kubernetes` использует записи EndpointSlice, когда прямое обнаружение действительно необходимо;
- EndpointSlice — это не Kubernetes Service DNS и он не предоставляет универсальный TTL регистрации;
- необязательные owner references Pod и явная deregistration имеют разную семантику отказов.

Начните с health и configuration, прежде чем выбирать узлы напрямую из EndpointSlice. Если у приложения уже есть стабильное DNS-имя Service, `withAddress(...)` вместе с HTTP transport может быть проще и честнее, чем добавление Registry provider.

## Внедрение брокеров и задач

Сохраните нативными settlement и политику задач:

| Существующая плоскость данных | Сохранить                                                        | Добавить go-like для                                                                     |
| ----------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| NATS Core                     | Connection, subscription, queue group, `Msg`, drain              | `newNatsCoreServer`, `newNatsCoreBroker`, lifecycle и границу bytes                      |
| NATS JetStream                | Stream, durable consumer, `JsMsg`, ack/nak/term, redelivery, DLQ | `newNatsJetStreamServer`, `newNatsJetStreamBroker`, lifecycle                            |
| RabbitMQ                      | Connection, topology, confirm policy, channel                    | Lifecycle borrowed или recovering subscriber и native settlement с защитой по generation |
| BullMQ                        | Queue, Worker, processor, retry/backoff, Redis                   | `newBullMqWorkerServer` вокруг официального dormant Worker                               |
| Croner                        | Cron expression, time zone, callback, overlap policy             | `newCronerServer` вокруг paused native Cron jobs                                         |
| Memory Broker                 | In-process topic map и семантика тестов                          | `newBrokerServer` и необязательный event codec                                           |

Не переносите NATS ack/nak/term, durable settlement JetStream, подтверждения RabbitMQ или retry BullMQ в универсальную абстракцию go-like Broker. Именно эти семантики объясняют, почему нативный объект провайдера остаётся видимым.

## Миграция состояния

Выбирайте по одной области состояния за раз:

- Config — для неизменяемых снимков конфигурации процесса и reload;
- Registry — для эфемерной доступности сервисов;
- Store — для авторитетных записей, revisions, CAS, TTL и страниц;
- Cache — для временных значений, которые можно пересчитать.

Полезная проверка миграции — записать, что произойдёт после перезапуска процесса, устаревшего чтения, отказа провайдера, compaction watcher, конфликта CAS и cache miss. Если ответы различаются, этим областям не следует делить один универсальный интерфейс repository.

## Добавление наблюдаемости

Сначала добавьте нативный провайдер, затем оберните границу:

```text
application creates logger / Registry / MeterProvider / TracerProvider
  -> go-like wrapper records bounded operation facts
  -> application-owned exporter or destination
  -> explicit Core lifecycle adapter closes the admitted resource
```

`@go-like/prometheus` не использует глобальный registry. `@go-like/otel` не устанавливает глобальные providers или exporters. Адаптеры Pino и Winston не заменяют нативную конфигурацию logger. Ограничивайте labels и attributes и отдельно редактируйте логи, которыми владеет приложение.

## Чек-лист приемки миграции

Перед слиянием одной границы проверьте:

- существует один явно названный владелец;
- владелец получает правильный Context и не заменяет его на `background()`;
- допуск при запуске и readiness разделены;
- поведение stop timeout описано как граница ожидания;
- нативное наблюдение конечного состояния сохраняется, когда оно доступно;
- внешние Web и внутренние unary handlers не смешиваются;
- разрешение retry соответствует бизнес-операции;
- для credentials, metadata, логов и trace attributes есть политика редактирования;
- семантика провайдера остаётся видимой;
- целевая команда unit/typecheck прошла в нужном checkout;
- релевантная команда E2E для runtime, provider, publication или example либо выполнена и записана, либо явно отмечена как невыполненная.

## Текущая граница поддержки

В репозитории есть прямые примеры для vanilla Fetch, Hono, Elysia, H3, Memory Transport, типизированных внутренних вызовов, health, brokers, workers и адаптеров наблюдаемости. Он не доказывает автоматические мосты для NestJS или Fastify, совместимость с gRPC/Protobuf/IDL, внутренние full-duplex streams, универсальную аутентификацию или оркестрацию развёртывания. Для этого потребовались бы отдельные адаптеры, тесты и продуктовые обязательства.
