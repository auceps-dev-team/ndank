# Le tableau de bord

> Ce qu'un marchand lit, et les cinq gestes qu'il peut poser.
>
> [← Retour au README](../README.md)

---

# L'API du tableau de bord

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

## On ne peut pas demander « combien de suspendus »

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

# Les gestes du tableau de bord

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

## Deux jetons, et ce n'est pas une précaution de plus

`routeurApi` reste en lecture seule. La raison n'a pas changé : il sert une
**application cliente**, distribuée, dont le code est lisible et le jeton
extractible. Tout ce qu'elle peut faire, quiconque tient ce jeton peut le faire.

Les gestes sont pour le **serveur de l'hôte**, qui sait qui est connecté et ne
distribue son jeton à personne. Les mélanger aurait fait qu'un jeton volé dans
une application Android donne le droit de marquer des abonnements comme payés.

## L'auteur est obligatoire

```
X-Ndank-Auteur: awa@baobart.ci
```

Posé par votre serveur depuis sa session, jamais par le corps de la requête —
un auteur que l'appelant remplit à sa guise est déclaratif, donc inutile le jour
où l'on cherche à comprendre. Sans lui, Ndank refuse d'écrire plutôt que de
journaliser « inconnu ».

## Ce que chaque geste garantit

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

## Les codes de réponse

| | |
|---|---|
| `200` + `{"faire":"FAIT"}` | le geste a été posé |
| `200` + `{"faire":"RIEN"}` | rien à faire — déjà suspendu, reçu déjà enregistré. Ce n'est pas une erreur : quelqu'un a cliqué deux fois |
| `409` + `{"faire":"REFUSE"}` | le geste ne s'applique pas ici |
| `400` | auteur manquant, ou corps illisible |
| `404` | abonnement introuvable — un lien mort, pas une panne |
