# Architecture

go-like se présente comme des paquets plats et publiables séparément, pas comme un gros conteneur qui voudrait tout piloter. `@go-like/core` compose l’application et les cycles de vie Server ; `@go-like/context` transporte annulation, échéance, cause et valeurs ; chaque autre SPI couvre un seul domaine, avec ses fournisseurs dans des paquets distincts.

On peut lire l’ensemble par plans : l’application gère démarrage, admission, hooks et état terminal ; Core appelle en parallèle `stop(ctx)` sur chaque sibling Server, attend le terminal result de chacun, puis agrège les lifecycle failures ; l’ordre inverse de déclaration n’est pas garanti. Les composants qui exigent un nettoyage ordonné doivent composer eux-mêmes cet ordre dans un seul `Server`. Les appels réunissent découverte, sélection, client, projection serveur et transport ; les événements couvrent Broker et codec typé ; les opérations regroupent configuration, Store, santé, métriques, traces et logs ; la bordure Web reçoit les handlers Fetch publics, séparément du transport interne.

Les dépendances pointent vers les contrats portables. Un fournisseur peut utiliser un SDK officiel ou un host propre au runtime, mais le SPI ne dépend jamais en retour de cette implémentation. La même composition fonctionne donc sur Bun, Node.js, Deno ou un autre backend compatible avec les API Web.

Il n’existe pas de service locator global. L’application construit et injecte ses dépendances. Ces quelques lignes d’assemblage rendent la propriété des connexions, watchers, listeners et tâches d’arrêt beaucoup moins mystérieuse.

> [!NOTE]
> Cette page est un résumé localisé. La [page canonique anglaise](/guide/architecture) contient le DAG complet du cycle de vie, la carte de propriété et les limites propres aux providers ; ce résumé ne promet pas une parité universelle entre runtimes.

## Carte de la requête et du cycle de vie

```text
application composition root
  -> Context : annulation / échéance / valeurs
  -> Core App : admission / hooks / résultat d'arrêt
  -> Web Handler -> runtime host -> listener
  -> Client interne -> Discovery -> Selector -> Transport -> Server

App.stop()
  -> deregister de l'instance admise
  -> annulation du runtime du Server
  -> appels concurrents à Server.stop
  -> jonctions terminales -> un résultat
```

`Server.start(ctx)` ne signifie pas readiness. Utilisez `endpoint(ctx)` ou un hook `afterStart` comme signal d'admission. Core ne promet pas non plus un arrêt inverse des Servers frères ; si l'ordre compte, composez ces ressources dans un `Server` ou un hook explicite.
