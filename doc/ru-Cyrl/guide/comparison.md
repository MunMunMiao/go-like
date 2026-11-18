# go-like в сравнении с другими инструментами

Честное сравнение начинается с владения. NestJS, Fastify, Hono, Elysia, Koa и tRPC решают разные части TypeScript-приложения. go-micro и go-kratos — ориентиры из Go с другими транспортами и генерацией кода. go-like — панель socket: явные ярусы жизненного цикла, внутренние вызовы и plugs для тех backend, которые выбираете вы.

Метки доказательств на этой странице:

- **Исходный код** означает, что текущая рабочая копия предоставляет API.
- **Зафиксированный внешний источник** означает записанный release, commit или официальную страницу. Это не свежий benchmark.
- **Заявлено** означает, что пример или тест существует. Это не успешный результат.
- **Пробел** означает, что этот репозиторий не доказывает обязательство совместимости.

Историческая базовая линия документации — commit `9385dbf5b6a7d913be56a80ade359e1bf9be8675`. В исследовательской записи два commit go-micro: `9d306dcfc1a912a8a9493f31fee0bb983475258d` и, для заметки v6.9.0, `3c39d17fadaa9ec21b671be4afef3e63846406e6`. Считайте оба входными данными для повторной проверки.

## Место в стеке

| Инструмент | Чем он обычно владеет                                                   | Что go-like добавляет рядом                                                               |
| ---------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| NestJS     | Модули, контроллеры, декораторы, application context                    | Структурный `Server`, только если этот адаптер напишете вы                                |
| Fastify    | Маршруты, hooks, плагины, Node-listener                                 | Границу жизненного цикла или вызова вокруг ресурса, которым по-прежнему владеет Fastify   |
| Hono       | Маршруты, middleware, `app.fetch`                                       | Ярусы App, внутренние вызовы, plugs                                                       |
| Elysia     | Дерево маршрутов, схему, hooks, собственный адаптер                     | То же, пока `.listen()` остаётся у Elysia                                                 |
| Koa        | Middleware и внешний роутер                                             | Жизненный цикл и внутренние вызовы, а не ещё один роутер                                  |
| tRPC       | Процедуры, парсеры, адаптеры                                            | Discovery, selection и жизненный цикл App                                                 |
| go-micro   | Go Context, service, registry, broker и более широкую поверхность agent | Только словарь. Go ABI нет                                                                |
| go-kratos  | Жизненный цикл App, HTTP/gRPC, registry, config, Protobuf               | Композицию на TypeScript. Путь gRPC — Connect-ES, а не runtime Google                     |
| go-like    | Socket, ярусы, вызовы Fetch и SSE, plugs                                | Приложение по-прежнему владеет маршрутами, политикой, auth и деталями нативного протокола |

## Владение

| Область                 | go-like                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| Внешние маршруты        | Фреймворк или `Handler` приложения                                                               |
| Web Handler             | `(Request) => Response \| Promise<Response>`                                                     |
| Жизненный цикл процесса | `newApp`, три яруса, hooks                                                                       |
| Зависимости             | Конструкторы и параметры. Контейнера нет                                                         |
| Внутренние вызовы       | `Transport`, `Client`, `Server`, `defineService`, SSE `ServerStream`                             |
| Discovery               | `Registry`, `Discovery`, filters, пять selectors                                                 |
| Retry                   | Одна попытка, пока `withRetry` не разрешит больше                                                |
| Потоки                  | Web Streams на краю; JSON или SSE внутри; четыре вида вызовов gRPC на `@go-like/connectrpc/node` |
| Инструментирование      | Core записывает единицы работы. Plugs заполняют socket телеметрии. Глобальной регистрации нет    |

## Жизненный цикл и Context

```ts
import type { Server } from "@go-like/core/lifecycle"

interface App {
  run(): Promise<void>
  stop(): Promise<void>
}

type Lifecycle = Server
void null as unknown as Lifecycle
```

`Server` структурен: `start(ctx)` и `stop(ctx)`. На ярусе ресурсов `start` завершается, когда ресурс пригоден к использованию. На ярусе серверов `start` может оставаться незавершённым, а остановки соседей идут параллельно. Остановки ресурсов идут в обратном порядке объявления. У context Nest, графа плагинов Fastify или hook Elysia свой порядок. Сравнивайте владельцев, а не слово «graceful».

Context предоставляет `deadline()`, `done()`, `err()` и `value(key)`, а также `background`, `withCancel`, `withTimeout`, `withDeadline`, `withoutCancel` и `withValue`. Внутри он использует `AbortSignal`. Это не Go `context.Context` и не API gRPC.

## Вызовы, retry и потоки

Внутренний путь — Client, необязательный Discovery, filters, selector, транспорт, `POST /<service>/<endpoint>`, затем Handler сервера. Типизированный endpoint проверяет JSON через Struct. Это не IDL. `withEndpoint("discovery:///name")` выбирает сервис. Прямой список адресов этого не делает.

Вызовы делают одну попытку, пока `withRetry` не задаст `authorization` равным `"idempotent"` или `"caller-approved"`, положительный `maxAttempts` и `shouldRetry`. Это разрешение — объявление. Уже полученный ответ не воспроизводится снова, когда позднейшая обратная связь падает.

```text
Web Handler
  Web Streams, framework SSE, or WebSocket

@go-like/core client and server
  one JSON body, or SSE when stream: true

@go-like/connectrpc
  Connect and gRPC-Web unary and server-streaming on Fetch

@go-like/connectrpc/node
  standard gRPC unary, server-streaming, client-streaming, and bidi
```

Цикл retry по умолчанию в go-micro и формы HTTP-потоков go-kratos зависят от версии. Перепроверьте зафиксированные commit, прежде чем публиковать сравнение, которое на них опирается.

## Runtime

Общие точки входа используют Fetch и `AbortSignal` либо внедрённую возможность. Пользовательский TLS, HTTP/2 и mTLS живут на `@go-like/core/transport/http/node` и `@go-like/connectrpc/node`. Примеры Hono, Elysia, H3 и обычного Fetch передают Fetch Handler host core. Моста NestJS или Fastify в этом репозитории нет. Версия манифеста `0.0.1` не доказывает публикацию в npm.

## По инструментам

**NestJS.** Модули, провайдеры и контроллеры остаются у Nest. Интеграция — это `Server`, которым владеет приложение, вокруг приложения Nest, с явными допуском и закрытием. Этот репозиторий такого адаптера не содержит.

**Fastify.** Маршруты, инкапсуляция и listener остаются у Fastify. go-like не превращает `request` / `reply` в Fetch `Handler`.

**Hono.** `examples/hono` передаёт `app.fetch` в `newNodeServer` и помещает этот host в `server(...)`. Маршруты остаются в Hono.

**Elysia.** Сохраните дерево маршрутов и поведение, специфичное для Bun. Пример использует Fetch Handler с Node-host. `.listen()` — не API go-like.

**Koa.** Сохраните middleware и внешний роутер. Добавляйте границу жизненного цикла или вызова только там, где можете назвать владельца.

**tRPC.** Процедуры остаются у tRPC. Endpoint go-like — это Struct поверх JSON Fetch, а не роутер процедур.

**go-micro и go-kratos.** Это ориентиры для вызовов с Context первым, жизненного цикла и словаря discovery. Наблюдатели в go-like выдают полные замещающие снимки. Точка входа управляемого gRPC — `@go-like/connectrpc/node`.

## Что выбирать

Используйте фреймворк, который владеет задачей, которая у вас действительно есть. Добавляйте socket go-like, когда не хватает допуска, отмены, discovery или контракта backend с названным владельцем. Установка каждого plug в готовое приложение на фреймворке убирает пользу небольших контрактов.

## Опоры доказательств

Текущее дерево:

- `packages/core/src/app/app.ts` и `packages/core/src/app/tiers.ts` — ярусы, бюджеты и порядок остановки;
- `packages/core/src/lifecycle/index.ts` — `Server` и `Endpointer`;
- `packages/core/src/web/context.ts` — `Handler` и `contextHandler`;
- `packages/core/src/client/index.ts` — параметры вызова, discovery и retry;
- `packages/core/src/server/index.ts` — внутренняя диспетчеризация;
- `packages/core/src/transport/service.ts` — `defineService`;
- `packages/core/src/registry/selector.ts` — filters, selectors и обратная связь;
- `packages/connectrpc/src/node.ts` — управляемый gRPC.

Зафиксированные внешние источники, которые эта правка документации не перепроверяла:

- [commit сравнения go-micro](https://github.com/micro/go-micro/commit/9d306dcfc1a912a8a9493f31fee0bb983475258d);
- [commit go-micro v6.9.0](https://github.com/micro/go-micro/commit/3c39d17fadaa9ec21b671be4afef3e63846406e6);
- [commit go-kratos v3](https://github.com/go-kratos/kratos/commit/668db92c2c001e9552594ba5a8aede8456af6d7e);
- [commit go-zlab/go-kratos](https://github.com/go-zlab/go-kratos/commit/ecd00dd24491d09642c76542f94e392c6d639336);
- [жизненный цикл NestJS](https://docs.nestjs.com/fundamentals/lifecycle-events), [сервер Fastify](https://fastify.dev/docs/latest/Reference/Server/), [Hono](https://hono.dev/docs/api/hono), [жизненный цикл Elysia](https://elysiajs.com/essential/life-cycle), [Koa](https://koajs.com/), [роутеры tRPC](https://trpc.io/docs/server/routers).

Версии стороннего TypeScript, записанные для сравнения, а не как обещания совместимости: NestJS `@nestjs/core@11.1.28`, Fastify `5.11.2`, Hono `4.12.34`, Elysia `1.4.29`, Koa `3.2.1`, tRPC `@trpc/server@11.18.0`. Манифест примера Elysia — фиксация для этого примера; эта таблица — снимок исследования.
