# Santé et observabilité

`@go-like/health` sépare liveness et readiness. Un registre liveness vide est sain puisque le processus tourne. Un registre readiness vide échoue de façon prudente : sans probe enregistrée, mieux vaut ne pas recevoir de trafic. `@go-like/web/health` peut exposer ces résultats sous forme de réponses Web standard. Les routes par défaut sont `GET /livez` et `GET /readyz` : `200` si le contrôle réussit, `503` s'il échoue, `405` pour une méthode non autorisée et `404` pour une route inconnue. Un registre liveness vide donne `200`, un registre readiness vide `503` ; l'application doit monter le Handler dans son routeur/host.

```ts
import { newProbeRegistry } from "@go-like/health"
import { createHealthHandler } from "@go-like/web/health"

const probes = newProbeRegistry()
const health = createHealthHandler(probes)
// Montez /livez et /readyz dans la table de routes de l'application.
```

N'utilisez `curl -i http://127.0.0.1:3000/livez` qu'après avoir monté ce Handler sur ce listener.

Métriques et traces s’assemblent explicitement. `@go-like/prometheus` sert un `Registry` prom-client possédé par l’application, sans toucher au global. `@go-like/otel` raccorde le cycle de vie des providers OpenTelemetry créés par l’application et propose des wrappers Client, middleware unary et Broker ; il n’installe ni provider, ni exporter, ni context manager, ni instrumentation automatique globale.

Même principe pour les logs : `@go-like/pino` et `@go-like/winston` ne gèrent que la fermeture du destination ou logger natif. Niveaux, masquage, formats, transports, child loggers et règles de champs appartiennent à l’application.

Bornez la cardinalité des labels et ne mettez jamais de secret dans les attributes. Pour préserver la parenté des traces asynchrones, installez un context manager compatible avec le runtime. Une panne d’export doit apparaître dans l’état terminal, pas être avalée pour afficher un arrêt artificiellement propre.
