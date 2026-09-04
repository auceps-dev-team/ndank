# Journal des versions

Ndank suit un versionnage simple : `+0.1.0` pour une modification majeure ou
importante, `+0.0.1` pour une modification mineure ou une correction, rien pour
le reste.

---

## 0.6.0

Ndank sait envoyer. Un hôte au niveau 2 n'a plus rien à écrire : il pose ses
clés, nomme ses passerelles, et le passage quotidien part.

### Ajouté

**La rédaction** — `src/envoi/redaction.ts`. `Message` portait des faits ; il
manquait les phrases. Trois formes, une par canal, et trois règles qui les
tiennent :

- **le lien ne se coupe jamais.** Un SMS trop long coûte un segment de plus ;
  un lien tronqué ne mène nulle part, donc la relance la plus chère de
  l'échelle — celle qu'on n'envoie qu'au moment où l'accès va tomber — ne sert
  plus à rien. C'est le nom de l'offre qui cède : l'abonné sait à quoi il est
  abonné, il ne sait pas qu'on va lui couper l'accès. Même règle pour le titre
  d'une notification, où le suffixe « dernier rappel » survit ;
- **on mesure après le repli.** « œ » devient « oe » : mesurer avant
  sous-estimerait le coût, et le message tiendrait sur le papier en débordant
  sur la facture. La recherche passe par `segments()`, jamais par un compte de
  septets recopié ailleurs ;
- **on prévient que le message a pu croiser un paiement.** Le webhook d'un
  opérateur arrive quand il arrive ; le passage part à heure fixe. Sans cette
  phrase, l'abonné qui a réglé la veille au soir conclut qu'on ne l'a pas vu,
  et il repaie.

**Les transporteurs et l'envoi composé** — `src/envoi/port.ts`,
`src/envoi/compose.ts`. Un `Transporteur` ne fait que la moitié qui dépend du
fournisseur : il reçoit un contenu déjà rédigé et l'expédie. `envoiCompose`
recolle, et rend un `Envoi` que le cœur consomme sans rien savoir de tout cela.

Deux règles y décident de vraies coupures d'accès :

- **un canal sans passerelle n'est pas disponible.** Le moteur descend
  l'échelle du palier et s'arrête au premier canal qui part ; au dernier
  palier, il n'y a pas de suivant. Un « disponible » menteur ferait couper
  quelqu'un qu'on n'a jamais prévenu ;
- **aucune exception ne remonte jusqu'au moteur.** Il rattrape, mais au niveau
  de l'abonnement entier : une passerelle SMS en délai d'attente ferait de cet
  abonné un incident, et le push, gratuit et disponible, ne partirait pas
  parce que le SMS était lent.

**`envoiMuet()`** rédige tout et n'expédie rien — pour un premier passage à
blanc sur la base de production, où l'on découvre qu'un libellé d'offre fait
déborder le SMS avant que les abonnés ne le découvrent.

**Quatre passerelles livrées.** Resend et Brevo pour le courriel, Twilio pour
le SMS, Expo pour la notification. Chacune évite un piège précis : Brevo
n'authentifie pas par un Bearer mais par un en-tête `api-key` ; Twilio attend
un formulaire et non du JSON, et peut rendre `failed` dès la création ; Expo
cache ses refus dans un `200`, une entrée par appareil.

**`Remise.aRetirer`** remonte les jetons d'appareil que la passerelle déclare
morts. Sans eux, `joignable("push", …)` continue de rendre vrai : un abonné
dont le seul appareil est mort semble joignable, et le palier se consomme sur
un canal qui ne mène nulle part.

**Le registre des passerelles** — `src/envoi/registre.ts`. Même promesse que
celui des paiements, plus `verifierEnvoi()`, qui refuse de laisser démarrer une
application muette. Cette vérification-là compte plus que celle des paiements :
une clé de paiement absente se découvre au premier abonné qui clique ; une clé
d'envoi absente ne se découvre pas. Le passage tourne, l'erreur est rattrapée,
le bilan compte un `injoignable` de plus — et ce chiffre n'alerte personne un
mardi matin. La panne se voit au troisième jour, quand l'accès tombe pour
quelqu'un qui n'a rien reçu.

**Les fondations d'Orange SMS, Africa's Talking, FCM et Web Push.** Même règle
que `directs.ts` du côté des paiements : on n'écrit pas d'adresse d'API sur la
foi d'un souvenir. Il fallait y résister davantage ici — ces API-là sont plus
simples, donc plus faciles à deviner. Facile à deviner ne veut pas dire juste.

### Corrigé

**On ne salue plus l'abonné par le nom de son offre.** `messagePour` repliait
sur `ou.nom ?? abonnement.libelle` : le courriel disait « Bonjour Pass
Créateur ». `Coordonnees.nom` annonçait pourtant la bonne règle depuis le début
— « `null` quand on ne sait pas, on dira Bonjour » — mais `Message.destinataire`
était un `string`, donc le repli était le seul moyen de compiler. Le `null`
remonte maintenant jusqu'à la rédaction, qui sait le dire.

**Toutes les espaces d'Unicode se replient, et plus seulement quatre.** La
table de `gsm7` en listait quatre, rencontrées au fil de l'eau ; les six autres
disparaissaient du message **et** étaient comptées comme des pertes. Les mots se
recollaient, et la liste des pertes criait au loup à chaque relance — si bien
qu'une vraie perte n'aurait plus été vue. Une règle remplace la liste, parce
qu'une liste oublie.

**`enE164` ne retire plus le zéro de tête.** La première version le retirait,
par analogie avec la France. La Côte d'Ivoire est passée à dix chiffres en
2021 : ce zéro fait **partie** du numéro. Le retirer donnait `+225700000000`,
douze chiffres, un numéro qui n'existe pas — donc un SMS refusé, sur le marché
prioritaire, au dernier palier de l'échelle. Le Bénin a fait le même changement
en 2022 ; le Sénégal, le Mali, le Burkina et le Cameroun n'ont pas de zéro de
tête du tout. `retirerZeroDeTete` existe pour les plans qui en ont un, et il
faut le demander.

### Déplacé

**Le port `Http` vit à la racine**, dans `src/http.ts`. Il était né dans la
couche d'encaissement parce que les fournisseurs de paiement furent les
premiers à avoir besoin du réseau, mais un port HTTP n'a rien d'une notion
comptable. L'y laisser aurait obligé la couche des relances à importer celle
des paiements pour envoyer un courriel. `encaissement/port.ts` le réexporte :
le chemin d'import des hôtes ne change pas.

---
## 0.5.0

Le niveau 2 devient utilisable : les ports sont écrits contre le schéma. Un hôte
qui accepte Prisma et PostgreSQL n'a plus qu'à fournir `Envoi` — Ndank ne sait
pas envoyer ses courriels à sa place.

### Ajouté

**`portsPrisma(client, { projetId })`** rend `lecture`, `ecriture` et
`creances`. Deux tests font tourner le passage quotidien du niveau 1 contre ces
ports, sans qu'une ligne du cœur ne change.

**Une interface étroite du client Prisma.** Ndank ne dépend pas de
`@prisma/client` : il décrit la forme dont il a besoin, et le client généré la
satisfait. `dependencies` reste vide, et un hôte qui reste au niveau 1
n'installe rien. Les lignes lues sont typées au champ près ; les arguments
`where` et `data` restent ouverts, parce que les reproduire à la main
donnerait une fausse sécurité — ce sont les tests contre un faux client qui
vérifient les clauses envoyées.

### Corrigé dans le schéma

**Les abonnements résiliés sont désormais écartés du lot.** Le cas était
retors : `etatDe` rend `RESILIEE` avant même de regarder les dates, donc
`gesteDuJour` rend `RIEN` — pour toujours. Le moteur ne clôt jamais un résilié.
Laissés éligibles, ils seraient restés dans un lot plafonné aussi longtemps que
la base existe, exactement comme les clos. `resilieeLe` entre donc dans l'index
du passage quotidien, avant `echeance`.

**Un index sur `identifiantFournisseur` seul.** La déduplication interroge par
cette colonne, qui est la seconde de l'unicité `(fournisseur,
identifiantFournisseur)` — position qu'un index B-tree ne sait pas exploiter.
Sans lui, chaque webhook parcourait la table des versements, et Paystack en
rejoue pendant soixante-douze heures.

**Une clé d'idempotence sur le journal.** Le moteur redit `suspendre` chaque
jour de la fenêtre de reprise : trente appels pour un seul fait. `Evenement.cle`
et l'unicité `(abonnementId, type, cle)` n'en gardent qu'un. Le champ est
nullable, et PostgreSQL considère deux `NULL` comme distincts — les événements
qui doivent se répéter le peuvent.

---

## 0.4.0

Le niveau 2 commence : les tables toutes faites, pour qui accepte Prisma et
PostgreSQL. Elles n'implémentent rien d'autre que les mêmes ports — le cœur ne
change pas d'une ligne.

### Ajouté

**`prisma/schema.prisma`** — neuf modèles, cinq énumérés, validés par
`prisma validate`. `Projet`, `Offre`, `Abonne` et `Abonnement` portent le
métier ; `Relance`, `Invitation` et `Versement` portent les faits ;
`WebhookRecu` et `Evenement` portent la trace.

**`.env.example`** — les variables attendues, fournisseur par fournisseur, y
compris ceux qui ne sont pas encore branchés : un compte marchand met des
semaines à ouvrir, et les champs sont déjà connus.

**`npm run schema`** — la validation, branchée sur l'intégration continue.

### Ce que le schéma décide

**Il n'y a pas de colonne `etat`.** ACTIVE, A_RENOUVELER, SUSPENDUE et EXPIREE
se déduisent des dates. La base garde les faits — payé, relancé, résilié, clos —
pas les conclusions. C'est la même règle que dans le cœur, et c'est la première
chose que quelqu'un voudra changer.

**Aucune clé d'API en base.** Une base est sauvegardée, répliquée, restaurée sur
un poste de développement. Les identifiants viennent de l'environnement, et
`.env` rejoint `.gitignore`.

**Le prix est recopié dans l'abonnement.** Sinon augmenter un tarif changerait
rétroactivement ce que doivent les abonnés en cours, y compris sur un cycle déjà
à moitié payé.

**Deux contraintes d'unicité portent l'idempotence** plutôt que de l'espérer :
`(abonnementId, cle)` sur les relances, `(fournisseur, identifiantFournisseur)`
sur les versements — cette dernière empêchant un webhook rejoué soixante-douze
heures durant d'avancer trois fois la même échéance.

**`closLe` et son index** rendent applicable le contrat « ne pas rendre ce qui
est déjà clos » de `aRelancer`, sans quoi les morts occupent un lot plafonné.

L'argent est en `Int`, en unités mineures. Jamais `Float`, jamais `Decimal`.

### Ce qui n'est pas livré

Pas de migrations : elles entreraient en conflit avec l'historique de l'hôte. Le
schéma se copie et se migre chez lui.

Pas encore d'implémentation des ports `Lecture`, `Ecriture` et `Creances` contre
ces tables. C'est l'étape suivante, et c'est elle qui rendra le niveau 2
utilisable sans écrire une requête.

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
