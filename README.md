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

## Deux garde-fous

**Un passage qui a raté trois jours n'envoie qu'une relance**, la plus avancée.
Rattraper avec trois messages d'affilée fait désinstaller l'application.

**Une relance jamais partie n'est pas notée.** Sinon une panne d'un jour coupe
l'accès de quelqu'un qu'on n'a jamais prévenu, et le lendemain le moteur croit
l'avoir fait.

## Trois façons de l'utiliser

| | Pour qui | Ce qu'il faut faire |
|---|---|---|
| **Ports** | Autonomie complète | Implémenter `Lecture`, `Ecriture`, `Envoi` contre votre base |
| **Schéma fourni** | Intégration rapide | Prendre les tables Prisma livrées *(à venir)* |
| **Service hébergé** | Sans code | Appeler l'API *(à venir)* |

Les trois partagent le même cœur : les niveaux 2 et 3 ne sont que des
implémentations des mêmes ports. C'est pour cela qu'ils n'en dupliqueront pas
une ligne.

### Niveau 1 en pratique

```ts
import { passer } from "./src/moteur";

const bilan = await passer(
  { lecture, ecriture, envoi },   // vos implémentations
  {
    lien: (a) => `https://exemple.com/abonnement/${a.id}/renouveler`,
    montant: (a) => `${a.montant} ${a.devise}`,
  },
);
```

Puis un passage par jour. Il peut rater son tour : l'état se **déduit** des
dates, il n'est jamais stocké — un jour sauté ne laisse rien de faux derrière
lui.

## Un helper pour ceux qui branchent un SMS

`src/gsm7.ts` ne fait pas partie du cœur — le moteur ne l'importe pas. Il est
là parce que tout hôte qui implémente `Envoi` pour un SMS tombe sur le même
piège, et qu'il ne se voit nulle part.

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

**Il n'encaisse pas.** Il décide qui relancer et quand ; le paiement lui-même
appartient à l'hôte, qui a déjà son opérateur. Ndank ne veut pas devenir un
prestataire de paiement de plus.

**Il ne stocke rien.** Aucune base, aucun fichier, aucune dépendance. Le cœur
est pur — c'est ce qui permet d'éprouver « un passage qui a raté trois jours
n'envoie qu'une relance » sans rien monter, en une milliseconde.

## Origine

Extrait de [Baobart](https://github.com/auceps-dev-team/Baobart), place de
marché ivoirienne de produits numériques, où il tourne en production.

## Licence

MIT — voir [LICENSE](LICENSE).

Le paquet reste `private` : la licence dit ce qu'on a le droit de faire du code,
pas qu'il soit prêt à être publié sur npm. Les niveaux 2 et 3 n'existent pas
encore, et une version 0.1.0 publiée se reprend mal.
