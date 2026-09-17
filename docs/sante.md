# Savoir que le moteur tourne

> Le battement, les cinq états, et ce que la santé ne dit pas.
>
> [← Retour au README](../README.md)

---

# Savoir que le moteur tourne encore

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

## Pourquoi cela existe

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

## Les cinq états

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

## Deux seuils, et pourquoi ces valeurs

**26 heures** avant de crier `MUET`. Un cron quotidien dérive : 6 h 00 un jour,
6 h 05 le lendemain, et l'écart dépasse déjà vingt-quatre heures. Un seuil à
vingt-quatre alerterait sur cette dérive normale chaque semaine, jusqu'à ce que
plus personne ne regarde. Deux heures de marge l'absorbent sans cacher un jour
manqué, qui en donne quarante-huit.

**2 heures** avant de dire `BLOQUE`. Un passage sur cinq cents abonnements prend
des secondes ; deux heures est plusieurs ordres de grandeur au-dessus.

Les deux se resserrent : `routeurApi({ sante: { retardTolereHeures: 12 } })`.

## La seule exception à la règle des jours civils

Partout ailleurs, Ndank compare des **jours civils** — c'est ce qui empêche
l'heure du cron de décider d'une coupure d'accès.

Ici, non : on mesure **le cron lui-même**. Un passage qui remonte à vingt-cinq
heures va bien, un à cinquante ne va pas, et les deux peuvent tomber sur
« hier » en jours civils. C'est le seul endroit du dépôt où les heures sont la
bonne unité, et l'inverser serait une faute.

## Garder la trace de ce qui se passe

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

# Ce que le battement ne dit pas

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

## Chaque constat porte son geste

Même règle que `direSante`, et pour la même raison : un marchand qui lit des
compteurs pour décider fait notre travail. « 12 échecs d'envoi » n'aide
personne ; « 12 relances sur 130 n'ont pas pu partir » se comprend, et la phrase
qui suit dit quoi en faire.

Quatre gravités et non trois : `ALERTE` et `ATTENTION` ne demandent pas la même
chose. Une passerelle qui refuse toutes les clés se règle aujourd'hui ; douze
abonnés sans adresse se règlent un jour ou l'autre. Les mettre au même rang
ferait que ni l'un ni l'autre ne serait traité.

## Ce qu'on ne sait pas lire est un constat, pas un zéro

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

## « Tentés » ne vient pas du journal

Le chemin évident donne ici un résultat faux, et il vaut d'être signalé à qui
écrira ses propres signaux.

Le journal ne conserve pas les envois réussis, sauf si l'hôte a demandé
`envoisReussis: true` — c'est délibéré, un envoi qui part n'a rien à raconter.
En tirer les tentatives donnerait `tentes === echoues` pour tous les canaux, et
`bilan()` annoncerait chaque jour que toutes les passerelles sont mortes. Une
alerte qui se déclenche toujours ne se lit plus au bout d'une semaine.

Les envois partis se comptent donc dans `Relance.canaux`, qui porte « les canaux
par lesquels elle est effectivement partie » et qui est écrit quoi qu'il arrive.
