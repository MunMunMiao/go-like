# Vérification

go-like utilise plusieurs evidence lanes ; il ne faut pas réduire tous les résultats à deux catégories de tests. `bun run test:unit` exécute les tests unitaires déterministes sans service externe. `bun run test:e2e` construit les paquets et vérifie localement les fournisseurs réels, plusieurs runtimes, les exemples exécutables et la consommation des tarballs publiés. Les suites Docker démarrent de vrais services et suppriment les ressources qu’elles créent.

Formatage, Lint, types, build, Runtime E2E, Provider E2E, Example E2E, Published, Soak, Documentation build et Audit doivent être consignés séparément. La vérification canonique du dépôt est `bun run verify` : elle exécute dans l’ordre `fmt:check`, `lint:check`, `typecheck`, `build` et `test:unit:coverage`. L’étape de couverture exécute une fois chaque script de couverture du root et des workspaces, puis impose le contrôle obligatoire. `examples/payments-ledger` est la seule exception hors du périmètre unitaire : son script exécute aussi le scénario d’intégration réel PostgreSQL/NATS et nécessite donc Docker. Consultez la [Vérification canonique en anglais](/reference/verification) pour les lanes, le baseline historique et le run record documentaire.

```sh
bun run verify
bun run test:parallel
bun run test:stability
bun run test:e2e
bun run test:e2e:soak
```

`test:parallel` exécute une fois le même périmètre unitaire avec deux workers Bun isolés afin de vérifier la sûreté du parallélisme entre fichiers. `test:stability` randomise chaque exécution, répète deux fois chaque fichier de test et affiche un seed reproductible, sans utiliser retry. Ces deux contrôles sont indépendants, ne font pas partie de la porte canonique et ne remplacent pas `verify` ; `test:stability` recherche les dépendances d’ordre et les échecs intermittents, ce qui diffère du comportement sur 60 minutes vérifié par `test:e2e:soak`.

Les commandes de chaque étape servent uniquement à isoler un échec ; leur réussite ne remplace pas `bun run verify`. `bun run fmt` corrige le formatage. `bun run lint` applique les corrections sûres d’Oxlint, reformate le résultat et échoue s’il reste un warning. La porte utilise `fmt:check` et `lint:check`, qui ne modifient pas les fichiers ; `lint:check` exige également zéro warning. Ces commandes ne remplacent ni la vérification des types ni l’exécution du comportement runtime. E2E et soak restent des vérifications locales indépendantes à exécuter selon les besoins. `fmt`, `lint`, `typecheck`, `build`, `audit` et `doc:build` sont des commandes d’ingénierie, pas d’autres catégories de tests. `doc:build` vérifie les routes VitePress anglaises et localisées configurées ; il ne prouve ni le rendu navigateur ni la parité de traduction. L’existence d’une commande ne prouve pas sa réussite ; vérifiez l’état terminal et les journaux de l’exécution courante. Consultez la [Vérification canonique en anglais](/reference/verification) pour les lanes, le baseline historique et le run record documentaire.
