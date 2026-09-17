# Les relances

> L'échelle, ce qu'elle garantit, et les deux pièges de la rédaction.
>
> [← Retour au README](../README.md)

---

# Envoyer les relances

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

## Vérifier au démarrage, pas au troisième jour

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

**Mais cette vérification regarde si la clé est là, pas si elle marche.** Elle
ne fait aucun appel réseau — au démarrage, personne ne veut attendre trois
passerelles. Deux pannes lui échappent donc entièrement, et ce sont les deux
qu'on a rencontrées :

- une clé Brevo **bloquée par filtrage d'IP** est présente, bien formée, et
  refusée à chaque envoi (voir plus bas) ;
- un domaine **sans SPF ni DKIM** envoie parfaitement, et atterrit en spam.

Les deux produisent la même chose qu'une clé absente : un `injoignable` de plus
dans le bilan, et un abonné qui n'a rien reçu. **La seule parade est d'envoyer
pour de vrai avant la mise en service** — c'est à cela que sert
`npm run bac-a-sable-courriel`.

## Un passage à blanc avant le premier vrai

```ts
import { envoiMuet } from "ndank/envoi";

const { envoi, retenus } = envoiMuet();
await passer({ lecture, ecriture, envoi }, { lien, montant });

retenus;   // tout ce qui serait parti : à qui, sur quel canal, avec quel texte
```

Il **rédige vraiment** — c'est tout l'intérêt. Un faux qui se contenterait de
compter ne dirait rien du contenu, et c'est le contenu qui surprend : un libellé
d'offre un peu long fait déborder le SMS, et on préfère le découvrir là.

## Le courriel qui tombe en spam n'est pas un problème de Ndank

Le premier envoi vers une vraie boîte Gmail a atterri dans les indésirables. Le
diagnostic est du côté du **domaine**, pas de la bibliothèque :

```
SPF     sur le sous-domaine        — absent
DMARC   sur le sous-domaine        — absent (hérité en p=none)
DKIM    (Resend)                   — présent
```

Depuis février 2024, Gmail attend SPF **et** DKIM **et** DMARC. Un seul des
trois suffit à faire basculer, surtout sur un domaine neuf, sans réputation, qui
envoie un message court avec un lien et le mot « suspendu ».

**Ce qui relève de l'hôte** : poser trois enregistrements DNS, et laisser passer
quelques jours d'envois réguliers. Aucune ligne de code n'y peut rien.

### Les trois enregistrements, et ce que chacun prouve

| | Où | Ce que ça prouve |
|---|---|---|
| **SPF** | `TXT` sur le domaine d'envoi | que ce service a le droit d'écrire en votre nom |
| **DKIM** | `TXT` sur `<sélecteur>._domainkey` | que le message n'a pas été modifié en route |
| **DMARC** | `TXT` sur `_dmarc.<domaine>` | ce qu'il faut faire quand l'un des deux échoue |

Les valeurs à poser dépendent de la passerelle :

```dns
; ── Resend ────────────────────────────────────────────────────────────
send.exemple.ci.            TXT   "v=spf1 include:amazonses.com ~all"
resend._domainkey.exemple.ci.  TXT   "p=…"        ← donnée par Resend

; ── Brevo ─────────────────────────────────────────────────────────────
exemple.ci.                 TXT   "v=spf1 include:spf.brevo.com mx ~all"
brevo._domainkey.exemple.ci.   TXT   "k=rsa; p=…" ← donnée par Brevo

; ── DMARC, commun aux deux ────────────────────────────────────────────
_dmarc.exemple.ci.          TXT   "v=DMARC1; p=none; rua=mailto:dmarc@exemple.ci"
```

Les `include:` et les sélecteurs (`resend`, `brevo`) sont des constantes
publiées. **La clé DKIM, elle, est propre à votre compte** : elle s'affiche dans
l'écran « domaine » du fournisseur et ne se devine pas.

Commencer en `p=none` est délibéré : DMARC vous fait alors **rapporter** les
échecs sans rejeter le courrier. On durcit en `p=quarantine` puis `p=reject`
une fois les rapports propres — durcir d'emblée sur un domaine neuf fait
disparaître ses propres relances.

### Le piège du sous-domaine

Si vous envoyez depuis `ndank.exemple.ci`, **SPF et DKIM doivent être posés sur
ce sous-domaine-là**, pas sur `exemple.ci` : ils ne s'héritent pas.

DMARC, lui, **s'hérite**. Un sous-domaine sans `_dmarc` n'est donc pas
« sans politique » : il applique celle du domaine parent. C'est exactement ce
qu'on a mesuré le 9 septembre 2026 — un `p=none` hérité, jamais choisi, et un
courriel dans les indésirables.

**Ce qui relève de Ndank** : que le message soit bon quand il arrive. C'est le
seul levier de ce côté-ci, et il vaut la peine — voir le sujet, ci-dessous.

**Et un rappel qui va en spam est pire qu'un envoi raté** : Ndank le compte
`parti: true`, l'échelle avance, et l'abonné ne voit rien. C'est la même
famille que le rebond de Resend et que le `Pending` de la passerelle Android.

## Brevo filtre par adresse IP, et le dit mal

Constaté le 11 septembre 2026, au premier appel réel.

**La clé API de Brevo n'accepte que des adresses IP déclarées.** Tant que la
vôtre ne l'est pas, chaque appel rend :

```json
{ "code": "unauthorized",
  "message": "We have detected you are using an unrecognised IP address
              2001:42d8:…. If you performed this action make sure to add
              the new IP address in this link: …" }
```

`401`, c'est-à-dire le code de « mauvais identifiants ». **Le réflexe est donc
de croire la clé fausse et d'en regénérer une, ce qui ne change rien.** Seul le
message nomme la vraie cause, et il faut le lire jusqu'au bout.

Trois choses à savoir avant de chercher :

- **la clé SMTP n'est pas soumise au même filtre**, par défaut. Deux clés du
  même compte, deux comportements — de quoi conclure à tort que la clé API est
  cassée ;
- **IPv4 et IPv6 sont deux entrées distinctes.** Une machine qui sort en IPv6 le
  matin et en IPv4 l'après-midi doit avoir déclaré les deux ;
- **une IP résidentielle change.** Un serveur à adresse fixe n'a le problème
  qu'une fois ; un poste de développement le retrouve après chaque
  renouvellement de bail DHCP.

Les adresses se déclarent sur `app.brevo.com/security/authorised_ips`.

**Resend n'a pas cette contrainte** — c'est une particularité de Brevo, pas une
règle du courriel.

## Ce que la rédaction garantit

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

## Écrire sa propre passerelle

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

# Le piège du SMS, pour ceux qui écrivent leur propre rédaction

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

# Envoyer moins vite, pour continuer à envoyer

Deux hôtes ont le même besoin pour deux raisons opposées. Celui qui passe par
une **SIM** protège sa carte : cinq cents messages identiques en trois minutes
ressemblent, vue du réseau, à ce que les opérateurs de la zone combattent
activement. Celui qui passe par **Twilio** protège sa facture : une boucle qui
part de travers se compte en euros avant que quiconque ne s'en aperçoive.

D'où un décorateur, et non une option de l'adaptateur Android.

```ts
import { limiter } from "ndank/envoi/limite";
import { transporteurSms } from "ndank/envoi/registre";

const sms = limiter(transporteurSms("passerelle-android", process.env), {
  parMinute: 10,
  parJour: 300,
  surRefus: ({ envoyesAujourdhui, plafond }) => alerter(envoyesAujourdhui, plafond),
});
```

Il se substitue au transporteur partout : même nom, même canal, même
`disponible`. Rien en aval ne sait qu'il est limité.

## Espacer plutôt que refuser, et refuser quand même au bout

**L'espacement est la vraie protection.** Cinq cents relances à six secondes
d'intervalle prennent cinquante minutes — sans importance pour une tâche
nocturne, et déterminant pour la carte SIM.

**Le plafond est un garde-fou, pas un régulateur.** Il est censé ne jamais se
déclencher. N'avoir que lui serait pire : les premiers messages partiraient en
rafale, la SIM serait signalée dès le premier soir, et le plafond n'aurait rien
empêché.

L'attente varie de ±30 % par défaut, parce qu'**un message exactement toutes
les six secondes ne ressemble à rien d'humain**. Le hasard coûte zéro et retire
ce motif.

## Un refus n'est pas une perte

Au plafond, le transporteur rend `parti: false`. Le moteur essaie le barreau
suivant et **ne note pas la relance** : elle repartira d'elle-même au passage du
lendemain. C'est le même chemin qu'un abonné momentanément injoignable.

Une réserve, tout de même : l'ordre du lot ne change pas d'un jour à l'autre. Si
le plafond mord tous les jours, ce sont toujours les mêmes abonnés de fin de
liste qui ne reçoivent rien.

```
500 relances à 10/min, plafond 300 :
  300 parties, 200 reportées à demain
  durée du passage : 30 minutes
  refus signalés   : 200
```

**Un plafond qui mord tous les jours n'est donc pas un réglage** : c'est le
signal qu'il faut une seconde SIM ou une vraie passerelle. `surRefus` est là
pour qu'on l'apprenne autrement que par un abonné qui appelle.
