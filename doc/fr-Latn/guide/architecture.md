# Architecture

LikeGo se présente comme des paquets plats et publiables séparément, pas comme un gros conteneur qui voudrait tout piloter. `@likego/core` compose l’application et les cycles de vie Server ; `@likego/context` transporte annulation, échéance, cause et valeurs ; chaque autre SPI couvre un seul domaine, avec ses fournisseurs dans des paquets distincts.

On peut lire l’ensemble par plans : l’application gère démarrage, admission, agrégation des résultats d’arrêt concurrent avec `Promise.allSettled`, hooks et état terminal ; les composants qui exigent un nettoyage ordonné doivent composer eux-mêmes cet ordre dans un seul `Server`. Les appels réunissent découverte, sélection, client, projection serveur et transport ; les événements couvrent Broker et codec typé ; les opérations regroupent configuration, Store, santé, métriques, traces et logs ; la bordure Web reçoit les handlers Fetch publics, séparément du transport interne.

Les dépendances pointent vers les contrats portables. Un fournisseur peut utiliser un SDK officiel ou un host propre au runtime, mais le SPI ne dépend jamais en retour de cette implémentation. La même composition fonctionne donc sur Bun, Node.js, Deno ou un autre backend compatible avec les API Web.

Il n’existe pas de service locator global. L’application construit et injecte ses dépendances. Ces quelques lignes d’assemblage rendent la propriété des connexions, watchers, listeners et tâches d’arrêt beaucoup moins mystérieuse.
