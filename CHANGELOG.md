# Journal des versions

Ndank suit un versionnage simple : `+0.1.0` pour une modification majeure ou
importante, `+0.0.1` pour une modification mineure ou une correction, rien pour
le reste.

---

## 0.2.0

Les correctifs d'un audit complet du cœur. Le moteur métier était juste ;
l'extraction depuis Baobart, pas encore tout à fait. Trois défauts pouvaient
couper l'accès de quelqu'un sans que rien ne le dise.

**Chaque correctif est vérifié par mutation** : le défaut a été réintroduit et
un test est tombé. Un test vert ne prouve rien tant qu'il n'a pas mordu.

### Corrigé

**Un abonnement qui échoue n'emporte plus le lot.** La boucle de `passer`
n'avait aucun rattrapage : une exception d'un port arrêtait le passage entier,
et tous les abonnements suivants ne recevaient ni relance ni suspension. Comme
l'état se déduit des dates, ils recevaient le lendemain le palier le plus avancé
— pour certains, un SMS payant à la place du courriel gratuit de la veille.
Chaque abonnement est désormais rattrapé séparément et noté dans
`Passage.echecs`, avec sa cause.

**La coupure d'accès ne dépend plus de l'heure du passage.** `etatDe` comparait
un horodatage complet à une borne ramenée à minuit : une seconde après minuit
suffisait à basculer l'état, donc un cron lancé à 3 h coupait un jour civil plus
tôt qu'un cron lancé à minuit pile. Les comparaisons passent par `joursEntre`,
qui ramène ses deux bornes au jour civil UTC.

**`joursRestants` compte comme le reste du module.** Une division de
millisecondes rendait 7 à minuit et 6 à treize heures pour le même abonnement :
le nombre annoncé à l'abonné dépendait de l'heure du cron, et l'écran pouvait
contredire le message.

**L'antislash revient dans la table d'extension GSM-7.** Le jeu s'écrivait
`"^{}\[~]|€"` : dans une chaîne JavaScript, `\[` vaut `[`, donc l'antislash
n'échappait pas lui-même mais le crochet et manquait au jeu. Il disparaissait
des messages, et — plus grave pour un module qui existe pour mesurer un coût —
`segments()` comptait en UCS-2 un texte que l'opérateur aurait facturé en GSM-7.

**`relancesAnnoncees` n'annonce plus de confirmation.** L'entrée `CONFIRMATION`
était justifiée par une fonction restée dans Baobart. Le moteur ne pousse
aucune notification au renouvellement : l'annoncer faisait mentir l'écran, ce
que cette fonction existe précisément pour empêcher.

**Une faute de frappe sur un canal ne compile plus.** `PALIERS[].canaux` était
typé `string[]`, et le moteur blanchissait le tout par `canal as Canal` :
`"courriell"` passait `tsc --strict` sans un mot, puis la relance ne partait
pas. Les canaux sont typés `Canal`, le cast a disparu.

**`FENETRE_JOURS` dérive de `PREAVIS_JOURS`.** Le moteur refaisait le calcul au
lieu d'importer la constante, avec un repli différent (`?? 3` contre `?? 0`) —
soit exactement la recopie que `PREAVIS_JOURS` existe pour supprimer.

### Ajouté

**`finaliserRenouvellement(ports, abonnement, paiement, reglages?)`** enchaîne
le cycle après un paiement confirmé et appelle le port `renouveler`, jusqu'ici
déclaré et jamais utilisé : chaque hôte devait l'implémenter pour rien.

**`replierAvecPertes(texte)`** rend `{ texte, perdus }`. Le repli pouvait vider
un texte entier sans le dire — une écriture sans équivalent latin disparaît
intégralement, et un nom d'abonné effacé n'est pas un émoji effacé. `replier`
délègue à cette fonction et garde sa signature.

**`Passage.lotPlein`** dit qu'il restait probablement du travail. Sans lui, une
base plus grosse que `LOT` se vidait silencieusement par le mauvais bout.

**Intégration continue.** `npm run typecheck` et `npm test` tournent désormais
sur chaque poussée et chaque demande de fusion.

### Modifié

Trois signatures de port, sans conséquence pour un hôte existant :

- `Lecture.relancesEnvoyees(abonnementId, cycle)` reçoit la clé du cycle en
  cours, pour que l'hôte puisse ne rendre que ce qui la concerne. L'ignorer
  reste correct.
- `Ecriture.noterRelance` reçoit `readonly Canal[]` au lieu de `string[]`.
- `Passage` gagne `echecs` et `lotPlein`.

Le passage mène ses **lectures** par grappes bornées à huit, mais garde ses
**envois** strictement en série : une passerelle SMS limitée en débit
refuserait une rafale, et ce refus deviendrait une relance qui ne part pas.

`Lecture.aRelancer` gagne une exigence de contrat : **ne pas rendre ce qui est
déjà clos.** Le moteur ne peut pas le savoir, donc il redit `clore` tant qu'il
le voit ; sur une base qui vieillit, les morts finissent par occuper le lot —
qui est plafonné — et par évincer les vivants.

### Tests

65 → 87. Les ajouts couvrent ce que la suite ne regardait pas : l'heure
d'exécution du passage (toute la suite partait de minuit UTC, et `ajouterJours`
conserve minuit), l'échec d'un port, le lot plein, l'ordre des paliers, et
l'antislash.

Le test « traite plusieurs abonnements sans qu'un échec emporte les autres » a
été réécrit : il montait deux abonnements sains et vérifiait un compteur. Son
nom affirmait une résistance que rien n'éprouvait.

---

## 0.1.0

Première extraction du cœur depuis [Baobart](https://github.com/auceps-dev-team/Baobart).

Abonnements par mobile money, sans carte bancaire : deux horloges — l'échéance
et l'accès —, un état déduit des dates plutôt que stocké, un cycle qui s'enchaîne
sur l'échéance et non sur le paiement, et une échelle de relances qui monte en
coût. Plus le repli GSM-7 pour les hôtes qui branchent un SMS.
