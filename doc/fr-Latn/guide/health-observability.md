# Santé et observabilité

`@likego/health` sépare liveness et readiness. Un registre liveness vide est sain puisque le processus tourne. Un registre readiness vide échoue de façon prudente : sans probe enregistrée, mieux vaut ne pas recevoir de trafic. `@likego/web/health` peut exposer ces résultats sous forme de réponses Web standard.

Métriques et traces s’assemblent explicitement. `@likego/prometheus` sert un `Registry` prom-client possédé par l’application, sans toucher au global. `@likego/otel` raccorde le cycle de vie des providers OpenTelemetry créés par l’application et propose des wrappers Client, middleware unary et Broker ; il n’installe ni provider, ni exporter, ni context manager, ni instrumentation automatique globale.

Même principe pour les logs : `@likego/pino` et `@likego/winston` ne gèrent que la fermeture du destination ou logger natif. Niveaux, masquage, formats, transports, child loggers et règles de champs appartiennent à l’application.

Bornez la cardinalité des labels et ne mettez jamais de secret dans les attributes. Pour préserver la parenté des traces asynchrones, installez un context manager compatible avec le runtime. Une panne d’export doit apparaître dans l’état terminal, pas être avalée pour afficher un arrêt artificiellement propre.
