# Journal des versions

Ndank suit un versionnage simple : `+0.1.0` pour une modification majeure ou
importante, `+0.0.1` pour une modification mineure ou une correction, rien pour
le reste.

---

## 0.13.0

Les neuf promesses des maquettes, et l'état de santé qui va au-delà du
battement.

### Ajouté

**`ndank/argent`** — `parMois`, `recurrentMensuel`, `evolution`. Il ne mélange
jamais deux devises et arrondit une fois par groupe : additionner des XOF et des
NGN donne un nombre qui ne veut rien dire, et arrondir à chaque ligne fait
dériver un total de plusieurs unités sur cinq cents abonnés.

**`ndank/relances`** — `coutDesRelances` répond à « combien m'a coûté l'échelle
ce mois-ci », et `statistiques` mesure le délai d'un abonné contre **l'échéance
visée**, lue dans la référence, et non contre son paiement précédent. Un abonné
qui paie deux jours en retard tous les mois a un délai constant, pas croissant.

**Le checkout public** — `lienOffre` produit une adresse qu'on met sur un site,
et `/o/<jeton>` vend une offre en trois champs. Rien n'est stocké entre la
demande de paiement et le retour : l'offre et l'abonné voyagent dans la
référence, donc pas de table d'attente, pas de purge à écrire, et pas de réponse
à trouver à « que fait-on des lignes que personne n'est venu chercher ».

Le courriel est obligatoire : c'est le barreau gratuit de l'échelle, et sans lui
chaque relance de cet abonné coûte un SMS.

**`ndank/projection`** — la seule question qui ne se répond pas chez l'hôte.
« Voir tous mes abonnements » ne peut pas se traiter chez le marchand : un
abonné chez trois hôtes est trois lignes dans trois bases que rien ne rapproche.
Chaque hôte pousse donc de quoi afficher une carte ; l'argent, les versements,
les webhooks et les coordonnées complètes ne bougent pas.

On envoie des **dates**, jamais un état. `etatDe` reste la seule autorité, et
Ndank App l'applique aux dates reçues — sinon un abonné lirait « à jour » chez
lui et « suspendu » chez le marchand, selon la fraîcheur de la dernière poussée.

**`ndank/identite`** — `normaliserIdentifiant` et `empreinte`.

L'empreinte **n'est pas de l'anonymisation**, et le fichier le dit sans détour :
un numéro vit dans un espace minuscule, et quiconque tient le poivre en dresse
la table. Ce qu'elle fait, c'est qu'une copie de la base de Ndank App prise sans
le poivre ne livre pas un annuaire. Ndank App détient donc bien des données
personnelles, et l'empreinte ne l'en dispense pas.

**`ndank/code`** — le code à six chiffres du SMS de connexion. Dérivé de
`HMAC(secret, identifiant + fenêtre)` plutôt que tiré au sort et rangé quelque
part : pas de table, pas de purge, pas de code oublié en base six mois plus
tard. C'est RFC 4226 avec une fenêtre de temps à la place du compteur.

Il ne fait **pas** d'authentification — la session, le cookie et l'écran sont à
Ndank App. Six chiffres font un million de possibilités, ce qui se parcourt en
quelques secondes : le code ne protège rien par lui-même, c'est le nombre
d'essais qui protège. `Tentatives` n'est donc pas optionnel et `verificateur()`
refuse de se construire sans lui.

**`ndank/sante`** et **`ndank/prisma/sante`** — l'état de santé élargi.

Le battement répond à « est-ce que le moteur tourne ». Mais un moteur qui tourne
parfaitement peut passer ses journées à ne rien faire : la passerelle SMS refuse
la clé depuis mardi, les webhooks arrivent avec une signature qu'on rejette
depuis le dernier déploiement, quarante abonnés ont payé sans que leur
abonnement bouge. Rien de cela n'arrête le passage quotidien.

Chaque constat porte son geste, même règle que `direSante` : « 12 échecs
d'envoi » n'aide personne, « 12 relances sur 130 n'ont pas pu partir » se
comprend. `GET /sante` porte `constats` et `pire` quand les signaux sont
branchés, et garde exactement sa forme quand ils ne le sont pas.

**Quatre gestes d'écriture** — « Relancer maintenant », « Marquer payé »,
« Suspendre l'accès », « Résilier », sur `ndank/api/gestes` et un jeton à part.

**L'opérateur habituel**, les **statistiques par abonné**, et la **répartition
par fournisseur**.

### Deux arbitrages qui valaient d'être écrits

**Ce qu'on ne sait pas lire est un constat, pas un zéro.** Si la requête qui
compte les envois ratés échoue, rendre zéro ferait afficher « tout va bien » sur
la foi d'une question qu'on n'a pas pu poser. `bilan()` ne lève jamais et isole
chaque signal : ce qui échoue devient `ILLISIBLE`, le reste est rendu.

**« Tentés » ne vient pas du journal.** Le journal ne garde pas les envois
réussis, sauf si l'hôte le demande — donc `tentes === echoues` partout, et le
bilan aurait annoncé chaque jour que toutes les passerelles sont mortes. Une
alerte qui se déclenche toujours ne se lit plus au bout d'une semaine. Les
partis se comptent dans `Relance.canaux`, qui est écrit quoi qu'il arrive.

### Corrigé

**Deux écritures d'un même numéro ne donnaient pas la même identité.**
« 07 00 00 00 00 » et « +2250700000000 » produisaient deux empreintes. Deux
hôtes qui rangent le numéro autrement auraient donc donné deux identités à la
même personne, et la vue multi-sites — dont c'est toute la raison d'être —
n'aurait affiché qu'une carte sur deux. Sans erreur, sans trace, sans que
personne ne sache quoi chercher.

`normaliserIdentifiant` **lève** sur un numéro qui n'est pas en E.164 plutôt
que d'en fabriquer un second. On ne peut pas deviner l'indicatif manquant —
« +225 » a l'air raisonnable jusqu'au premier abonné sénégalais — mais l'hôte
sait le sien, et il a déjà `enE164`.

Trouvé par un test, en écrivant le code SMS.

**`referenceDeSouscription` était ambiguë.** Une offre `pass-pro` et un abonné
`usr-1` donnaient `S-pass-pro-usr-1-3`, qui se relit de quatre façons. Tout est
désormais encodé en hexadécimal.

**`lienOffre` produisait `base/JETON` au lieu de `base/o/JETON`.** Corrigé dans
`lienOffre` plutôt que dans la documentation : un hôte ne doit pas pouvoir
oublier le segment.

### Ce qui n'a pas été fait, et pourquoi

**L'authentification.** Ndank livre le code SMS, pas la connexion. Une
bibliothèque qu'on installe chez un marchand n'a ni compte, ni session, ni
écran — et lui en donner ferait porter au SDK une responsabilité qui appartient
à Ndank App.

---

## 0.12.0

Cinq journaux qui n'écrivaient nulle part, et une table morte depuis six
versions.

### Ajouté

**`ndank/prisma/journal`** — `journalPrisma(client, { projetId })` remplit les
cinq crochets `journal?` de l'envoi, de la page, des webhooks, de l'API et des
gestes. Aucun n'était implémenté : ils existaient, ils étaient documentés, et
tout ce qu'ils racontaient disparaissait à la fin du processus.

**`WebhookRecu` cesse d'être morte.** Déclarée dans le schéma depuis la 0.4.0,
jamais écrite une seule fois. Une table morte n'est pas neutre : elle fait
croire qu'on garde quelque chose. Le gestionnaire de webhooks porte désormais le
corps brut et le verdict de signature sur ses faits **terminaux** — jamais sur
`RECU`, qui est émis avant qu'on sache, et `signatureValide` n'accepte pas de
doute.

### Ce qu'il jette, et pourquoi

Un journal qui se remplit de bruit cesse d'être lu — ce dépôt porte déjà
l'argument, écrit à propos des pertes GSM-7 : on criait au loup à chaque
relance, si bien qu'une vraie perte n'aurait plus été vue.

- **envoi** : les échecs seulement. Les relances parties sont déjà dans
  `Relance`, avec leurs canaux ;
- **page** : tout, ouvertures comprises — c'est le seul endroit qui dise combien
  de gens ouvrent sans aller au bout ;
- **webhooks** : tout ;
- **API** : les non-2xx — un tableau de bord qui interroge toutes les trente
  secondes produit deux mille huit cents lectures par jour ;
- **gestes** : les refus — les gestes posés sont déjà dans `Evenement`.

**Une exception, trouvée par un test qui se contredisait.** « On jette les
réussites » était trop large. Expo répond `200` avec un refus **par appareil** :
une notification part vers un téléphone et est refusée par l'autre, dont
l'application a été désinstallée. `Relance` note l'envoi, pas ce jeton-là — et
c'est lui qui fait qu'un abonné *semble* joignable en push alors qu'il ne l'est
plus. Un envoi réussi qui rapporte des jetons morts est donc conservé.

Le commentaire du test disait la bonne chose, son assertion disait le contraire.
C'est la politique qui avait tort.

### Il tamponne

Les crochets sont synchrones à dessein : celui de l'envoi est appelé dans la
boucle du passage quotidien, où une écriture lente ralentirait tout le lot. On
ne peut donc pas attendre — et écrire sans attendre, cinq cents insertions de
front, serait une rafale sur la base au moment où elle sert à autre chose.

Le journal accumule, écrit par lots, et se vide tout seul quand le lot déborde.
`vider()` ne lève jamais ; `surErreur` existe pour que son propre échec se voie
— sans lui, une base qui refuse les écritures le rendrait silencieusement
inutile, c'est-à-dire exactement la panne qu'il existe pour révéler ailleurs.

---
## 0.11.0

Le moteur dit maintenant s'il tourne encore.

### Ajouté

**`ndank/battement`** — `passerEtTracer`, `sante`, `direSante`.

Tout le reste de ce dépôt s'occupe de ce qui peut mal se passer *pendant* un
passage : passerelle en délai d'attente, ligne corrompue, fournisseur qui répond
de travers. Chacun est rattrapé, compté, journalisé.

**La panne la plus coûteuse n'est pas là.** C'est le passage quotidien qui *ne
tourne plus du tout* — le cron meurt, le conteneur ne redémarre pas, un
déploiement casse la planification. Alors il n'y a aucun échec à journaliser : il
y a du **silence**, et le silence ressemble exactement à « tout va bien ».

Pendant ce temps, plus une relance ne part et plus un accès n'est coupé. Le
tableau de bord continue d'afficher des chiffres justes — l'état se déduit des
dates, donc il ne ment pas — mais plus personne n'agit dessus. On s'en aperçoit
quand un abonné appelle pour dire qu'il n'a jamais été prévenu, trois semaines
plus tard.

D'où le renversement : **on enregistre chaque passage, y compris ceux où tout
s'est bien passé.** Un journal d'incidents ne le fait jamais — il n'a rien à dire
d'un jour sans incident — et c'est précisément pour cela que cette panne lui
échappe partout.

**Trois états, et non deux.** La trace s'ouvre *avant* le passage et se ferme
après. Un passage qui a démarré et n'a jamais fini est donc distinguable d'un
passage qui n'a jamais démarré : le premier laisse peut-être la base à moitié
écrite, le second veut dire que la planification est morte. Les confondre ferait
chercher au mauvais endroit.

**Vingt-six heures, et non vingt-quatre.** Un cron quotidien dérive — 6 h 00 un
jour, 6 h 05 le lendemain — et un seuil à vingt-quatre alerterait sur cette
dérive normale chaque semaine, jusqu'à ce que plus personne ne regarde.

**`direSante` attache une action à chaque état.** « BLOQUE » sans rien d'autre
n'aide personne ; « un passage a démarré il y a 4 h et n'a jamais fini » se
comprend, et la suite se devine. Et quand tout va bien, il le dit — « rien à
faire » vaut mieux qu'un silence de plus.

**`GET /sante`** sur l'API de lecture, et le modèle `Passage` dans le schéma.
`portsPrisma` rend `battements`.

### La seule exception à la règle des jours civils

Partout ailleurs, Ndank compare des jours civils : c'est ce qui empêche l'heure
du cron de décider d'une coupure d'accès. Ici on mesure **le cron lui-même**, et
les heures sont la bonne unité — un passage à vingt-cinq heures va bien, un à
cinquante ne va pas, et les deux peuvent tomber sur « hier » en jours civils.

---
## 0.10.1

Un correctif, trouvé en expliquant la version précédente.

### Corrigé

**Les deux écritures d'un paiement manuel tombent ou réussissent ensemble.**

La 0.10.0 les enchaînait — le reçu, puis l'échéance — en pariant qu'un rejeu
réparerait une panne au milieu. Le pari était faux.

Écrire le reçu pose `compteLe`. Au rejeu, `dejaCompte` répond « déjà compté »,
`reconcilier` rend « rien à faire », et **l'échéance ne bouge jamais**. L'abonné
a payé, l'argent est enregistré, son abonnement reste en retard — et aucune
tentative ne peut le corriger.

`reconciliation.ts` avait pourtant posé la règle dès la 0.3.0 : « faire avancer
une échéance et noter le versement qui l'a payée doivent tomber ou réussir
*ensemble* ». `marquerPaye` faisait exactement ce que ce paragraphe interdit.

### Ajouté

**`Interventions.ensemble`**, facultative, et sa forme évite un second piège.
Ceci ne transactionne rien :

```ts
ensemble: (travail) => client.$transaction(() => travail())
```

Prisma ouvre bien une transaction, mais les écritures de `travail` passent par
le client extérieur — pas par le `tx` qu'il vient de fournir. Tout paraît
normal, et rien n'est atomique. Ce serait pire que de ne rien avoir : on aurait
cessé de se méfier.

`travail` **reçoit** donc les écritures, construites contre le client
transactionnel. `ClientNdank.$transaction` est typé pour rendre un `ClientNdank`,
ce qui oblige l'adaptateur à les reconstruire — un `() => Promise<T>` aurait
laissé écrire le piège sans qu'aucun type ne proteste.

**`PortsIntervention.exigerEnsemble`** permet de refuser un paiement manuel
plutôt que de l'écrire sans filet. Un réglage, pas une supposition : l'hôte
choisit ce qu'il préfère risquer, en le sachant.

### Vérifié ailleurs

**`souscrire` est sûr**, et la raison est écrite dans le fichier : sa première
écriture est un `upsert` idempotent, la seconde est gardée par une lecture. Une
panne au milieu laisse une fiche de contact orpheline, sans conséquence, et le
rejeu reprend proprement. C'est exactement ce qui manquait à `marquerPaye`, dont
la première écriture posait un verrou qui empêchait la seconde d'avoir lieu.

**`agir` et `relancerMaintenant`** envoient puis notent : une panne au milieu
renvoie le message demain. Un doublon, pas de l'argent — l'arbitrage déjà posé.

---
## 0.10.0

Les quatre verbes que les maquettes portaient depuis le début. Deux d'entre eux
ont révélé des défauts du cœur qu'aucun écran n'avait encore mis au jour.

### Corrigé dans le cœur

**Résilier n'est pas confisquer.** `accesOuvert` se contentait de lire l'état, et
`etatDe` rend `RESILIEE` en premier — donc l'accès tombait à l'instant du clic.
Un abonné qui résilie le 3 a payé jusqu'au 30 : lui couper le service alors,
c'est garder son argent et lui retirer ce qu'il a acheté.

Résilier veut dire deux choses, et deux seulement : plus de relance, plus de
renouvellement. Les deux étaient déjà vraies ailleurs — `gesteDuJour` rend
`RIEN` sur un résilié, et le lot du passage les écarte. Le temps déjà payé
reste dû, **sans grâce au-delà** : la grâce existe pour laisser le temps de
payer pendant qu'on relance, et on ne relance pas un résilié.

**Suspendre à la main ne pouvait pas s'exprimer.** L'état se déduit des dates ;
une suspension manuelle n'a aucune date qui la porte — un abonné à jour,
suspendu pour un litige, a exactement les mêmes dates que la veille.

D'où `suspenduLe`, **seule colonne d'état du schéma**. L'exception se justifie :
ce que l'architecture refuse, ce sont les *conclusions* — une colonne `etat` qui
se désynchroniserait le jour où un passage rate son tour. Ce qu'elle garde, ce
sont les *faits*, et « le marchand a suspendu cet abonné le 4 septembre » en est
un. Contrairement à la résiliation, elle coupe l'accès sur-le-champ : c'est sa
raison d'être.

### Ajouté

**`ndank/intervention`** — `suspendre`, `retablir`, `resilier`, `marquerPaye`,
`relancerMaintenant`.

L'API du tableau de bord avait été conçue en lecture seule pour deux risques
nommés : les erreurs de saisie et la corruption. Ces verbes les rouvrent, donc
ils y répondent plutôt que de s'en remettre à la prudence de qui clique :

- **rien ne s'écrit sans auteur.** Une base qu'on peut modifier sans laisser de
  trace est une base dont on ne peut plus rien reconstituer ;
- **un paiement manuel exige une pièce** — reçu, virement, bordereau. C'est le
  geste le plus lourd du tableau de bord, le seul qui fasse apparaître un mois
  d'abonnement sans qu'un franc ait bougé. La pièce le rend vérifiable après
  coup, et **idempotent** : l'identifiant du versement en dérive ;
- **une relance manuelle est bornée à une par jour.** Un bouton se clique cinq
  fois quand rien ne semble se passer ; cinq SMS partent, ils sont facturés, et
  l'abonné les reçoit tous.

`marquerPaye` passe par `reconcilier`, comme un vrai paiement : même politique
de règlement, même cumul des versements partiels, même contrôle de devise. Un
chemin séparé aurait produit deux arithmétiques pour un seul fait, et c'est
toujours la seconde qui se trompe. Il écrit le versement **avant** d'avancer le
cycle — si la seconde écriture tombe, on rejoue ; l'inverse offrirait un mois.

`relancerMaintenant` choisit le palier d'après l'échéance, jamais d'après le
clic. Laisser choisir le canal aurait fait cliquer « SMS » par défaut — c'est
celui dont on est sûr qu'il arrive — et rendu chaque relance payante.

Aucun verbe ne lève sur un refus : « déjà suspendu », « reçu déjà enregistré »,
« une relance est déjà partie aujourd'hui » sont des cas normaux.

**`ndank/api/gestes`** expose les cinq verbes en HTTP, **sur une adresse et un
jeton distincts de ceux du tableau de bord**. `routeurApi` reste en lecture
seule, et la raison n'a pas changé : il sert une application cliente,
distribuée, dont le jeton est extractible. Les mélanger aurait fait qu'un jeton
volé dans une application Android donne le droit de marquer des abonnements
comme payés.

L'auteur arrive par l'en-tête `X-Ndank-Auteur`, posé par le serveur de l'hôte
depuis sa session — jamais par le corps, où il serait déclaratif. Sans lui, on
refuse d'écrire plutôt que de journaliser « inconnu ».

**`portsPrisma` rend `interventions`.** La pièce justificative devient la clé
d'idempotence du versement, via la même unicité que les opérateurs. Le journal
des gestes porte l'horodatage dans sa clé et non le cycle : deux suspensions
successives sont deux faits distincts — l'inverse du journal du moteur, où la
clé de cycle sert à n'en garder qu'un.

---
## 0.9.0

Une erreur d'un facteur cent, trouvée en regardant un tableau de bord.

### Corrigé

**Paystack compte en centièmes, même pour le franc CFA.** Relevé en mode test :

```
envoyé « amount: 2000 »    → affiché « XOF 20.00 »
envoyé « amount: 200000 »  → affiché « XOF 2,000.00 »
```

Ndank affirmait partout que le franc CFA n'a pas de subdivision, donc que deux
mille francs se transmettent `2000`. La première moitié est vraie — l'ISO 4217
donne bien zéro décimale au XOF. La seconde était fausse.

**Un abonnement à 2 000 F était prélevé vingt francs.** Personne ne s'en serait
plaint : c'est une erreur qui va dans le sens de l'abonné. Le marchand l'aurait
découverte sur son relevé, un mois plus tard.

Pourquoi elle était restée invisible : pour le naira et le cedi, la convention
de Paystack coïncide avec la norme — kobo, pesewas. L'écart n'apparaît que sur
les devises à zéro décimale, c'est-à-dire exactement celles de la zone que
Ndank sert.

### Ajouté

**`ndank/devise`** porte la table ISO 4217 et les deux conversions. L'unité
interne reste la norme — `2000` en XOF vaut deux mille francs, `2000` en GHS
vaut vingt cedis — et **chaque adaptateur convertit**, au même titre qu'il
traduit les statuts. Une erreur chez l'un ne contamine pas les autres, et la
règle se lit là où elle s'applique.

L'arithmétique reste entière dans les deux sens : un flottant sur de l'argent
réel est la seule erreur qu'on ne rattrape jamais. Une division qui ne tombe
pas juste arrondit **au supérieur**, pour ne pas encaisser moins que le prix
affiché.

`formater()` écrit un montant pour un humain, avec le bon nombre de décimales
— parce que trois couches en avaient besoin et que chacune l'aurait écrit à sa
façon.

**Le refus de devise est reformulé.** `Currency not supported by merchant` ne
dit pas qu'il parle du compte marchand, et on cherche donc du côté de la
requête. L'adaptateur nomme la vraie cause.

### Ce qui reste non vérifié

**La convention de Flutterwave n'a pas été mesurée**, faute de clé. `0` traduit
la lecture qu'on a de sa documentation — des unités majeures, l'inverse de
Paystack. Le fichier le dit en toutes lettres.

Ce doute ne peut pas mordre le marché principal : pour le franc CFA, les deux
lectures coïncident, donc la conversion est l'identité. Il ne concerne que les
devises à deux décimales chez un hôte Flutterwave — et s'il se révélait faux,
il **sous-facturerait**. C'est le sens dans lequel on préfère se tromper. Le
bac à sable le vérifie dès qu'une clé est posée.

### Documenté

**La devise est celle du compte, pas celle de la requête.** Un compte marchand
n'active que les devises de son marché : sur un compte XOF, Paystack refuse
`NGN`, `GHS`, `KES`, `ZAR` et `USD`. Écrire `GHS` dans sa grille avec un compte
sénégalais ne produit pas une conversion, mais un refus — au premier abonné qui
clique.

---
## 0.8.1

Le bac à sable a tourné pour la première fois contre un vrai compte Paystack.
Neuf vérifications, dont une qui a trouvé un défaut sérieux.

### Corrigé

**`abandoned` veut dire « pas encore », et non « trop tard ».** Relevé, trois
secondes après l'initialisation :

```
initialize  →  reference « st1788517633705 »
verify      →  status "abandoned"
               gateway_response "The transaction was not completed"
               paid_at null
```

Paystack marque `abandoned` dès qu'une transaction existe et n'est pas réglée —
donc pendant **tout** le temps où l'abonné est en train de payer. L'adaptateur
le traduisait en `EXPIRE`, par lecture du mot.

La page de validation traite `EXPIRE` comme terminal : elle cesse d'interroger
et annonce « la demande a expiré avant que vous ne la validiez ». L'abonné
voyait donc ce message cinq secondes après avoir cliqué sur « Régler », alors
qu'il saisissait son code sur l'écran du fournisseur. Il revenait en arrière,
recommençait, payait deux fois — ou renonçait.

Aucune relecture du code ne l'aurait attrapé : le mot anglais dit le contraire
de ce que le champ signifie. Et aucun test contre un faux non plus — c'est
celui qui écrit le faux qui décide quand renvoyer `abandoned`, et il le renvoie
quand il pense à l'abandon.

Paystack ne distingue jamais « pas encore » de « renoncé » : le statut reste
`abandoned` dans les deux cas. C'est donc à Ndank de décider quand cesser
d'attendre — la page le fait au bout de deux minutes, le passage quotidien au
bout de l'échéance.

**Le contrôle du doublon acceptait n'importe quelle exception.** Une coupure
réseau y serait passée pour une confirmation. Il vérifie maintenant que le
motif parle de duplication.

### Confirmé contre le vrai bac à sable

- **Paystack refuse une référence déjà vue** — `Duplicate Transaction
  Reference`, en 400. C'est ce sur quoi repose le correctif de la 0.7.0, et ce
  n'était jusqu'ici qu'une affirmation dans un commentaire ;
- **une référence inexistante lève** — `Transaction reference not found.`, en
  400 — plutôt que de ressembler à un échec de paiement, ce qui couperait
  l'accès de quelqu'un ;
- **le XOF et le canal `mobile_money` fonctionnent ensemble** : la transaction
  revient avec `channel: "mobile_money"`, `currency: "XOF"`, `amount: 2000` —
  ce qui confirme au passage que les unités mineures du franc CFA sont bien des
  francs entiers ;
- **la référence de la 0.7.0 passe le jeu de caractères de Paystack.**

### Appris en chemin

**Une adresse en `.test` est refusée.** Le harnais employait
`essai@ndank.test` — `.test` est pourtant le domaine réservé aux essais
(RFC 2606). Paystack répond `"email" must be a valid email`, en 400 : un
message qui ne dit pas que c'est le domaine de premier niveau qui gêne.

**Un compte n'active que les devises de son marché.** NGN, GHS, KES, ZAR et
USD reviennent en `403 Currency not supported by merchant` sur un compte XOF.
Le message est clair — pour peu qu'on sache qu'il parle du compte et non de la
requête.

---
## 0.8.0

Ndank s'installe. Et l'on peut enfin dire ce qu'on vend, et faire naître un
abonnement.

Cette version répond à cinq questions posées sur le produit lui-même — la
vérification a trouvé plus de manques que de défauts, ce qui est la bonne
nouvelle et la mauvaise à la fois.

### Ajouté

**`npm install ndank` fonctionne.** Il ne fonctionnait pas, et rien dans le
dépôt ne le disait : `"private": true` interdisait la publication, `main`
pointait sur `./src/moteur.ts` — du TypeScript brut — et il n'y avait aucune
étape de construction. Ce qui manquait n'était pas la permission, c'était le
paquet.

`tsup` construit vingt-sept points d'entrée en ESM **et** en CommonJS, avec les
types. Le CommonJS n'est pas du zèle : une part considérable des services Node
en production tourne encore ainsi — Express au premier chef — et
`require("ndank")` doit marcher.

**`scripts/epreuve-paquet.mjs`** fait ce que fera l'hôte : `npm pack`, puis
`npm install` dans deux projets vides — un ESM, un CommonJS — puis l'import des
vingt-sept chemins et l'appel de quelques fonctions. Les tests du dépôt
importent par chemins relatifs et ne passent jamais par `package.json` : ils ne
pouvaient rien dire de ce qu'un hôte reçoit. Le CI l'exécute.

**La grille tarifaire** — `ndank/offre`. Le schéma portait un modèle `Offre`
sans lecteur, et un hôte du niveau 1 n'avait aucun endroit où dire ce qu'il
vend. Elle se déclare en code ou se lit en base, et dans les deux cas elle est
vérifiée. Chaque règle a un coût réel : un montant non entier se fait arrondir
ou refuser chez le fournisseur ; deux offres au même identifiant font que
l'abonné paie l'une et reçoit l'autre ; une cadence inconnue ne se rattrape
qu'au moment de renouveler, un mois plus tard.

Elle attrape **« CFA »**, et c'est le point qui compte pour cette zone : trois
lettres majuscules, donc une vérification de forme le laisse passer. Ce n'est
pourtant pas un code ISO 4217 — le franc CFA s'écrit `XOF` ou `XAF`. Personne
n'écrit « XOF » sur une facture, et les fournisseurs refusent avec un message
parlant de devise non prise en charge : on cherche alors du côté du compte
marchand.

**La souscription** — `ndank/souscription`. Ndank savait relancer, suspendre,
clore, renouveler, encaisser, réconcilier : tout le cycle de vie d'un
abonnement **qui existe déjà**. Aucune ligne ne savait en créer un.

`souscrire()` part d'un paiement constaté, et ce refus de faire autrement est
la décision qui donne sa forme au module. Un abonnement « en attente de premier
paiement » ne peut pas s'exprimer dans le modèle de cycle — un cycle *commence*
à un paiement. Inventer un cycle de durée nulle produirait soit un accès
ouvert, soit un abonné relancé chaque jour pour un abonnement qu'il n'a jamais
pris.

`Souscriptions.enCours` protège du double abonnement : le double-clic, ou
l'abonné qui repaie parce qu'il n'a pas vu la confirmation, rendent
l'abonnement existant au lieu d'en créer un second — dont il ne verrait jamais
l'un, et qui le relancerait pourtant.

**Trois routes d'API**, tirées des questions posées :

- `GET /offres` — la grille, sans la recopier dans un écran où elle finirait
  par diverger de ce qu'on facture ;
- `GET /abonnements/<id>/versements` — chaque ligne dit `regleNonCompte` : un
  versement réglé mais jamais compté est un paiement qui n'a **pas** prolongé
  l'abonnement, ce qu'on cherche exactement quand un abonné dit avoir payé ;
- **les coordonnées de l'abonné**, dans la liste comme dans le détail. Un
  tableau de bord qui n'affiche que des identifiants est inutilisable : on
  relance quelqu'un, pas un `cuid`.

`/resume` gagne le taux de réussite des paiements sur trente jours. Pris
isolément, un versement échoué ressemble à un abonné qui a changé d'avis ;
c'est leur proportion qui parle.

**`npm run bac-a-sable`** éprouve les adaptateurs contre les vrais bacs à sable
de Paystack et Flutterwave, à partir du paquet construit. Il ne tourne pas dans
`npm test` — la suite du dépôt tourne en une seconde sans réseau, et c'est ce
qui fait qu'on la lance — et il se saute proprement sans clés. Il refuse une
clé de production : ce script initie de vraies demandes de paiement.

Il vérifie notamment qu'une **référence en double est refusée**, ce sur quoi
repose tout le correctif de la 0.7.0 et qui n'était jusqu'ici qu'une
affirmation dans un commentaire.

### Corrigé

**Le schéma Prisma n'était pas dans le paquet.** Le README l'annonçait depuis
la 0.4.0 et `files` ne le contenait pas : un hôte qui installait Ndank au niveau
2 ne le trouvait nulle part. Il est désormais livré, et joignable par
`ndank/schema.prisma`.

**Les exemples du README importaient depuis `./src/`**, donc copiables
uniquement dans le dépôt lui-même.

### Ce que cette version ne fait toujours pas

Dit ici parce qu'on l'a demandé, et qu'un journal doit répondre :

**Un abonné ne peut pas voir tous les sites où il est abonné.** Chaque hôte a
sa propre base et sa propre table `abonne`, dont la clé est `(projetId,
reference)`. Il n'existe aucune identité d'abonné qui traverse deux hôtes — et
donc aucun moyen de relier « Awa chez l'un » et « Awa chez l'autre ». C'est
l'objet de la couche de projection, décidée et non encore écrite.

**Rien n'a jamais appelé un vrai fournisseur.** `npm run bac-a-sable` existe ;
il n'a pas encore tourné avec des clés.

---
## 0.7.0

Le chemin est complet : l'abonné reçoit une relance, ouvre un lien, paie, et
son échéance avance — sans que l'hôte écrive une requête ni une page.

### Ajouté

**Le lien de relance est signé et périssable** — `src/page/lien.ts`. Le README
montrait `/valider/ab-1` ; il avait tort, et c'était un défaut de
confidentialité. Un lien qui porte l'identifiant en clair est **énumérable** :
quiconque en reçoit un — un abonné, quelqu'un à qui il l'a transféré, un
opérateur qui voit passer le SMS — change un chiffre et lit la page d'un autre.
Il n'y a rien à deviner, il suffit de compter.

Deux contraintes que le SMS impose : l'alphabet est celui de base64url, dont
les soixante-quatre caractères sont tous dans l'alphabet GSM 03.38 — le lien ne
fait donc pas basculer la relance en UCS-2 ; et le sceau est tronqué à douze
octets, soit vingt-sept caractères rendus au nom de l'offre sur chaque relance.

**La page de validation** — `src/page/`. Trois routes, aucune ressource
extérieure, aucune ligne de JavaScript. Elle s'ouvre depuis un SMS, sur un
téléphone d'entrée de gamme, en 3G, et c'est le dernier écran avant qu'un
abonné ne perde son accès.

Ce qui a demandé le plus d'attention :

- **un abonnement à jour ne montre pas de bouton.** Le lien vient d'une
  relance ; s'il mène à un abonnement à jour, c'est presque toujours que
  l'abonné vient de payer et que la relance a croisé son règlement — ce dont le
  courriel l'avertissait. Lui présenter quand même un bouton, c'est lui faire
  payer deux fois, et Ndank ne rembourse pas : il n'a jamais touché l'argent ;
- **le constat vérifie que la référence est la sienne.** Sans ce garde-fou, il
  suffirait de changer `ref` dans l'URL pour faire constater le paiement de
  quelqu'un d'autre sur son propre abonnement ;
- **`Referrer-Policy: no-referrer`.** Le jeton est dans l'URL : sans cet
  en-tête, le navigateur l'enverrait au fournisseur dans `Referer` au moment de
  la redirection, et il finirait dans les journaux d'accès d'un tiers ;
- **303 et non 302** après le formulaire, pour qu'un rechargement ne demande
  pas un second paiement ;
- **la réponse du fournisseur ne s'affiche jamais.** Elle peut porter un
  identifiant de compte ou une partie de clé. Elle va au journal de l'hôte.

**Le gestionnaire de webhooks** — `src/webhook/`. Le code de réponse y est une
**instruction**, pas un compte rendu : `200` dit « n'y revenez pas », `500` dit
« réessayez », `401` dit « ce n'est pas vous ». Rendre 200 sur une panne perd
le paiement pour de bon ; rendre 500 sur un événement qu'on ignore fait rejouer
trois jours durant, puis fait désactiver le point de terminaison.

**L'API du tableau de bord** — `src/api/`. En lecture seule **par
construction** : le port `Tableau` n'a aucun verbe qui écrit, et le routeur
refuse tout ce qui n'est pas `GET`. Le détour par une API existe pour rendre
une manipulation depuis le tableau de bord impossible plutôt qu'interdite — une
application cliente est distribuée, son jeton est extractible, et tout ce
qu'elle peut faire, quiconque tient ce jeton peut le faire.

La contrainte qui donne sa forme à la couche : **on ne peut pas demander
« combien de suspendus »**. Il n'y a pas de colonne `etat` — l'état se déduit.
Une requête filtre donc sur des dates, et `bornesDe(etat, maintenant)` traduit.
Un test confronte la traduction à `etatDe`, état par état.

**`portsPrisma` rend `dossier` et `tableau`** en plus des trois ports du cœur.
Un hôte du niveau 2 n'écrit toujours aucune requête.

### Corrigé

**Deux abonnés ne peuvent plus partager la même référence de versement.**
`referenceDeVersement(echeance, versements)` rendait `2026-02-09#1` : elle ne
dépendait que de l'échéance. Sur de la facturation mensuelle les échéances se
concentrent, donc deux abonnés recevaient la même clé — et la référence est la
clé d'idempotence chez le fournisseur. Paystack refuse une référence déjà vue,
donc le second à payer ce jour-là était rejeté ; pire, `constater(reference)`
interroge le fournisseur **par** cette clé, et aurait rendu la transaction de
quelqu'un d'autre.

Second défaut de la même ligne : le `#` ne figure pas dans le jeu de caractères
qu'accepte une référence Paystack. La forme devient `20260209-1-ab-1`, et
`reconcilier` refuse désormais une référence fabriquée pour un autre
abonnement.

### Déplacé

**`echapper` vit dans `src/html.ts`**, avant que la page n'en fasse un second
exemplaire — celui qui oublie l'apostrophe.

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
