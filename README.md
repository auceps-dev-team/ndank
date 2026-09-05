# Ndank

**Abonnements par mobile money, sans carte bancaire.**

*Ndank ndank mooy japp golo ci ñaay* — petit à petit, on attrape le singe.

```
npm install ndank
```

Aucune dépendance de production. Node 18 ou plus, ESM et CommonJS, types
inclus. Le schéma du niveau 2 voyage avec le paquet.

---

## Le problème

Le mobile money ne sait pas prélever.

Les réseaux de cartes ont des jetons : un marchand débite une carte enregistrée
quand il veut. Orange Money, Wave et MTN ne permettent pas cela — chaque débit
exige que l'abonné valide sur son téléphone, et il n'existe pas de mandat de
prélèvement généralisé en zone franc CFA.

La conséquence est structurante et beaucoup de gens la découvrent trop tard :
**on ne peut pas transposer un abonnement à carte sur du mobile money.** Il faut
un autre mécanisme.

## Ce que fait Ndank

Il rappelle, et l'abonné valide.

```
                     échéance                 accès coupé
                         │                         │
  ───────┬───────────┬───┼──────┬─────────┬────────┼──────►
        J-7         J-1  J0    J+2       J+5      J+7
         │           │          │         │        │
      courriel    courriel     push      SMS   suspension
      + push      + push       + SMS
```

Une semaine avant, puis la veille : assez tôt pour s'organiser, assez tard pour
ne pas être oublié. `PREAVIS_JOURS` est **dérivé** du premier palier — écrit en
dur, un palier plus avancé que lui serait noté dans le code et jamais envoyé,
sans la moindre erreur pour le dire.

Entre l'échéance et la coupure vit la **grâce** : l'abonné garde son accès
pendant qu'on le relance. Sans elle, quelqu'un parti en week-end perd son
service pour un retard de deux jours — et ne se réabonne pas.

## Trois décisions qui portent tout

**Deux horloges, pas une.** L'échéance dit quand le paiement est dû ; l'accès dit
jusqu'à quand le service tient. Les confondre rend un système d'abonnement
insupportable : soit on coupe trop tôt, soit on offre le service.

**Le cycle s'enchaîne sur l'échéance, pas sur le paiement.** Sinon un abonné qui
paie trois jours en retard chaque mois voit son échéance glisser — et paie onze
mois au lieu de douze sans que personne ne le voie.

**On monte en coût.** Un SMS se paie à chaque envoi. L'échelle commence par le
gratuit et ne sort le SMS qu'au moment où il décide de quelque chose. Sur mille
abonnés mensuels, la règle inverse coûterait mille SMS par mois pour des gens
qui auraient payé de toute façon.

C'est aussi pourquoi `Coordonnees.appareils` est une **liste** et non un jeton :
une adresse de courriel est unique, un numéro aussi, mais quelqu'un installe
l'application sur son téléphone ET sur son ordinateur. Ce sont des poignées
opaques — Ndank ne les interprète jamais. Un abonnement push réel porte des
clés de chiffrement, et elles n'ont aucune raison de traverser un module qui ne
décide que de qui relancer.

## Trois garde-fous

**Un passage qui a raté trois jours n'envoie qu'une relance**, la plus avancée.
Rattraper avec trois messages d'affilée fait désinstaller l'application.

**Une relance jamais partie n'est pas notée.** Sinon une panne d'un jour coupe
l'accès de quelqu'un qu'on n'a jamais prévenu, et le lendemain le moteur croit
l'avoir fait.

**Un abonnement qui échoue n'emporte pas le lot.** Chaque abonnement est
rattrapé séparément et noté dans `bilan.echecs` avec sa cause. Sans cela, une
ligne corrompue ou une passerelle en délai d'attente arrête le passage entier —
ni relance ni suspension pour tous ceux qui suivent, et comme l'état se déduit
des dates, ils reçoivent le lendemain le palier le plus avancé : pour certains,
un SMS payant à la place du courriel gratuit de la veille.

Le passage mène ses **lectures** par grappes bornées, mais garde ses **envois**
strictement en série : une passerelle SMS limitée en débit refuserait une
rafale, et ce refus deviendrait une relance qui ne part pas.

## Trois façons de l'utiliser

| | Pour qui | Ce qu'il faut faire |
|---|---|---|
| **Ports** | Autonomie complète | Implémenter `Lecture`, `Ecriture`, `Envoi` contre votre base |
| **Schéma fourni** | Intégration rapide | Prendre les tables Prisma livrées, et nommer ses passerelles |
| **Service hébergé** | Sans code | Appeler l'API *(à venir)* |

Les trois partagent le même cœur : les niveaux 2 et 3 ne sont que des
implémentations des mêmes ports. C'est pour cela qu'ils n'en dupliqueront pas
une ligne.

### Niveau 1 en pratique

```ts
import { passer } from "ndank";
import { lienDe } from "ndank/page/lien";

const ports = { lecture, ecriture, envoi };   // vos implémentations

const bilan = await passer(ports, {
  lien: (a) => lienDe("https://p.exemple.ci/v", process.env.NDANK_SECRET, a.id),
  montant: (a) => `${a.montant} ${a.devise}`,
});

bilan.echecs;   // ce qui n'a pas pu être traité, et pourquoi
bilan.lotPlein; // vrai s'il restait probablement du travail
```

Ce README montrait ici `https://exemple.com/abonnement/${a.id}/renouveler`, et
il avait tort : un lien qui porte l'identifiant en clair se laisse énumérer par
quiconque en reçoit un. Voir [Le lien de relance](#le-lien-de-relance).

Puis un passage par jour. Il peut rater son tour : l'état se **déduit** des
dates, il n'est jamais stocké — un jour sauté ne laisse rien de faux derrière
lui.

Une seule exigence sur `Lecture.aRelancer` : **ne pas rendre ce qui est déjà
clos.** Le moteur ne peut pas le savoir, donc il redit `clore` tant qu'il le
voit ; sur une base qui vieillit, les morts finissent par occuper le lot — qui
est plafonné — et par évincer les vivants.

Quand un paiement est confirmé, l'hôte enchaîne le cycle :

```ts
import { finaliserRenouvellement } from "ndank";

const suivant = await finaliserRenouvellement(ports, abonnement, new Date());
```

Le cycle repart de l'**échéance** et non de la date de paiement — sauf si
l'accès était déjà perdu, auquel cas facturer une période écoulée n'aurait
aucun sens. Aucune notification ne part d'ici : le moteur ne parle qu'au moment
de relancer, et un hôte qui veut confirmer un paiement le fait chez lui.

### Niveau 2 : le schéma fourni

Les tables sont dans [`prisma/schema.prisma`](prisma/schema.prisma) — neuf
modèles, validés par `prisma validate`. Il voyage **avec le paquet** : le
README l'annonçait depuis la 0.4.0 et `files` ne le contenait pas, si bien qu'un
hôte qui installait Ndank ne le trouvait nulle part.

Le schéma se copie dans votre projet et se migre avec votre propre historique ;
Ndank ne livre pas de migrations, qui entreraient en conflit avec les vôtres.

**Recopiez ses modèles à la suite de votre `schema.prisma`** — un second
fichier `.prisma` demanderait la préversion `prismaSchemaFolder`, que Prisma 6
n'active pas par défaut. La consigne précédente disait le contraire et ne
fonctionnait pas ; corrigé en 0.13.2, après une installation réelle dans
Baobart.

```sh
# les dix modèles à ajouter à la suite des vôtres
cat node_modules/ndank/prisma/schema.prisma

cp .env.example .env      # puis remplir DATABASE_URL et vos clés
npx prisma migrate dev --name ndank
```

Les tables sont mappées en minuscules françaises — `abonne`, `abonnement`,
`relance`, `versement`… — et cohabitent donc avec les vôtres sans les heurter.
Le seul point de rencontre observé est l'enum `Cadence` : si vous en avez déjà
un aux mêmes valeurs, partagez-le plutôt que d'en créer un second.

Puis les ports sont déjà écrits — c'est tout ce que le niveau 2 vous épargne :

```ts
import { PrismaClient } from "@prisma/client";
import { portsPrisma } from "ndank/prisma";
import { passer } from "ndank";

const { lecture, ecriture, creances } = portsPrisma(new PrismaClient(), {
  projetId: "prj-...",
});

await passer({ lecture, ecriture, envoi }, { lien, montant });
```

`envoi` se compose à partir de vos clés — voir [Envoyer les
relances](#envoyer-les-relances). Il n'y a plus rien à écrire.

Ndank ne dépend pas de `@prisma/client` — il décrit la forme dont il a besoin,
et votre client la satisfait. `dependencies` reste vide, et un hôte qui reste au
niveau 1 n'installe rien.

Quatre décisions y sont encodées, et méritent d'être connues avant de les
modifier :

**Il n'y a pas de colonne `etat`.** ACTIVE, A_RENOUVELER, SUSPENDUE et EXPIREE
se déduisent des dates, jamais ne se stockent. La base garde les faits — payé,
relancé, résilié, clos — pas les conclusions.

**Aucune clé d'API en base.** Une base est sauvegardée, répliquée, restaurée sur
un poste de développement. Les identifiants viennent de l'environnement.

**Le prix est recopié dans l'abonnement.** Sinon augmenter un tarif changerait
rétroactivement ce que doivent tous les abonnés en cours, y compris sur un cycle
déjà à moitié payé.

**Deux contraintes d'unicité portent l'idempotence** : `(abonnementId, cle)` sur
les relances, `(fournisseur, identifiantFournisseur)` sur les versements. C'est
cette dernière qui empêche un webhook rejoué soixante-douze heures durant
d'avancer trois fois la même échéance.

L'argent est en `Int`, en unités mineures — jamais `Float`, jamais `Decimal`.

## Dire ce qu'on vend

```ts
import { grille } from "ndank/offre";

export const GRILLE = grille([
  { id: "createur", libelle: "Pass Créateur", montant: 2000,
    devise: "XOF", cadence: "MENSUEL" },
  { id: "pro", libelle: "Pass Pro", montant: 20000,
    devise: "XOF", cadence: "ANNUEL" },
]);
```

`grille()` rend un **tableau** d'offres, et non un objet à interroger : une
offre se retrouve avec `offreDe(GRILLE, id)`.

Elle lève **au démarrage** et rend *tous* les défauts d'un coup — corriger
une grille en cinq redémarrages successifs est une façon de perdre un quart
d'heure. L'hôte qui la tient en base lit ses lignes et les passe à la même
fonction ; `portsPrisma(...).offres()` le fait pour lui.

**Les montants sont en unités mineures de l'ISO 4217.** Le franc CFA n'a pas de
subdivision : deux mille francs s'écrivent `2000`. Le cedi et le naira en ont
deux : vingt cedis s'écrivent `2000` aussi.

⚠️ **Ce n'est pas ce que les fournisseurs attendent, et Ndank convertit pour
vous.** Paystack compte en centièmes quelle que soit la devise — pour lui, deux
mille francs valent `200000`. Ce README affirmait le contraire jusqu'à la
0.9.0, et le bac à sable l'a démenti : un abonnement à 2 000 F était prélevé
vingt francs. La table vit dans [`src/devise.ts`](src/devise.ts), la conversion
dans chaque adaptateur.

L'erreur qu'il reste à éviter, et qu'aucune vérification n'attrapera :
transposer un tarif d'un système à carte, où l'on écrivait des centimes, et
multiplier par cent par réflexe. `200000` est un montant valide, et il
facturerait deux cent mille francs.

**La devise n'est pas un choix libre.** Un compte marchand n'active que les
devises de son marché : sur un compte XOF, Paystack refuse `NGN`, `GHS`, `KES`,
`ZAR` et `USD`. Écrire `GHS` dans sa grille avec un compte sénégalais ne produit
pas une conversion, mais un refus — au premier abonné qui clique.

Ce qui est attrapé, en revanche : un montant non entier, un montant nul, deux
offres au même identifiant, une cadence inconnue — et **« CFA »**, qui passe
pourtant la règle de forme. Trois lettres majuscules, mais pas un code ISO 4217 :
c'est `XOF` ou `XAF`, et c'est l'erreur la plus probable dans cette zone.

### Une offre ne se supprime pas

`actif: false` la retire du catalogue sans rien casser : des abonnements en cours
la référencent, et leur libellé comme leur montant en dépendent. `offresActives()`
rend ce qu'on propose aujourd'hui, `offreDe()` retrouve n'importe laquelle.

## Faire naître un abonnement

```ts
import { souscrire } from "ndank/souscription";

const { abonnement, cree } = await souscrire(souscriptions, {
  offre: offreDe(GRILLE, "createur"),
  abonne: { reference: "usr-42", nom, courriel, telephone, appareils: [] },
  paiement: issue.regleLe ?? new Date(),
});
```

**On ne souscrit qu'après un paiement constaté**, et ce refus est délibéré. Un
abonnement « en attente de premier paiement » ne peut pas s'exprimer dans le
modèle de cycle : un cycle *commence* à un paiement. Inventer un cycle de durée
nulle produirait l'une de deux choses, toutes deux fausses — un accès ouvert à
qui n'a rien payé, ou un abonné relancé chaque jour pour un abonnement qu'il n'a
jamais pris.

L'ordre est donc : montrer la grille, inviter à payer, **puis** souscrire.

```ts
import { referenceDeSouscription } from "ndank/souscription";

// Ce premier paiement n'a pas encore d'abonnement : sa référence n'en porte pas.
const reference = referenceDeSouscription(offre.id, "usr-42", String(essai));
await encaissement.inviter({ reference, montant: offre.montant, ... });
```

Cette référence-là est **délibérément instable**, contrairement à celle d'un
versement : quelqu'un qui abandonne son paiement puis recommence doit obtenir une
*nouvelle* demande, sinon le fournisseur reconnaît l'ancienne et le second essai
n'a jamais lieu.

Ce qui protège du double paiement n'est donc pas la référence, mais
`Souscriptions.enCours` : `cree` vaut `false` et l'abonnement existant est rendu.
C'est le cas normal du double-clic, ou de l'abonné qui repaie parce qu'il n'a pas
vu la confirmation — pas une erreur.

## Envoyer les relances

`Envoi` était le dernier port à écrire. Il ne l'est plus : Ndank rédige les
trois formes du message et livre quatre passerelles.

```ts
import { envoiCompose } from "ndank/envoi";
import { transporteurCourriel, transporteurSms } from "ndank/envoi/registre";

const envoi = envoiCompose({
  courriel: transporteurCourriel("resend", {
    cleApi: process.env.RESEND_CLE_API,
    expediteur: "Baobart <no-reply@baobart.ci>",
  }),
  sms: transporteurSms("twilio", {
    sid: process.env.TWILIO_SID,
    jeton: process.env.TWILIO_JETON,
    expediteur: process.env.TWILIO_EXPEDITEUR,
    indicatifParDefaut: "225",
  }),
});
```

Rien n'est branché sur le push : `disponible("push", …)` rendra `false`, le
moteur passera au canal suivant du palier, et rien ne cassera. C'est ce qui
permet de démarrer avec un seul canal.

| Canal | Livrées | Fondations |
|---|---|---|
| Courriel | `resend`, `brevo` | — |
| SMS | `twilio` | `orange-sms`, `africastalking` |
| Notification | `expo` | `fcm`, `webpush` |

### Vérifier au démarrage, pas au troisième jour

```ts
import { verifierEnvoi } from "ndank/envoi/registre";

const problemes = verifierEnvoi({
  courriel: { passerelle: "resend", identifiants: process.env },
  sms: { passerelle: "twilio", identifiants: process.env },
});

if (problemes.length > 0) throw new Error(problemes.join("\n"));
```

Cette vérification compte plus que celle des paiements, et la différence tient
à la façon dont les deux pannes se manifestent.

Une clé de paiement absente se découvre au premier abonné qui clique. Il
réessaie, il écrit au support, on répare dans l'heure.

**Une clé d'envoi absente ne se découvre pas.** Le passage tourne, l'erreur de
la passerelle est rattrapée, le bilan compte un `injoignable` de plus — et ce
chiffre n'a aucune raison d'alerter quelqu'un un mardi matin. La panne se
manifeste au troisième jour, quand l'accès tombe pour un abonné qui n'a rien
reçu, et qui n'a aucun moyen de savoir ce qui s'est passé.

### Un passage à blanc avant le premier vrai

```ts
import { envoiMuet } from "ndank/envoi";

const { envoi, retenus } = envoiMuet();
await passer({ lecture, ecriture, envoi }, { lien, montant });

retenus;   // tout ce qui serait parti : à qui, sur quel canal, avec quel texte
```

Il **rédige vraiment** — c'est tout l'intérêt. Un faux qui se contenterait de
compter ne dirait rien du contenu, et c'est le contenu qui surprend : un libellé
d'offre un peu long fait déborder le SMS, et on préfère le découvrir là.

### Ce que la rédaction garantit

**Le lien ne se coupe jamais.** Un SMS trop long coûte un segment de plus ; un
lien tronqué ne mène nulle part, donc la relance la plus chère de l'échelle —
celle qu'on n'envoie qu'au moment où l'accès va tomber — ne sert plus à rien.
C'est le nom de l'offre qui cède : l'abonné sait à quoi il est abonné, il ne
sait pas qu'on va lui couper l'accès.

**Un SMS tient en un segment**, mesuré après le repli GSM-7 et non avant — « œ »
devient « oe », et mesurer avant ferait tenir sur le papier un message qui
déborde sur la facture.

**On dit que le message a pu croiser un paiement.** Le webhook d'un opérateur
arrive quand il arrive ; le passage part à heure fixe. Sans cette phrase,
l'abonné qui a réglé la veille au soir conclut qu'on ne l'a pas vu, et il
repaie.

**On ne salue personne par le nom de son offre.** Quand `Coordonnees.nom` est
`null`, le courriel dit « Bonjour, » — et le SMS ne salue pas du tout, parce que
chaque septet compte.

### Écrire sa propre passerelle

`Transporteur` fait trois champs et une méthode. Un agrégateur SMS local — qui
facture souvent l'unité moins cher qu'un envoi international, et négocie un
identifiant d'expéditeur alphanumérique — se branche en une trentaine de lignes :

```ts
const monAgregateur: TransporteurSms = {
  nom: "mon-agregateur",
  canal: "sms",
  async envoyer(ou, contenu) {
    const r = await fetch("https://…", {
      method: "POST",
      body: JSON.stringify({ to: ou.telephone, text: contenu.texte }),
    });
    return { parti: r.ok, reference: null };
  },
};
```

Le reste ne bouge pas : les paliers, les clés de relance, le repli GSM-7, le
budget de segments. Et pour écrire dans une autre langue, on ne fournit pas un
gabarit — on fournit un `Redacteur` à `envoiCompose`, et l'on garde tout le
reste.

## Encaisser sans encaisser

Ndank sait demander un paiement, et constater qu'il a eu lieu. **L'argent ne
passe jamais par lui** : il va du portefeuille de l'abonné au compte marchand de
l'hôte, chez le fournisseur que l'hôte a choisi.

```ts
import { fournisseur } from "ndank/encaissement/registre";

const encaissement = fournisseur("flutterwave", {
  cleSecrete: process.env.FLW_CLE,
  secretWebhook: process.env.FLW_WEBHOOK,
});
```

Trois adaptateurs sont branchés — **Flutterwave**, **Paystack** et **MTN MoMo**.
Quatre autres ont leurs bases posées : **Orange**, **Wave**, **Moov** et
**Djamo**. Ils déclarent déjà les champs qu'ils attendront, pour qu'un hôte
puisse ouvrir ses comptes marchands avant que l'adaptateur n'existe — c'est la
partie longue. En attendant, ils lèvent un message qui dit quoi faire.

Une configuration incomplète échoue au démarrage, pas en production :

```ts
import { champsManquants } from "ndank/encaissement/registre";

champsManquants("mtn", process.env); // ["cleAbonnement"] — et on refuse de démarrer
```

Sans cela, une clé absente part dans un en-tête vide, le fournisseur répond 401,
et le message parle d'autorisation — jamais de la ligne manquante.

### Les cinq temps, et les deux qui nous appartiennent

Flutterwave, Paystack, MTN et Orange n'ont ni le même vocabulaire ni les mêmes
verbes. Ils ont la même chorégraphie : s'authentifier, initier avec une clé
d'idempotence, laisser l'abonné autoriser sur son téléphone, recevoir le
résultat plus tard, re-vérifier avant de donner la valeur.

Le premier temps est à l'adaptateur, le troisième à l'abonné, le quatrième
arrive quand il arrive. Restent le deuxième et le cinquième — `inviter` et
`constater`. C'est tout le port.

La clé de cycle sert de référence, donc de clé d'idempotence : rejouer un
passage ne crée pas une seconde demande de paiement.

## Payer en plusieurs fois

Une part importante des abonnés vit de revenus irréguliers. Exiger deux mille
francs d'un coup, c'est perdre celui qui en a mille deux cents aujourd'hui et
huit cents jeudi — alors qu'il veut payer. Le mobile money rend d'ailleurs la
chose naturelle : chaque paiement est un geste séparé, autorisé séparément.

Deux règles, à égalité, et c'est l'abonné qui choisit :

| Versé sur 2 000 F | `CREDIT` | `PRORATA` |
|---|---|---|
| 2 000 | +30 jours | +30 jours |
| 4 000 | +60 jours | +60 jours |
| 1 200 | rien — il manque 800 | **+18 jours** |
| 1 200 puis 800 | +30 jours | +18 puis +12 |

**Crédit** convient à un service qu'on ne peut pas couper à moitié. **Prorata**
à un abonné qui préfère savoir que son argent a servi. Les deux s'accordent
toujours sur le double paiement.

Le calcul est cumulé, jamais incrémental : on garde le total versé et les jours
déjà accordés, et l'arrondi n'a lieu qu'une fois. Arrondir à chaque versement
ferait perdre moins d'un franc à chaque fois — et un jour entier au bout de
trente.

`resteADevoir` existe pour la relance : redemander la somme entière à quelqu'un
qui a déjà versé la moitié lui fait croire que son premier versement s'est perdu.

## Le lien de relance

Ndank fabrique le lien qui part dans la relance. Ce n'est pas un détail de
confort.

```ts
import { lienDe } from "ndank/page/lien";

const reglages = {
  lien: (a) => lienDe("https://p.baobart.ci/v", process.env.NDANK_SECRET, a.id),
  montant: (a) => `${a.montant} ${a.devise}`,
};
```

**Un lien qui porte l'identifiant en clair est énumérable.** `/valider/ab-1` —
ce que ce README montrait jusqu'à la 0.7.0 — laisse quiconque en reçoit un
changer un chiffre pour lire la page d'un autre : son offre, son montant, son
retard. Il n'y a rien à deviner, il suffit de compter. Et sans signature, on
peut aussi fabriquer un lien vers un abonnement qui n'a rien demandé.

Le jeton **expire** — quinze jours, un peu plus que toute l'échelle des
relances. Un lien de relance survit longtemps à son message : il est transféré,
capturé en image, gardé dans un fil de discussion.

Deux choses que le SMS impose, et qui expliquent sa forme :

- **son alphabet est celui de base64url**, dont les soixante-quatre caractères
  sont tous dans l'alphabet GSM 03.38. Le lien ne fait donc pas basculer la
  relance en UCS-2, où le segment tombe de 160 à 70 caractères ;
- **son sceau est tronqué à douze octets**, soit seize caractères au lieu des
  quarante-trois d'un HMAC-SHA256 complet. Vingt-sept caractères rendus au nom
  de l'offre, sur chaque relance.

## La page de validation

Ndank héberge la page où l'abonné règle. C'est un choix : un hôte qui branche
deux fournisseurs a sinon deux expériences, et l'abonné, qui ne sait pas ce
qu'est un agrégateur, voit un site inconnu lui demander de l'argent. C'est
aussi le seul endroit où l'on puisse mesurer combien de gens ouvrent la page
sans aller au bout.

```ts
import { routeurPage } from "ndank/page";
import { versFetch } from "ndank/page/montage";

const routeur = routeurPage({
  base: "https://p.baobart.ci/v",
  secret: process.env.NDANK_SECRET,
  marque: "Baobart",
  dossier,                       // portsPrisma le fournit
  creances,
  fournisseurs: [
    { nom: "paystack", libelle: "Mobile money", encaissement: paystack },
  ],
  montant: (m, d) => `${m.toLocaleString("fr-FR")} ${d}`,
  surIssue: async (issue, abonnement) => { /* votre transaction */ },
});

// Next, Hono, Bun, Deno, Node ≥ 18
export const GET = versFetch(routeur, "/v");
export const POST = versFetch(routeur, "/v");
```

Trois routes : ce qu'on doit et par quoi payer, le choix, puis le constat.
**Aucune ressource extérieure, aucune ligne de JavaScript** — elle s'ouvre
depuis un SMS, sur un téléphone d'entrée de gamme, en 3G, et c'est le dernier
écran avant qu'un abonné ne perde son accès.

### Ce qu'elle refuse de faire

**Elle ne montre pas de bouton à un abonnement à jour.** Le lien vient d'une
relance ; s'il mène à un abonnement à jour, c'est presque toujours que l'abonné
vient de payer et que la relance a croisé son règlement — ce dont le courriel
l'avertissait. Lui présenter quand même un bouton, c'est lui faire payer deux
fois. Et Ndank ne rembourse pas : il n'a jamais touché l'argent, donc il ne
peut pas le rendre.

**Elle ne constate pas une référence qui n'est pas la sienne.** Sans ce
garde-fou, il suffirait de changer `ref` dans l'URL pour faire constater le
paiement de quelqu'un d'autre sur son propre abonnement.

**Elle ne laisse pas fuir le jeton.** `Referrer-Policy: no-referrer` : sans lui,
le navigateur enverrait l'URL au fournisseur dans l'en-tête `Referer` au moment
de la redirection, et le jeton finirait dans les journaux d'accès d'un tiers.

**Elle ne répète pas ce que le fournisseur a dit.** Un message d'erreur peut
porter un identifiant de compte ou une partie de clé. Il va dans votre journal.

### Elle n'écrit rien

`surIssue` est appelée quand un paiement est constaté ; c'est vous qui ouvrez
la transaction. Faire avancer une échéance et noter le versement qui l'a payée
doivent tomber ou réussir **ensemble**, et seul l'hôte connaît sa base.

## Les webhooks

```ts
import { gestionnaireWebhook } from "ndank/webhook";

const recevoir = gestionnaireWebhook({
  fournisseurs: { paystack, flutterwave },
  dossier,
  surIssue,     // le même que celui de la page
});

export const POST = versFetch(recevoir, "/webhooks");
```

**Le code de réponse est une instruction, pas un compte rendu.** Les
fournisseurs rejouent — Paystack pendant soixante-douze heures, Flutterwave
trois fois — et c'est le code rendu qui déclenche le rejeu :

| Code | Ce qu'il dit | Quand |
|---|---|---|
| `200` | « c'est réglé, n'y revenez pas » | paiement traité, ou événement sans objet |
| `500` | « réessayez » | panne de notre côté : la base, le crochet |
| `401` | « ce n'est pas vous » | signature invalide |

Rendre 200 sur une panne **perd le paiement pour de bon**. Rendre 500 sur un
événement qu'on ignore fait rejouer trois jours, puis fait désactiver le point
de terminaison.

⚠️ **Le corps doit arriver brut.** La signature porte sur les octets envoyés :
`JSON.parse` puis `JSON.stringify` rend un texte différent, et la signature ne
correspond plus. Avec Express, `express.raw({ type: "*/*" })` sur cette route,
et surtout **pas** `express.json()`.

### L'interrogation n'est pas un repli du webhook

Les deux chemins doivent pouvoir conclure. Un webhook se perd — le service
redémarre, un pare-feu bloque, l'hôte répond 500 une fois de trop. Les rappels
de MTN ne sont même pas signés. Flutterwave écrit d'ailleurs l'inverse dans sa
documentation : re-vérifier avant de donner la valeur.

C'est `Creances.dejaCompte` qui rend inoffensif le fait que les deux
concluent — d'où l'exigence que `surIssue` soit idempotente.

## L'API du tableau de bord

```ts
import { routeurApi } from "ndank/api";

const api = routeurApi({ tableau, jeton: process.env.NDANK_JETON_TABLEAU });

export const GET = versFetch(api, "/api/ndank");
```

| Route | Ce qu'elle rend |
|---|---|
| `GET /sante` | si le moteur tourne encore, et quoi faire sinon |
| `GET /resume` | les comptes par état, ce qui a vraiment accès, et le taux de réussite des paiements sur trente jours |
| `GET /offres` | la grille tarifaire — `?toutes=1` inclut les offres retirées |
| `GET /abonnements?etat=…` | une page, les plus urgents d'abord, avec les coordonnées de l'abonné |
| `GET /abonnements/<id>` | un abonnement |
| `GET /abonnements/<id>/versements` | ses paiements, du plus récent au plus ancien |

Les deux dernières routes et `/offres` répondent **501** quand l'hôte ne les a
pas branchées : elles existent, il ne les sert pas. Un 404 ferait chercher une
faute de frappe dans l'URL.

Chaque versement porte `regleNonCompte` : un paiement réglé chez le fournisseur
mais jamais compté par Ndank est un paiement qui n'a **pas** prolongé
l'abonnement. C'est exactement ce qu'on cherche quand un abonné dit avoir payé.

Les coordonnées de l'abonné voyagent avec la liste. On aurait pu les réserver au
détail, mais ce serait un réconfort et non une protection : le jeton donne accès
aux deux routes, donc qui peut lire le détail peut le lire cent fois. Et un
tableau de bord qui n'affiche que des identifiants est inutilisable — on relance
quelqu'un, pas un `cuid`.

**Elle ne sait que lire, par construction.** Le port `Tableau` n'a aucun verbe
qui écrit, et le routeur refuse tout ce qui n'est pas `GET`. Le détour par une
API existe pour cela : une application cliente est distribuée, son code est
lisible, son jeton est extractible — et tout ce qu'elle peut faire, quiconque
tient ce jeton peut le faire. Si elle parlait à la base, « lecture seule »
reposerait sur des droits qu'on aurait pensé à restreindre, et qu'on aurait un
jour élargis « juste pour un bouton ».

Le jeton est obligatoire : `routeurApi` refuse de se construire sans. Chaque
ligne dit ce que telle personne doit et depuis combien de temps elle est en
retard.

### On ne peut pas demander « combien de suspendus »

Il n'y a pas de colonne `etat` — l'état se **déduit**, c'est la première
décision du cœur. Une requête filtre donc sur des dates, et
`bornesDe(etat, maintenant)` traduit — depuis `ndank/api/tableau`, et non
`ndank/api` qui porte le routeur. La traduction vit dans Ndank et non dans
chaque implémentation du port : deux traductions du même état finiraient par
diverger, et le tableau de bord annoncerait un chiffre que le moteur ne
reconnaîtrait pas.

Cela ne marche que parce que les dates stockées sont au **minuit civil UTC**,
ce que `jour()` garantit à l'écriture. C'est la seule hypothèse que cette
couche fait sur votre base.

## Savoir que le moteur tourne encore

Un seul changement dans votre tâche quotidienne :

```ts
import { passerEtTracer } from "ndank/battement";

// au lieu de : await passer(ports, redaction)
await passerEtTracer(ports, redaction, battements);
```

Puis, dans le tableau de bord :

```
GET /sante
{
  "va": "MUET",
  "titre": "Aucun passage depuis 51.3 h.",
  "quoiFaire": "La tâche quotidienne ne tourne plus. Vérifiez la
                planification : pendant ce temps, plus une relance ne part
                et plus un accès n'est coupé."
}
```

### Pourquoi cela existe

Tout le reste de Ndank s'occupe de ce qui peut mal se passer **pendant** un
passage. Chacun est rattrapé, compté, journalisé.

La panne la plus coûteuse n'est pas là. C'est le passage quotidien qui **ne
tourne plus du tout** — le cron meurt, le conteneur ne redémarre pas, un
déploiement casse la planification.

Alors il n'y a aucun échec à journaliser. Il y a du **silence**, et le silence
ressemble exactement à « tout va bien ». Le tableau de bord continue d'afficher
des chiffres justes — l'état se déduit des dates, donc il ne ment pas — mais
plus personne n'agit dessus. On s'en aperçoit quand un abonné appelle pour dire
qu'il n'a jamais été prévenu, trois semaines plus tard.

D'où le renversement : **on enregistre chaque passage, y compris ceux où tout
s'est bien passé.** Un journal d'incidents ne le fait jamais — il n'a rien à
dire d'un jour sans incident — et c'est précisément pour cela que cette panne
lui échappe partout.

### Les cinq états

| | Ce que ça veut dire |
|---|---|
| `BIEN` | le moteur tourne — *« rien à faire »*, dit explicitement |
| `JAMAIS` | aucun passage n'a jamais tourné : la tâche n'est pas planifiée |
| `MUET` | plus de passage depuis trop longtemps : la planification est morte |
| `BLOQUE` | un passage a démarré et n'a jamais fini — le processus est bloqué |
| `TOMBE` | le dernier passage est tombé en entier, avec sa cause |

`JAMAIS` et `MUET` ne sont pas la même conversation, et `BLOQUE` non plus : un
passage interrompu laisse peut-être la base à moitié écrite, ce qu'une
planification morte ne fait pas. Les confondre ferait chercher au mauvais
endroit.

### Deux seuils, et pourquoi ces valeurs

**26 heures** avant de crier `MUET`. Un cron quotidien dérive : 6 h 00 un jour,
6 h 05 le lendemain, et l'écart dépasse déjà vingt-quatre heures. Un seuil à
vingt-quatre alerterait sur cette dérive normale chaque semaine, jusqu'à ce que
plus personne ne regarde. Deux heures de marge l'absorbent sans cacher un jour
manqué, qui en donne quarante-huit.

**2 heures** avant de dire `BLOQUE`. Un passage sur cinq cents abonnements prend
des secondes ; deux heures est plusieurs ordres de grandeur au-dessus.

Les deux se resserrent : `routeurApi({ sante: { retardTolereHeures: 12 } })`.

### La seule exception à la règle des jours civils

Partout ailleurs, Ndank compare des **jours civils** — c'est ce qui empêche
l'heure du cron de décider d'une coupure d'accès.

Ici, non : on mesure **le cron lui-même**. Un passage qui remonte à vingt-cinq
heures va bien, un à cinquante ne va pas, et les deux peuvent tomber sur
« hier » en jours civils. C'est le seul endroit du dépôt où les heures sont la
bonne unité, et l'inverser serait une faute.

### Garder la trace de ce qui se passe

Cinq couches exposent un `journal?` facultatif. `journalPrisma` les remplit, et
écrit enfin dans `WebhookRecu` — une table du schéma que rien n'avait jamais
touchée.

```ts
import { journalPrisma } from "ndank/prisma/journal";

const journal = journalPrisma(prisma, {
  projetId: "prj-...",
  surErreur: (cause) => console.error("journal Ndank :", cause),
});

const envoi   = envoiCompose({ courriel, sms }, { journal: journal.envoi });
const page    = routeurPage({ ...reglages, journal: journal.page });
const webhook = gestionnaireWebhook({ ...reglages, journal: journal.webhook });
const api     = routeurApi({ ...reglages, journal: journal.api });

// Après un passage, ou après avoir répondu à une requête.
await journal.vider();
```

**Ce qu'il garde, et surtout ce qu'il jette.** Un journal qui se remplit de
bruit cesse d'être lu :

| Crochet | Conservé |
|---|---|
| envoi | les **échecs** — les relances parties sont déjà dans `Relance`, avec leurs canaux |
| page | **tout**, ouvertures comprises : c'est le seul endroit qui dise combien de gens ouvrent sans aller au bout |
| webhooks | **tout**, plus le corps brut dans `WebhookRecu` |
| API | les **non-2xx** — un tableau de bord qui interroge toutes les 30 s produit 2 800 lectures par jour |
| gestes | les **refus** — les gestes posés sont déjà dans `Evenement`, avec leur auteur |

Une exception à « on jette les réussites » : un envoi **réussi qui rapporte des
jetons d'appareil morts** est conservé. Expo répond `200` avec un refus par
appareil — la notification part vers un téléphone et est refusée par l'autre,
dont l'application a été désinstallée. `Relance` note l'envoi, pas ce jeton-là ;
et c'est lui qui fait qu'un abonné *semble* joignable en push alors qu'il ne
l'est plus.

**Il tamponne.** Les crochets sont synchrones à dessein — celui de l'envoi est
appelé dans la boucle du passage quotidien, où une écriture lente ralentirait
tout le lot. On ne peut donc pas attendre, et écrire sans attendre serait une
rafale de cinq cents insertions. Le journal accumule, écrit par lots, et se vide
tout seul quand le lot déborde pour que la mémoire reste bornée.

`vider()` ne lève jamais : un journal qui fait tomber ce qu'il observe ne sert à
rien. `surErreur` existe pour que son propre échec se voie quand même — sans
lui, une base qui refuse les écritures le rendrait silencieusement inutile,
c'est-à-dire exactement la panne qu'il existe pour révéler ailleurs.

## Les gestes du tableau de bord

Cinq verbes, sur une adresse et un jeton **distincts** de ceux de l'API de
lecture.

```ts
import { routeurGestes } from "ndank/api/gestes";

const gestes = routeurGestes({
  ports: { dossier, interventions, lecture, ecriture, envoi, creances },
  jeton: process.env.NDANK_JETON_GESTES,   // PAS celui du tableau de bord
  redaction: { lien, montant },
});

export const POST = versFetch(gestes, "/api/ndank/gestes");
```

| Route | Ce qu'elle fait |
|---|---|
| `POST /abonnements/<id>/relancer` | envoie une relance tout de suite |
| `POST /abonnements/<id>/paiement` | enregistre un paiement constaté hors ligne |
| `POST /abonnements/<id>/suspendre` | coupe l'accès sur-le-champ |
| `POST /abonnements/<id>/retablir` | lève la suspension |
| `POST /abonnements/<id>/resilier` | arrête relances et renouvellement |

### Deux jetons, et ce n'est pas une précaution de plus

`routeurApi` reste en lecture seule. La raison n'a pas changé : il sert une
**application cliente**, distribuée, dont le code est lisible et le jeton
extractible. Tout ce qu'elle peut faire, quiconque tient ce jeton peut le faire.

Les gestes sont pour le **serveur de l'hôte**, qui sait qui est connecté et ne
distribue son jeton à personne. Les mélanger aurait fait qu'un jeton volé dans
une application Android donne le droit de marquer des abonnements comme payés.

### L'auteur est obligatoire

```
X-Ndank-Auteur: awa@baobart.ci
```

Posé par votre serveur depuis sa session, jamais par le corps de la requête —
un auteur que l'appelant remplit à sa guise est déclaratif, donc inutile le jour
où l'on cherche à comprendre. Sans lui, Ndank refuse d'écrire plutôt que de
journaliser « inconnu ».

### Ce que chaque geste garantit

**Résilier ne coupe pas l'accès payé.** La réponse porte `accesJusquA`, pour que
l'écran puisse le dire. Un abonné qui résilie le 3 a payé jusqu'au 30 ; lui
couper le service alors, ce serait garder son argent et lui retirer ce qu'il a
acheté. Ce qui s'arrête : les relances et le renouvellement.

**Suspendre coupe sur-le-champ**, et ne déplace pas l'échéance. Une suspension
n'est pas une remise : le temps continue de courir, et l'abonné qui règle son
différend retrouve son cycle là où il l'avait laissé.

**Marquer payé exige une pièce** — numéro de reçu, de virement, de bordereau.
C'est le geste le plus lourd de tous : le seul qui fasse apparaître un mois
d'abonnement sans qu'un franc ait bougé. La pièce le rend vérifiable après coup,
et **idempotent** : l'identifiant du versement en dérive, donc le même reçu
enregistré deux fois ne compte qu'une.

Il passe par `reconcilier`, comme un vrai paiement — même politique de règlement,
même cumul des versements partiels, même contrôle de devise.

Il pose **deux écritures** : le reçu, puis l'échéance. Elles doivent tomber ou
réussir ensemble, et il faut le lui donner :

```ts
interventions.ensemble = (travail) =>
  prisma.$transaction((tx) => travail(ecrituresDe(tx)));
```

`portsPrisma` le fait pour vous dès que votre client a `$transaction`.

Sans elle, les deux écritures se suivent — et une panne au milieu laisse un reçu
enregistré avec une échéance en retard, **que le rejeu ne répare pas** : le reçu
porte déjà « compté », donc la seconde tentative ne fait rien. Posez
`exigerEnsemble: true` pour que Ndank refuse plutôt que d'écrire sans filet.

**Relancer est borné à une fois par jour.** Un bouton se clique cinq fois quand
rien ne semble se passer ; cinq SMS partent, ils sont facturés, et l'abonné les
reçoit tous. Le palier suit l'échéance et non le clic : relancer trois semaines
avant passe par le courriel, qui ne coûte rien.

### Les codes de réponse

| | |
|---|---|
| `200` + `{"faire":"FAIT"}` | le geste a été posé |
| `200` + `{"faire":"RIEN"}` | rien à faire — déjà suspendu, reçu déjà enregistré. Ce n'est pas une erreur : quelqu'un a cliqué deux fois |
| `409` + `{"faire":"REFUSE"}` | le geste ne s'applique pas ici |
| `400` | auteur manquant, ou corps illisible |
| `404` | abonnement introuvable — un lien mort, pas une panne |

## Le piège du SMS, pour ceux qui écrivent leur propre rédaction

Depuis la 0.6.0, `redigerSms` s'en occupe : si vous passez par `envoiCompose`,
vous n'avez rien à faire de cette section. Elle reste ici pour l'hôte qui rédige
lui-même — et parce que le piège ne se voit nulle part.

`src/gsm7.ts` ne fait pas partie du cœur : le moteur ne l'importe pas.

Un SMS écrit dans l'alphabet GSM tient 160 caractères par segment. Un seul
caractère en dehors, et l'opérateur bascule le message entier en UCS-2 : 70. Le
message n'est ni refusé ni tronqué, il coûte simplement deux à trois fois plus.

Les coupables sont typographiques et invisibles à la relecture. Le plus sûr est
l'espace fine insécable qu'`Intl.NumberFormat` place entre un montant et sa
devise en français : elle est dans **chaque** relance.

```ts
import { replier, segments } from "ndank/gsm7";

const texte = replier(`Renouvelle pour ${montant} : ${lien}`);
segments(texte); // 1 — à vérifier, pas à supposer
```

Replier est une perte assumée, et elle peut être totale : une écriture sans
équivalent latin disparaît en entier. Un émoji effacé n'est pas grave, un nom
d'abonné effacé l'est — et dans la zone où Ndank tourne, ce n'est pas un cas
d'école. Quand la perte compte, `replierAvecPertes` dit ce qu'il a supprimé :

```ts
import { replierAvecPertes } from "ndank/gsm7";

const { texte, perdus } = replierAvecPertes(nom);
if (perdus.length > 0) { /* replier sur autre chose que le nom */ }
```

## Ce que le battement ne dit pas

Le battement répond à une question, la plus importante : **est-ce que le moteur
tourne encore**. Il n'en répond aucune autre.

Or un moteur qui tourne parfaitement peut passer ses journées à ne rien faire.
La passerelle SMS refuse la clé depuis mardi. Les webhooks arrivent avec une
signature qu'on rejette depuis le dernier déploiement. Quarante abonnés ont payé
et leur abonnement n'a pas bougé. Rien de tout cela n'arrête le passage
quotidien, rien de tout cela n'apparaît dans `Sante` — et tout cela se voit dans
des compteurs que personne ne regarde.

```ts
import { bilan, pire } from "ndank/sante";
import { signauxPrisma } from "ndank/prisma/sante";

const signaux = signauxPrisma(prisma, ports.battements, { projetId });
const constats = await bilan(signaux);

for (const c of constats) {
  console.log(`[${c.gravite}] ${c.titre}`);
  console.log(`          ${c.quoiFaire}`);
}
```

```
[ALERTE]  Aucun SMS n'est parti : 30 tentatives, 30 échecs.
          La passerelle SMS refuse tout. Vérifiez la clé, le solde du compte et
          l'expéditeur déclaré — ce n'est pas un incident réseau, c'est une
          configuration.
[ALERTE]  1 paiement a réussi sans prolonger l'abonnement.
          L'argent est arrivé et le service n'a pas suivi : ces abonnés vont
          être relancés pour une somme qu'ils ont déjà versée.
[ATTENTION] 2 abonnés à relancer n'ont aucun moyen d'être joints.
          Ni adresse, ni numéro, ni appareil. Ils arriveront à échéance sans
          avoir été prévenus une seule fois.
[RIEN]    Dernier passage il y a 1 h.
          Rien à faire.
```

Branché sur `routeurApi`, `GET /sante` porte en plus `constats` et `pire` :

```ts
routeurApi({ tableau, jeton, battements, signaux });
```

Sans `signaux`, la réponse garde exactement la forme qu'elle avait — un tableau
de bord existant ne casse pas.

### Chaque constat porte son geste

Même règle que `direSante`, et pour la même raison : un marchand qui lit des
compteurs pour décider fait notre travail. « 12 échecs d'envoi » n'aide
personne ; « 12 relances sur 130 n'ont pas pu partir » se comprend, et la phrase
qui suit dit quoi en faire.

Quatre gravités et non trois : `ALERTE` et `ATTENTION` ne demandent pas la même
chose. Une passerelle qui refuse toutes les clés se règle aujourd'hui ; douze
abonnés sans adresse se règlent un jour ou l'autre. Les mettre au même rang
ferait que ni l'un ni l'autre ne serait traité.

### Ce qu'on ne sait pas lire est un constat, pas un zéro

C'est le point qui vaut d'être écrit, parce que l'erreur inverse est naturelle.
Si la requête qui compte les envois ratés échoue, on est tenté de rendre zéro et
de passer à la suite — et le tableau de bord affiche « tout va bien » sur la foi
d'une question qu'on n'a pas pu poser.

`bilan()` ne lève donc **jamais**, et isole chaque signal. Ce qui échoue devient
un constat `ILLISIBLE` ; le reste est rendu quand même. Dire « on ne sait pas »
vaut mieux que dire « rien », parce que « rien » se croit.

De la même façon, un signal qu'on ne branche pas ne produit **aucun** constat —
et surtout pas un constat rassurant. Un hôte du niveau 1 n'a ni journal, ni
webhooks, ni table de versements ; lui annoncer « 0 paiement non compté » lui
ferait croire qu'on a vérifié.

### « Tentés » ne vient pas du journal

Le chemin évident donne ici un résultat faux, et il vaut d'être signalé à qui
écrira ses propres signaux.

Le journal ne conserve pas les envois réussis, sauf si l'hôte a demandé
`envoisReussis: true` — c'est délibéré, un envoi qui part n'a rien à raconter.
En tirer les tentatives donnerait `tentes === echoues` pour tous les canaux, et
`bilan()` annoncerait chaque jour que toutes les passerelles sont mortes. Une
alerte qui se déclenche toujours ne se lit plus au bout d'une semaine.

Les envois partis se comptent donc dans `Relance.canaux`, qui porte « les canaux
par lesquels elle est effectivement partie » et qui est écrit quoi qu'il arrive.

## Voir tous ses abonnements, d'un site à l'autre

C'est la seule question de ce dépôt qui ne puisse pas se répondre chez le
marchand. Un abonné chez trois hôtes est trois lignes, dans trois bases, que
rien ne rapproche — et aucun des trois hôtes ne connaît les deux autres.

```ts
import { projectionDe, pousser } from "ndank/projection";

const lignes = abonnements
  .map((a) => projectionDe(a, { site: "Baobart", poivre, lien }))
  .filter((l) => l !== null);

await pousser(lignes, { base, jeton, poivre, site: "Baobart" });
```

Ce qui reste chez l'hôte : l'argent, les versements, les webhooks, les
coordonnées complètes. Ce qui part : de quoi afficher une carte.

**On envoie des dates, jamais un état.** `etatDe` est la seule autorité sur ce
qu'est un abonnement suspendu, et Ndank App l'applique aux dates reçues. Envoyer
un état calculé chez l'hôte ferait qu'un abonné lirait « à jour » chez lui et
« suspendu » chez le marchand, selon la fraîcheur de la dernière poussée.

Un lot qui échoue n'emporte pas les autres, même règle que le passage quotidien
et pour la même raison : la poussée suivante rattrapera.

### L'empreinte n'est pas de l'anonymisation

Il faut le dire sans détour, parce que le contraire se croit facilement.

Un numéro de téléphone vit dans un espace minuscule — quelques milliards de
valeurs — et quiconque tient le poivre peut en dresser la table complète en
quelques heures. Une empreinte de numéro se retrouve, toujours. Et le poivre est
**partagé** entre Ndank App et tous les hôtes : il le faut, puisque l'hôte doit
calculer l'empreinte pour la pousser et Ndank App doit la recalculer quand
l'abonné se connecte. Il fuit donc avec n'importe lequel d'entre eux.

Ce qu'elle fait quand même, et qui n'est pas rien : une copie de la base de Ndank
App, prise sans le poivre, ne livre pas un annuaire.

**Ndank App détient donc des données personnelles** pour le compte de plusieurs
marchands, et l'empreinte ne l'en dispense pas. Elle réduit l'exposition
accidentelle, pas l'attaque décidée.

### Les numéros doivent être en E.164, et Ndank refuse le reste

`normaliserIdentifiant` lève sur un numéro qui ne commence pas par `+`.

C'est délibéré, et c'est la panne qu'on ne voit jamais autrement : un hôte qui
range « 0700000000 » et un autre « +2250700000000 » donneraient deux identités à
la même personne, et la vue multi-sites n'afficherait qu'une carte sur deux —
sans erreur, sans trace, sans que personne ne sache quoi chercher.

Et l'on ne peut pas deviner l'indicatif manquant : `+225` est une hypothèse qui a
l'air raisonnable jusqu'au premier abonné sénégalais. L'hôte, lui, sait le sien,
et il a déjà `enE164`.

## Le code SMS

```ts
import { engendrer, verificateur } from "ndank/code";

const code = engendrer(secret, "+2250700000000");
// → « 481207 », à envoyer par SMS

const verifier = verificateur({ secret, tentatives });
await verifier("+2250700000000", saisi);
// → { issue: "OUVERT" } | { issue: "REFUSE", restants } | { issue: "BLOQUE" }
```

Le code se dérive de `HMAC(secret, identifiant + fenêtre)` plutôt que de se tirer
au sort et de se ranger quelque part : pas de table à écrire, pas de purge à
programmer, pas de code oublié en base six mois plus tard. C'est la construction
de la RFC 4226, avec une fenêtre de temps à la place du compteur. Il vaut entre
cinq et dix minutes — la vérification accepte aussi la fenêtre précédente, sans
quoi un code émis à la fin d'une fenêtre serait mort avant que le SMS n'arrive.

**Six chiffres font un million de possibilités, ce qui se parcourt en quelques
secondes.** Le code ne protège donc rien par lui-même ; ce qui protège, c'est le
nombre d'essais. `Tentatives` n'est pas optionnel et `verificateur()` refuse de
se construire sans lui : un port qu'on peut omettre finit par être omis, et l'on
découvre le jour de l'incident que la fonction qu'on croyait sûre ne l'était que
dans les exemples.


## Ce que Ndank ne fait pas

**L'argent ne passe jamais par lui.** Il sait demander un paiement à un
fournisseur, constater qu'il a eu lieu et enchaîner le cycle — mais la somme va
du portefeuille de l'abonné au compte marchand de l'hôte, directement. Ni solde,
ni reversement, ni remboursement. Ndank ne veut pas devenir un prestataire de
paiement de plus, et n'en porte donc ni la responsabilité ni l'agrément.

**Il ne confirme pas.** Le moteur ne parle qu'au moment de relancer. Un accusé
de paiement est un message que l'hôte envoie avec ses propres mots, sur ses
propres canaux — l'annoncer ici ferait promettre à l'écran ce que le module ne
tient pas.

**Il ne stocke rien.** Aucune base, aucun fichier, aucune dépendance. Le cœur
est pur — c'est ce qui permet d'éprouver « un passage qui a raté trois jours
n'envoie qu'une relance » sans rien monter, en une milliseconde.

**Il ne relie pas un abonné d'un site à l'autre — tout seul.** Chaque hôte a sa
propre base, et sa table `abonne` est indexée par `(projetId, reference)`. Il
n'existe aucune identité qui traverse deux hôtes : « Awa chez l'un » et « Awa
chez l'autre » sont deux lignes que rien ne rapproche. C'est l'objet de la
couche de projection, et c'est le seul endroit où Ndank sort de chez le
marchand — voir plus haut.

**Il n'authentifie personne.** `ndank/code` engendre et vérifie le code à six
chiffres qu'on envoie par SMS ; il n'y a ni session, ni cookie, ni compte, ni
écran de connexion. Une bibliothèque qu'on installe chez un marchand n'a rien
de tout cela, et lui en donner ferait porter au SDK une responsabilité qui
appartient à Ndank App.

## Ce qui n'est pas encore éprouvé

**Le paquet n'est pas publié sur npm, et il ne le sera pas avant que cette liste
soit vide.**

628 tests passent. Ils tournent tous contre des faux que j'ai écrits — et un
faux ne dément jamais son auteur. Chaque ligne non cochée est un pari.

**Quatre l'ont été le 4 septembre 2026**, en installant `ndank` dans
[Baobart](https://github.com/auceps-dev-team/Baobart) et en appliquant son
schéma à un vrai PostgreSQL (Prisma 6.19.3, branche `Ndank-Baobart-Test`).

- [x] **L'adaptateur Prisma contre un vrai PostgreSQL.** `ClientNdank` est une
      interface structurelle, et les tests un `Map` en mémoire.
      → `portsPrisma` construit, `offres()` relit la grille, `souscrire()` crée
      puis refuse le doublon au second clic, `dossier.abonnement` retrouve la
      ligne, `tableau.compter` compte. Un passage complet a couru :
      `vus=1 relances=1 suspendus=0 clos=0 injoignables=0 echecs=0`.
- [x] **Une migration.** `prisma/` ne contenait que `schema.prisma`.
      → `prisma migrate dev --name ndank_import` génère et applique. Les dix
      tables sont vérifiées dans `information_schema.tables`. Aucun ajustement
      de forme n'a été nécessaire.
- [x] **Le filtre JSON de `signauxPrisma`.** `detail: { path: ["canal"] }`
      supposait un comportement de Prisma sur PostgreSQL jamais observé.
      → deux événements écrits, la clause en rend exactement un. C'est ce dont
      `bilan()` dépend pour distinguer une passerelle SMS morte d'échecs
      dispersés — si elle avait rendu zéro en silence, l'alerte n'aurait jamais
      sonné.
- [x] **`$transaction`.** Le piège du client transactionnel était corrigé contre
      un faux, qui ne reproduit pas l'isolation.
      → `interventions.ensemble` est bien branché sur `prisma.$transaction`,
      une levée à l'intérieur remonte à l'appelant, et le compte de `versement`
      est identique avant et après. Le retour arrière est bien celui de
      PostgreSQL.

Restent trois paris, dont un à moitié levé.

- [ ] **Les quatre passerelles d'envoi.** Resend, Brevo, Twilio et Expo
      étaient écrites d'après leur documentation, sans qu'aucune n'ait jamais
      été appelée.

      **Resend est levé, le 5 septembre 2026**, avec une vraie clé et un
      domaine vérifié. Une relance complète — rédigée par `redigerCourriel`, pas
      un « hello world » — part et rend son identifiant. Les trois chemins
      d'échec se comportent aussi : clé invalide → 401, domaine non vérifié →
      403 avec un message qui le nomme.

      **Une limite a été trouvée en même temps, et elle vaut d'être connue.**
      Une adresse qui rebondit rend `parti: true` : Resend accepte le message,
      et le rebond n'arrive que plus tard, par webhook. Un abonné dont
      l'adresse est morte compte donc comme joignable, et l'échelle croit
      l'avoir prévenu. Ndank ne peut pas le rattraper — le port `Envoi` rend un
      booléen à l'envoi, pas un accusé différé. Un hôte qui veut la vérité
      branche les webhooks de Resend.

      **Brevo, Twilio et Expo restent ouverts.**

- [ ] **Flutterwave et MTN.** Seul Paystack avait tourné en bac à sable — et
      c'est lui qui a révélé les deux erreurs les plus coûteuses du dépôt.

      **Flutterwave est levé, le 5 septembre 2026**, avec de vraies clés de
      test : l'invitation part, la référence revient, le constat retrouve la
      charge. Il a fallu deux corrections pour y arriver, et la seconde
      annulait la première.

      La 0.14.0 avait porté l'adaptateur sur la **v4** — la documentation la
      plus récente, un échange OAuth, un flux en trois appels. Fidèle, et
      inutilisable : le tableau de bord délivre des clés `FLWSECK_…`, et l'IDP
      de la v4 les refuse. Mesuré, pas supposé :

      ```
      v4  idp.flutterwave.com  → 401  invalid_client
      v3  api.flutterwave.com  → 200
      ```

      On ne choisit donc pas l'API la plus moderne, mais celle qu'un compte
      marchand peut réellement employer. La 0.15.0 est en v3.

      **MTN reste ouvert.**

- [x] **Les unités de Flutterwave.** On supposait des unités **majeures**, sans
      l'avoir vérifié — la forme exacte de l'erreur de facteur 100 déjà
      rencontrée sur Paystack.

      **La supposition était juste, et c'est mesuré.** Une charge réelle en bac
      à sable, `amount: 2000` en XOF, a rendu :

      ```json
      { "amount": 2000, "charged_amount": 2000, "app_fee": 40 }
      ```

      Quarante francs de commission sur deux mille, soit 2 %. Si Flutterwave
      avait lu 2 000 comme des unités mineures — vingt francs — la commission
      aurait été de 0,4.

      **Et le tableau de bord marchand l'affiche : `XOF 2,000.00`.** C'est le
      même écran qui, sur Paystack, avait affiché `XOF 20.00` pour la même
      somme et révélé l'erreur de facteur 100. Le contraste vaut démonstration.

      **Et l'essai le plus naturel n'aurait rien appris.** Pour le franc CFA,
      `versFournisseur` est l'identité : zéro décimale des deux côtés, donc
      2 000 part comme 2 000 quelle que soit la convention. Sans la commission
      qui trahit l'échelle, il aurait fallu une devise à décimales.

- [ ] **`POST /projection`.** Jamais atteint un serveur, puisque
      [Ndank App](https://github.com/auceps-dev-team/Ndank-app) ne le sert pas
      encore. Le client, lui, est importable et compose ses lots.

### Ce que l'installation a appris en plus

Trois choses que la suite de tests ne pouvait pas dire, et qui ont été
corrigées en 0.13.2 :

- la consigne d'installation du schéma **ne fonctionnait pas**. Elle proposait
  un second fichier `prisma/ndank.prisma`, ce qui demande la préversion
  `prismaSchemaFolder` de Prisma 6 ;
- `bornesDe` s'importe de `ndank/api/tableau`, pas de `ndank/api` — qui porte le
  routeur. Le README le citait sans dire d'où ;
- `grille()` rend un **tableau**, pas un objet à interroger. Le README ne le
  disait pas, et il fallait le deviner.

Et une qu'on ne peut pas corriger, seulement nommer : **Expo n'exige aucun
identifiant**, donc `verifierEnvoi` n'a rien à comparer et ne signalera jamais
un push mal branché. C'est le seul canal dont on ne peut pas dire au démarrage
s'il est prêt.

## Éprouver contre les vrais fournisseurs

```
npm run bac-a-sable
```

Tous les adaptateurs de paiement sont testés contre un faux `Http` qui rejoue ce
qu'on **croit** que l'API du fournisseur fait. C'est ce qui les rend éprouvables
sans compte marchand, et c'est aussi leur limite : un faux ne dément jamais celui
qui l'a écrit.

Ce script initie de vraies demandes chez Paystack et Flutterwave, à partir du
paquet construit. Sans clés, il ne fait rien et le dit. Il **refuse une clé de
production** — un vrai débit sur un vrai abonné se fait une fois et se regrette
longtemps.

Il ne tourne pas dans `npm test` : la suite du dépôt tourne en une seconde, sans
réseau et sans compte, et c'est ce qui fait qu'on la lance.

### Ce qu'il a trouvé la première fois qu'il a tourné

**Paystack marque une transaction `abandoned` trois secondes après sa création.**
Pas « expirée » : « pas encore payée ». L'adaptateur le traduisait en `EXPIRE`,
et la page annonçait donc à l'abonné que sa demande avait expiré pendant qu'il
saisissait son code. Corrigé en 0.8.1.

Aucune relecture du code ne l'aurait attrapé — le mot anglais dit le contraire
de ce que le champ signifie — et aucun test contre un faux non plus : c'est
celui qui écrit le faux qui décide quand renvoyer `abandoned`, et il le renvoie
quand il pense à l'abandon.

Il a aussi **confirmé** ce qui n'était qu'une affirmation : Paystack refuse une
référence déjà vue (`Duplicate Transaction Reference`), ce sur quoi repose tout
le correctif de la 0.7.0.

## Voir les pages sans rien monter

Les tableaux de bord sont partis chez Ndank App, mais deux pages restent servies
par le serveur du marchand et par personne d'autre : celle qu'un abonné ouvre en
cliquant le lien de son SMS, et le checkout public.

Les voir avant de les brancher demanderait sinon une base, un fournisseur de
paiement, un jeton signé et un abonné en retard — c'est-à-dire tout le système
en marche pour vérifier une couleur de bouton.

```sh
npm run apercu                              # depuis le dépôt
node node_modules/ndank/scripts/apercu.mjs  # depuis un projet qui l'installe
```

```
  ✓ relance.html    200   3352 octets  — ce que l'abonné voit en cliquant le lien de son SMS
  ✓ checkout.html   200   3765 octets  — le lien public qu'on met sur un site
```

L'aperçu passe par `routeurPage`, et non par les fonctions de rendu — qui ne
sont pas exportées. Ce qu'il écrit est donc exactement ce qu'un abonné
recevrait, **statut compris** : le script vérifie le code de réponse au lieu de
se contenter de l'afficher, parce qu'une page qui rend 410 s'ouvre parfaitement
dans un navigateur et ne montre pas ce qu'on croit.

Les fichiers sont autonomes : ni JavaScript, ni ressource externe, thème clair et
sombre. Ils s'ouvrent hors ligne.

## Ndank App

L'application hébergée — la base, les tableaux de bord, l'espace abonné — vit
dans un dépôt à part : [**Ndank-app**](https://github.com/auceps-dev-team/Ndank-app).
Les maquettes s'y trouvent, ainsi que le contrat que l'application doit tenir.

La séparation est nette, et c'est la proposition même de Ndank : cette
bibliothèque ne stocke rien et ne dépend de rien, donc un marchand l'installe
sans nous confier ses données. Lui ajouter un serveur, une base ou un écran
reviendrait à défaire exactement cela.

`ndank` ne parle à Ndank App que par un seul endroit — la projection, décrite
plus haut — et un hôte qui ne la branche pas ne lui envoie jamais rien.

## Origine

Extrait de [Baobart](https://github.com/auceps-dev-team/Baobart), place de
marché ivoirienne de produits numériques, où il tourne en production.

## Versions

Ce qui change d'une version à l'autre est consigné dans
[CHANGELOG.md](CHANGELOG.md).

## Licence

MIT — voir [LICENSE](LICENSE).

Le paquet a cessé d'être `private` à la 0.8.0, quand il est devenu installable :
`npm publish` était refusé, `main` pointait sur du TypeScript brut, et il n'y
avait aucune étape de construction. Ce qui manquait n'était pas la permission,
c'était le paquet.

`npm run verifier` enchaîne la vérification de types, les tests, la
construction — et `prepublishOnly` l'appelle, pour qu'une version ne parte pas
sans être passée par là. Une version partie sur un registre se reprend mal.
