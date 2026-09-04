# Ndank

**Abonnements par mobile money, sans carte bancaire.**

*Ndank ndank mooy japp golo ci ñaay* — petit à petit, on attrape le singe.

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
import { passer } from "./src/moteur";

const ports = { lecture, ecriture, envoi };   // vos implémentations

const bilan = await passer(ports, {
  lien: (a) => `https://exemple.com/abonnement/${a.id}/renouveler`,
  montant: (a) => `${a.montant} ${a.devise}`,
});

bilan.echecs;   // ce qui n'a pas pu être traité, et pourquoi
bilan.lotPlein; // vrai s'il restait probablement du travail
```

Puis un passage par jour. Il peut rater son tour : l'état se **déduit** des
dates, il n'est jamais stocké — un jour sauté ne laisse rien de faux derrière
lui.

Une seule exigence sur `Lecture.aRelancer` : **ne pas rendre ce qui est déjà
clos.** Le moteur ne peut pas le savoir, donc il redit `clore` tant qu'il le
voit ; sur une base qui vieillit, les morts finissent par occuper le lot — qui
est plafonné — et par évincer les vivants.

Quand un paiement est confirmé, l'hôte enchaîne le cycle :

```ts
import { finaliserRenouvellement } from "./src/moteur";

const suivant = await finaliserRenouvellement(ports, abonnement, new Date());
```

Le cycle repart de l'**échéance** et non de la date de paiement — sauf si
l'accès était déjà perdu, auquel cas facturer une période écoulée n'aurait
aucun sens. Aucune notification ne part d'ici : le moteur ne parle qu'au moment
de relancer, et un hôte qui veut confirmer un paiement le fait chez lui.

### Niveau 2 : le schéma fourni

Les tables sont dans [`prisma/schema.prisma`](prisma/schema.prisma) — neuf
modèles, validés par `prisma validate`. Le schéma se copie dans votre projet et
se migre avec votre propre historique ; Ndank ne livre pas de migrations, qui
entreraient en conflit avec les vôtres.

```
cp .env.example .env      # puis remplir DATABASE_URL et vos clés
npx prisma migrate dev
```

Puis les ports sont déjà écrits — c'est tout ce que le niveau 2 vous épargne :

```ts
import { PrismaClient } from "@prisma/client";
import { portsPrisma } from "./src/prisma/adaptateur";
import { passer } from "./src/moteur";

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

## Envoyer les relances

`Envoi` était le dernier port à écrire. Il ne l'est plus : Ndank rédige les
trois formes du message et livre quatre passerelles.

```ts
import { envoiCompose } from "./src/envoi/compose";
import { transporteurCourriel, transporteurSms } from "./src/envoi/registre";

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
import { verifierEnvoi } from "./src/envoi/registre";

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
import { envoiMuet } from "./src/envoi/compose";

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
import { fournisseur } from "./src/encaissement/registre";

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
import { champsManquants } from "./src/encaissement/registre";

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
import { replier, segments } from "./src/gsm7";

const texte = replier(`Renouvelle pour ${montant} : ${lien}`);
segments(texte); // 1 — à vérifier, pas à supposer
```

Replier est une perte assumée, et elle peut être totale : une écriture sans
équivalent latin disparaît en entier. Un émoji effacé n'est pas grave, un nom
d'abonné effacé l'est — et dans la zone où Ndank tourne, ce n'est pas un cas
d'école. Quand la perte compte, `replierAvecPertes` dit ce qu'il a supprimé :

```ts
import { replierAvecPertes } from "./src/gsm7";

const { texte, perdus } = replierAvecPertes(nom);
if (perdus.length > 0) { /* replier sur autre chose que le nom */ }
```

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

## Origine

Extrait de [Baobart](https://github.com/auceps-dev-team/Baobart), place de
marché ivoirienne de produits numériques, où il tourne en production.

## Versions

Ce qui change d'une version à l'autre est consigné dans
[CHANGELOG.md](CHANGELOG.md).

## Licence

MIT — voir [LICENSE](LICENSE).

Le paquet reste `private` : la licence dit ce qu'on a le droit de faire du code,
pas qu'il soit prêt à être publié sur npm. Les niveaux 2 et 3 n'existent pas
encore, et une version partie sur npm se reprend mal.
