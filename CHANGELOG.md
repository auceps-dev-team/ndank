# Journal des versions

Ndank suit un versionnage simple : `+0.1.0` pour une modification majeure ou
importante, `+0.0.1` pour une modification mineure ou une correction, rien pour
le reste.

---

## 0.3.0

La couche SDK commence. Ndank sait désormais demander un paiement à un
fournisseur et constater qu'il a eu lieu — sans jamais toucher l'argent, qui va
du portefeuille de l'abonné au compte marchand de l'hôte.

Sept intégrations de paiement africaines lues et quatre documentations
d'opérateurs dépouillées avant d'écrire une ligne. Toutes décrivent la même
chorégraphie en cinq temps, et deux seulement nous appartiennent.

### Ajouté

**La couche d'encaissement.** Un port à deux verbes — `inviter` et `constater` —
plus `lireWebhook`, parce que Ndank vit côté serveur. `Http` est un port lui
aussi : aucun appel réseau n'est fait dans le module, ce qui permet d'éprouver
un flux complet sans compte marchand.

**Trois adaptateurs branchés.** Flutterwave (trois appels par invitation, avec
la vérification que la devise correspond au moyen de paiement), Paystack (un
seul appel, et un `200` avec `status: false` traité comme un refus), MTN MoMo
(jeton d'une heure mis en cache, UUID d'idempotence dérivé de la clé de cycle).

**Quatre fondations.** Orange, Wave, Moov et Djamo déclarent leurs champs de
configuration et lèvent un message qui nomme ce qu'il reste à obtenir. Aucune
adresse d'API n'est écrite sur la foi d'un paquet communautaire : l'illusion
d'une intégration se paie au premier vrai paiement.

**La vérification des signatures.** HMAC-SHA512 pour Paystack, HMAC-SHA256 pour
Flutterwave, sur le corps brut. L'ancien en-tête `verif-hash` reste accepté,
mais jamais en repli d'une signature moderne invalide. Les rappels MTN n'étant
pas signés, ils ne produisent qu'un état `INCONNU` qui force un constat
authentifié.

**Le registre.** `fournisseur(nom, identifiants)` refuse de construire un
adaptateur dont il manque un champ, et nomme le champ. `champsManquants()`
permet de valider toute la configuration au démarrage.

**Le paiement en plusieurs fois.** Deux politiques à égalité : `CREDIT`
n'enchaîne rien tant que le compte n'y est pas, `PRORATA` accorde du temps au
prorata du versement. Elles s'accordent toujours sur le double paiement.

**`cycleAvance`.** L'échéance peut avancer d'une durée libre, et `cycleSuivant`
n'en est plus qu'un cas particulier. Les deux partagent la même arithmétique,
exception comprise.

**La réconciliation.** Du paiement constaté au cycle avancé. Elle décide, elle
n'écrit pas : faire avancer une échéance et noter le versement qui l'a payée
doivent tomber ou réussir ensemble, et seul l'hôte peut ouvrir cette
transaction.

### Modifié

`cycleSuivant` délègue à `cycleAvance`. Comportement identique — les douze tests
existants passent sans modification.

La référence transmise au fournisseur porte désormais le numéro du versement
(`2026-02-09#1`). Conséquence directe du paiement en plusieurs fois : réutiliser
la clé du cycle aurait fait reconnaître le premier versement par le fournisseur,
et le second n'aurait jamais eu lieu.

`@types/node` en dépendance de développement, pour `crypto` et `Buffer`.
`dependencies` reste vide.

### Tests

87 → 179. Les ajouts couvrent les trois adaptateurs contre un faux transport,
la vérification des signatures y compris le repli refusé, la déduplication d'un
webhook rejoué dix fois, et l'absence de dérive du prorata.

Ce dernier point a fait refaire le module de règlement : la première version
arrondissait à chaque versement et accordait quarante-quatre jours au lieu de
quarante-cinq sur trente versements de cent francs. Le modèle est désormais
cumulé, et un test énonce la propriété qui l'empêche — seul le total compte,
jamais le découpage.

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
