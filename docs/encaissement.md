# Encaisser

> Les cinq temps, le lien signé, la page de validation et les webhooks.
>
> [← Retour au README](../README.md)

---

# Encaisser sans encaisser

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

Cinq adaptateurs sont branchés — **Flutterwave**, **Paystack**, **MTN MoMo**,
**lomi.** et **Bictorys**. Quatre autres ont leurs bases posées : **Orange**,
**Wave**, **Moov** et **Djamo**. Ils déclarent déjà les champs qu'ils attendront, pour qu'un hôte
puisse ouvrir ses comptes marchands avant que l'adaptateur n'existe — c'est la
partie longue. En attendant, ils lèvent un message qui dit quoi faire.

Une configuration incomplète échoue au démarrage, pas en production :

```ts
import { champsManquants } from "ndank/encaissement/registre";

champsManquants("mtn", process.env); // ["cleAbonnement"] — et on refuse de démarrer
```

Sans cela, une clé absente part dans un en-tête vide, le fournisseur répond 401,
et le message parle d'autorisation — jamais de la ligne manquante.

## Les cinq temps, et les deux qui nous appartiennent

Flutterwave, Paystack, MTN et Orange n'ont ni le même vocabulaire ni les mêmes
verbes. Ils ont la même chorégraphie : s'authentifier, initier avec une clé
d'idempotence, laisser l'abonné autoriser sur son téléphone, recevoir le
résultat plus tard, re-vérifier avant de donner la valeur.

Le premier temps est à l'adaptateur, le troisième à l'abonné, le quatrième
arrive quand il arrive. Restent le deuxième et le cinquième — `inviter` et
`constater`. C'est tout le port.

La clé de cycle sert de référence, donc de clé d'idempotence : rejouer un
passage ne crée pas une seconde demande de paiement.

**Sauf chez lomi., et c'est la mesure qui l'a montré.** Leur route de création
de lien exige une `Idempotency-Key` — sans elle, un `400` net — mais ne
l'honore pas : trois appels avec la même clé et le même corps ont rendu trois
liens distincts. La même en-tête fonctionne pourtant sur leur route de demande
de paiement. L'adaptateur répare donc à leur place : il cherche un lien portant
déjà la référence avant d'en créer un. C'est le genre de chose qu'aucune
documentation n'avoue et qu'aucun test contre un faux ne trouve.

# Payer en plusieurs fois

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

# Le lien de relance

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

# La page de validation

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

## Ce qu'elle refuse de faire

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

## Elle n'écrit rien

`surIssue` est appelée quand un paiement est constaté ; c'est vous qui ouvrez
la transaction. Faire avancer une échéance et noter le versement qui l'a payée
doivent tomber ou réussir **ensemble**, et seul l'hôte connaît sa base.

# Les webhooks

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

## La signature de Flutterwave n'authentifie pas le corps

C'est le constat le plus sérieux de l'épreuve du 7 septembre 2026, et il ne se
corrige pas dans Ndank — mais il faut le connaître avant de brancher un
webhook Flutterwave.

Paystack signe le corps : `x-paystack-signature` est un HMAC-SHA512 du contenu.
Changer un octet invalide la signature.

Flutterwave envoie le **secret lui-même**, en clair, dans `verif-hash`. Il
prouve que l'émetteur connaît le secret. Il ne dit rien du contenu. Mesuré sur
un webhook réellement reçu :

```
· corps modifié accepté, montant relu : 200000 XOF
```

En remplaçant `"amount":2000` par `"amount":200000`, la vérification passe
toujours. Et comme `reconcilier` passe `issue.montant` à `regler`, un corps
gonflé achète du temps d'abonnement.

Deux conséquences pratiques :

**Le secret voyage à chaque requête.** Tout ce qui journalise les en-têtes le
capture — un proxy, une sonde, un service de capture. Un HMAC ne livre qu'un
condensé, inutilisable pour forger un autre corps. **Traitez le secret hash
comme un mot de passe**, et changez-le s'il a pu être vu.

**Ne croyez pas le montant du webhook.** Un hôte prudent traite le webhook
Flutterwave comme un signal — « va regarder » — et relit l'état par
`constater`, qui passe par un appel authentifié. C'est exactement la conduite
que l'adaptateur MTN impose déjà, faute de signature du tout.

## L'interrogation n'est pas un repli du webhook

Les deux chemins doivent pouvoir conclure. Un webhook se perd — le service
redémarre, un pare-feu bloque, l'hôte répond 500 une fois de trop. Les rappels
de MTN ne sont même pas signés. Flutterwave écrit d'ailleurs l'inverse dans sa
documentation : re-vérifier avant de donner la valeur.

C'est `Creances.dejaCompte` qui rend inoffensif le fait que les deux
concluent — d'où l'exigence que `surIssue` soit idempotente.
