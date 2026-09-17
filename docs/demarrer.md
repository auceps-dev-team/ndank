# Démarrer

> Installer, déclarer ce qu'on vend, et faire naître un premier abonnement.
>
> [← Retour au README](../README.md)

---

# Trois façons de l'utiliser

| | Pour qui | Ce qu'il faut faire |
|---|---|---|
| **Ports** | Autonomie complète | Implémenter `Lecture`, `Ecriture`, `Envoi` contre votre base |
| **Schéma fourni** | Intégration rapide | Prendre les tables Prisma livrées, et nommer ses passerelles |
| **Service hébergé** | Sans code | Appeler l'API *(à venir)* |

Les trois partagent le même cœur : les niveaux 2 et 3 ne sont que des
implémentations des mêmes ports. C'est pour cela qu'ils n'en dupliqueront pas
une ligne.

## Niveau 1 en pratique

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

## Niveau 2 : le schéma fourni

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

# Dire ce qu'on vend

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

## Une offre ne se supprime pas

`actif: false` la retire du catalogue sans rien casser : des abonnements en cours
la référencent, et leur libellé comme leur montant en dépendent. `offresActives()`
rend ce qu'on propose aujourd'hui, `offreDe()` retrouve n'importe laquelle.

# Faire naître un abonnement

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
