# Le SMS, et la file

> Ce que coûte vraiment un SMS ici, et pourquoi la connexion s'inverse.
>
> [← Retour au README](../README.md)

---

# Brancher le SMS : ce que cela demande vraiment

**Ndank ne sait pas envoyer un SMS.** Il sait en *rédiger* un — tenir en un seul
segment GSM-7, lien signé compris — et le tendre à une passerelle. La passerelle
n'est pas à lui, et c'est la seule pièce de l'échelle de relance qu'un hôte doit
se procurer avant que le canal existe.

Le courriel se branche en dix minutes avec une clé d'API. Le push aussi. Le SMS
demande une décision, et souvent du matériel.

## Trois voies, trois contraintes

| Voie | Ce qu'il faut avoir | Ce que cela coûte | Ce qu'on obtient |
|---|---|---|---|
| **Twilio** | un compte, une carte bancaire, un expéditeur déclaré | ~5 c€ le SMS vers la Côte d'Ivoire | la livraison partout, aucun matériel |
| **Passerelle Android** | un téléphone, une SIM, l'application, un réseau joignable | le forfait, et rien de plus | `Delivered`, et rien qui transite chez un tiers |
| **Opérateur local** | un contrat commercial, des semaines de délai | le moins cher au volume | ce que l'opérateur veut bien |

Orange SMS et Africa's Talking sont **déclarés au registre mais pas branchés**.
Leur configuration se valide dès aujourd'hui — ouvrir un contrat opérateur prend
des semaines, et il vaut mieux que les champs soient prêts — mais l'envoi refuse,
en disant où obtenir l'accès :

```
La passerelle « orange-sms » n'est pas branchée dans Ndank.
Canal : sms. Champs prévus : identifiantClient, secretClient, expediteur.
Portail developer.orange.com, produit « SMS API », puis un contrat de volume par pays.
```

Un adaptateur inventé qui échoue au premier vrai paiement vaudrait moins qu'un
refus franc.

## La voie Android, dans l'ordre

Cinq choses, et la quatrième est celle qu'on découvre trop tard.

1. **Un téléphone Android qui reste allumé et branché.** Pas celui qu'on emporte
   le week-end : c'est un serveur, il doit être traité comme tel.
2. **Une SIM avec un forfait SMS**, chez un opérateur du pays des abonnés.
3. **L'application** [android-sms-gateway](https://github.com/capcom6/android-sms-gateway),
   qui affiche un identifiant et un mot de passe dans ses réglages.
4. **La joignabilité.** Votre serveur doit pouvoir atteindre ce téléphone, et
   c'est là que le choix se fait :

   — en **mode local** (`mode: "appareil"` — l'API du téléphone n'est pas
   celle du serveur), le serveur et le téléphone sont sur le même réseau
   (`http://192.168.1.42:8080`). Rien ne transite chez personne. Mais votre
   serveur doit être dans ce réseau — ce qui exclut un hébergement distant ;

   — en **mode nuage** (`https://api.sms-gate.app`), cela marche depuis
   n'importe où. Le contenu des messages passe alors par un serveur que vous ne
   tenez pas — or un SMS de relance porte un nom, un montant et un lien signé.

   **Ou aucune des deux** : depuis la 0.18.0, l'appareil peut appeler votre
   serveur au lieu d'être appelé — voir « La file » plus bas. Le NAT cesse
   alors d'être un problème, sans tiers et quel que soit votre hébergement.

5. **La permission Android d'envoyer des SMS.** Elle se donne à part, et
   c'est le piège le plus courant : l'application est installée, le service
   tourne, l'API répond `200` — et rien ne part. La passerelle le dit, à
   condition d'aller lire la cause par destinataire :

   ```
   sendSMS: uid 10657 does not have android.permission.SEND_SMS.
   ```

   Rencontré au premier envoi réel, le 7 septembre 2026.

6. **La configuration**, puis `verifierEnvoi()` au démarrage — il nomme le
   champ qui manque au lieu de laisser la passerelle répondre 401 le troisième
   jour :

   ```ts
   verifierEnvoi({
     sms: { passerelle: "passerelle-android", identifiants: process.env },
   });
   // → ["sms : passerelle-android — utilisateur, motDePasse manque(nt)."]
   ```

```ts
import { transporteurSms } from "ndank/envoi/registre";
import { limiter } from "ndank/envoi/limite";

const sms = limiter(
  transporteurSms("passerelle-android", {
    base: process.env.SMS_BASE,
    utilisateur: process.env.SMS_UTILISATEUR,
    motDePasse: process.env.SMS_MOT_DE_PASSE,
  }),
  { parMinute: 10, parJour: 300 },
);
```

## Ce que la limite règle, et ce qu'elle ne règle pas

C'est le tableau qui compte, parce que la tentation est de croire qu'un
paramètre a fait disparaître un risque.

| Le risque | Ce que `limiter` en fait |
|---|---|
| **L'opérateur suspend la SIM** | **Atténué, pas supprimé.** L'espacement retire le motif qui déclenche la détection. Il ne rend pas l'usage conforme à un contrat grand public |
| **Le téléphone tombe en panne** | **Rien.** La limite n'y peut rien. Seul `bilan()` le voit — et au passage suivant |
| **Le débit d'un téléphone** | **Rendu explicite.** Il ne l'augmente pas : il vous fait choisir le rythme au lieu de le subir |

Le premier point mérite d'être lu deux fois. Une carte grand public qui émet des
messages applicatifs sort de l'usage pour lequel elle est vendue, quel que soit
le rythme. Le risque croît avec le volume — quelques dizaines de rappels par mois
vers ses propres clients n'est pas dix mille — mais il ne descend jamais à zéro.
**C'est une décision d'hôte, pas un réglage de bibliothèque**, et Ndank ne la
prendra pas à votre place.

## La panne du téléphone se voit, mais pas tout de suite

C'est la limite la plus concrète, et elle vaut d'être dite en clair : entre le
moment où le téléphone s'éteint et celui où quelqu'un l'apprend, il se passe **un
passage quotidien**.

`bilan()` le rapporte alors sans ambiguïté :

```
[ALERTE]  Aucun SMS n'est parti : 30 tentatives, 30 échecs.
          La passerelle SMS refuse tout. Vérifiez la clé, le solde du compte
          et l'expéditeur déclaré — ce n'est pas un incident réseau, c'est
          une configuration.
```

Un hôte qui tient au SMS ne s'en remet donc pas au tableau de bord : il alerte
sur `PANNE` et `ALERTE` par un canal qui ne dépend pas du téléphone.

## Ce que Ndank ne saura jamais vous dire

Trois choses qu'aucune de ses vérifications n'atteint, parce qu'aucune API ne
les expose :

- **si la SIM a du crédit.** Un forfait épuisé donne des échecs, pas un message
  clair. On le déduit d'une `ALERTE`, on ne le lit pas ;
- **si l'opérateur vous limite.** Un débit soudainement réduit ressemble à un
  réseau lent ;
- **si le message est arrivé** — sauf par cette passerelle-ci, seule à rendre
  `Delivered`, et seulement si l'hôte relit `etatDuMessage` après coup.

## Le courriel d'abord, toujours

Une conséquence pratique de tout ce qui précède : **le SMS n'est pas le premier
barreau de l'échelle, et ne doit pas l'être.**

Le courriel ne coûte rien, ne suspend aucune SIM, et ne dépend pas d'un
téléphone posé sur une étagère. C'est pour cela que le checkout public exige une
adresse : sans elle, chaque relance de cet abonné consomme la ressource la plus
fragile du système.

# La file : inverser le sens de la connexion

C'est la réponse au mur décrit plus haut. Une passerelle SMS locale vit derrière
une box, sur une adresse privée ; le serveur du marchand vit chez Vercel ou dans
un datacenter européen.

```
serveur → téléphone     bloqué par le NAT, partout, toujours
téléphone → serveur     sortant, donc traversant partout
```

Le passage quotidien n'appelle donc plus personne : il **dépose**. L'appareil du
marchand vient chercher, émet par sa SIM, et rapporte.

```ts
import { fileEnMemoire } from "ndank/file/memoire";
import { versLaFile } from "ndank/file/transporteur";
import { routeurFile } from "ndank/file/routeur";

const file = fileEnMemoire();            // en production : une table

const sms = versLaFile({ file });        // le transporteur du passage
const routeur = routeurFile({ file, jeton: process.env.NDANK_FILE_JETON });
```

```
GET  /attente    → les messages à émettre, après attente si la file est vide
POST /accuses    → ce qu'ils sont devenus
```

**L'hébergement redevient libre.** Serverless, conteneur, VPS à Francfort : c'est
l'appareil qui appelle, donc peu importe où l'on est appelé. Et rien ne transite
par un tiers — le message ne quitte l'infrastructure du marchand qu'au moment où
la radio l'émet.

## Du vrai long-polling, et la différence décide de ce qu'on peut faire

Une interrogation toutes les trente secondes suffit pour des relances de nuit.
Elle ne suffit pas pour un code de connexion : quelqu'un qui regarde son écran
en attendant six chiffres ne comprendra pas trente secondes de silence.

Ici, l'appareil ouvre **une** requête que le serveur garde suspendue jusqu'à
vingt-cinq secondes et libère **à l'instant** où un message est déposé. La
latence tombe à quelques centaines de millisecondes, et le code SMS devient
possible sans WebSocket, sans relais, sans rien à opérer.

**On sonde la file plutôt que d'écouter un événement**, et c'est délibéré. Un
émetteur en mémoire serait plus élégant et faux dans le cas courant : le passage
quotidien tourne dans un cron, souvent un autre processus que le serveur web,
parfois une autre machine. La requête resterait suspendue pendant que les
messages s'empilent à côté.

Le coût dépend de l'hébergement : tenir une requête ouverte est gratuit sur un
serveur persistant, et facturé sur du serverless. `attenteMax: 0` rend alors la
main immédiatement, et la route redevient un simple sondage.

## Le bail, et ce qu'il empêche de perdre

C'est la seule exigence subtile du port, et s'en écarter perd des messages en
silence.

Un appareil qui prend dix messages puis meurt — batterie, réseau, processus tué
— n'émettra rien et n'acquittera rien. `prendre` pose donc un **bail** : les
messages sont réservés, et redeviennent disponibles au bout de quelques minutes.

La remise est ainsi « au moins une fois » plutôt que « au plus une fois ». Un
abonné peut recevoir un rappel en double si l'appareil meurt entre l'émission et
l'accusé — **et pour une relance, c'est le bon sens** : mieux vaut un doublon
qu'un abonné jamais prévenu.

## Un message qui vieillit dit le contraire de ce qu'il devait dire

Chaque dépôt porte une péremption, six heures par défaut. Ce n'est pas une durée
technique, c'est une durée éditoriale.

Un téléphone rallumé après trois jours viderait sa file d'un coup : l'abonné
recevrait « accès coupé dans 7 jours » le jour où son accès est déjà coupé, puis
« dernier rappel » après avoir payé. **Mieux vaut qu'un message meure que
d'arriver faux.**

## La profondeur de la file voit ce qu'aucun autre signal ne voyait

C'est le gain qu'on n'attendait pas, et il ferme une lacune que ce README
décrivait comme non couverte.

La panne d'une passerelle locale était invisible jusqu'au passage suivant : il
fallait qu'un lot entier d'envois échoue pour que `bilan()` s'en aperçoive,
c'est-à-dire vingt-quatre heures plus tard.

Une file renverse cela. **Personne ne vient chercher se voit tout de suite**, et
sans qu'un seul envoi ait eu à échouer :

```
[ALERTE]  31 SMS attendent depuis 90 min.
          Plus personne ne vient les chercher. L'appareil est éteint, hors
          réseau, ou son jeton ne correspond plus. Les messages expireront
          d'eux-mêmes plutôt que d'arriver faux — mais les abonnés ne seront
          pas prévenus.
```

Branchez `fileSms` sur les signaux de `bilan()` pour l'obtenir. En dessous de
dix minutes d'attente, il ne dit rien : une file qui bouge est l'état normal.

## Ce qui reste à écrire

`fileEnMemoire` vit dans un processus : deux instances derrière un répartiteur
ont deux files, et un redémarrage vide la sienne. Elle sert à éprouver le chemin
complet sans base ni téléphone — **pas à tenir une production**.

Un hôte du niveau 2 la remplace par une table ; le port ne change pas.
L'implémentation Prisma n'est pas encore écrite.

Et l'agent qui tourne sur le téléphone reste à faire : aujourd'hui, la boucle
« demander, émettre, acquitter » n'a pas de client officiel.

## L'agent : celui qui vient chercher

Le dernier morceau, et il n'a pas besoin d'être une application Android — ce
cadrage était une erreur. Le problème n'a jamais été d'écrire une application
mobile : il était que la passerelle et le serveur ne peuvent pas se joindre.

L'agent tourne **chez le marchand**, sur une machine du même réseau que le
téléphone, et se place entre les deux :

```
serveur du marchand  ←── long-poll ──  AGENT  ──→  téléphone
   (Vercel, VPS)                    (au bureau)   (192.168.x.x)
```

Vers le serveur il appelle, donc le NAT est traversé. Vers le téléphone il est
déjà sur le bon réseau. Les deux moitiés du problème se résolvent parce que
quelqu'un se tient au milieu.

```sh
NDANK_FILE_BASE=https://mon-app.ci/sms NDANK_FILE_JETON=... SMS_BASE=http://192.168.1.42:8080 SMS_UTILISATEUR=sms SMS_MOT_DE_PASSE=... node node_modules/ndank/scripts/agent-sms.mjs
```

**Il ne sait pas envoyer un SMS, et c'est voulu.** Il reçoit un
`TransporteurSms` et le lui confie : le même agent sert donc une passerelle
Android, un modem USB, ou Twilio en dépannage, sans qu'une ligne de sa boucle ne
change.

Trois comportements valent d'être connus :

- **il acquitte aussi les échecs.** Se taire laisserait les messages sous bail
  plusieurs minutes, alors qu'on sait déjà qu'il faut réessayer ;
- **il revérifie la péremption avant chaque envoi.** Avec six secondes
  d'espacement, dix messages prennent une minute : le dernier peut avoir expiré
  pendant qu'on envoyait les neuf premiers ;
- **il s'arrête sur un 401.** Un jeton révoqué ne se réessaie pas ; boucler
  dessus n'ajouterait que du bruit dans les journaux du serveur.

Il ne s'arrête pas tout seul autrement : mettez-le sous `systemd`, `pm2`, ou
dans un conteneur qui redémarre. **Un agent arrêté ne produit aucune erreur** —
il produit du silence, et c'est la file qui grossit que `bilan()` verra.

## Le diagnostic, en français

Le premier branchement d'un vrai téléphone a demandé quatre tentatives et une
heure. Rien n'était compliqué — une permission Android qui se donne en trois
gestes, dont un qu'on saute naturellement. Mais la passerelle répondait
`Failed`, et rien ne disait quoi faire.

Un marchand ivoirien ne lira pas la documentation d'Android en anglais pour
comprendre `uid 10657 does not have SEND_SMS`. Il conclura que cela ne marche
pas.

```ts
import { diagnostiquerAndroid } from "ndank/envoi/transporteurs/passerelle-android";

for (const c of await diagnostiquerAndroid(config)) {
  console.log(`${c.va ? "✓" : "✗"} ${c.constat}`);
  if (c.quoiFaire) console.log(c.quoiFaire);
}
```

```
✓ La passerelle répond, et les identifiants passent.
✗ Android n'autorise pas l'application à envoyer des SMS.
    Trois gestes, dans cet ordre — le deuxième est celui qu'on saute :
      1. Paramètres → Applications → SMSGate → menu ⋮ → « Autoriser les
         paramètres restreints » ;
      2. Autorisations → SMS → « Ne pas autoriser », puis « Autoriser » à
         nouveau. L'octroi précédent datait d'avant la levée de restriction ;
      3. Forcer l'arrêt de l'application, puis redémarrer le service.
```

**Il n'envoie aucun SMS.** Il lit ce que la passerelle garde des envois récents
— un diagnostic qui coûte un message ne se lance pas au démarrage, donc ne se
lance jamais. Conséquence assumée : sur une passerelle qui n'a rien émis, il ne
peut pas dire si la permission est accordée, et **il le dit** plutôt que de
rassurer à tort.

Il traduit aussi le téléphone endormi, le mauvais `mode`, les deux couples
d'identifiants qu'on mélange, le mode avion, l'absence de réseau et la limite
d'émission d'Android. Une cause qu'il ne connaît pas est rendue telle quelle,
en disant qu'elle n'est pas traduite.

## Le premier vrai SMS, et ce qu'il a coûté

Le 7 septembre 2026, un Samsung A15 avec une SIM Orange ivoirienne, en mode
local — donc sans qu'un octet ne transite par un tiers :

```
voie : local — rien ne transite par un tiers
  +  0s  Pending
  +  5s  Delivered   ← REMIS, confirmé par l'appareil du destinataire
```

Puis la chaîne entière, contre la même SIM :

```
1. le passage dépose  → 1 message en file
2. l'agent long-poll  → il attend
3. l'agent émet       → 1/1 parti(s)
4. la file est vidée  → 0 restant(s)
5. la santé           → MOTEUR    (rien à signaler)
```

`Delivered` en cinq secondes. C'est l'affirmation défendue depuis le début et
qui n'était qu'une lecture de documentation : **l'appareil du destinataire a
confirmé**. Resend et Twilio ne le donnent pas au moment de l'envoi.

### Quatre échecs avant, et chacun a trouvé quelque chose

Il a fallu quatre tentatives. Aucun des trois défauts de code n'était visible
aux sept cents tests d'alors.

**1. Le mode local est tombé en quatre-vingt-dix secondes.** Le premier
`/health` a répondu en 1,5 s — déjà lent pour un réseau local — puis le
téléphone a disparu. Android met le Wi-Fi en veille dès que l'écran s'éteint.
C'est le « point de panne unique » décrit plus haut, observé en direct au
premier essai.

**2. On jetait la raison de l'échec.** `etatDuMessage` lisait `reason` à la
racine ; la passerelle range la cause **dans chaque destinataire**. Le message
rendait donc « Failed » sans un mot, alors que la passerelle disait exactement
quoi faire. Corrigé en 0.19.1.

**3. Le mode local visait le mauvais chemin.** Le serveur expose
`/3rdparty/v1/messages`, l'appareil expose `/message`. Le mode qu'on recommande
pour la confidentialité était donc **le seul à n'avoir jamais fonctionné**.
Corrigé en 0.19.2, avec `mode: "serveur" | "appareil"`.

**4. La permission Android.** Elle demande trois gestes, et sauter le deuxième
laisse un système qui affiche « Autorisé » et refuse à l'exécution :

- *Applications → SMSGate → menu ⋮ → **Autoriser les paramètres restreints*** —
  une application installée hors magasin en a besoin ;
- **retirer puis réaccorder** la permission SMS, parce que l'octroi précédent
  datait d'avant la levée de restriction ;
- **forcer l'arrêt**, puis redémarrer le service.

### Deux réglages à faire avant de compter dessus

**« Gérer l'appli si inutilisée »** retire les permissions SMS et Téléphone
après quelques mois sans ouverture — pour un service qu'on n'ouvre jamais,
c'est une panne programmée et silencieuse. À désactiver.

**L'optimisation de batterie** doit être levée pour l'application, sinon le mode
local ne tient pas la nuit. À défaut, le mode nuage tient — au prix du transit
par un tiers.

## Éprouver la chaîne sans SIM

```sh
npm run bac-a-sable-sms
```

Vingt vérifications sur de **vraies sockets** et une **vraie horloge**. Trois
choses échappent par construction aux tests unitaires, qui injectent l'horloge
et appellent les fonctions directement :

- **la latence réelle.** On affirmait que le long-polling libère « en quelques
  centaines de millisecondes ». C'est maintenant mesuré : **175 ms** du dépôt à
  la réception par l'agent ;
- **le passage par HTTP.** Entre `routeurFile` et un agent, il y a un serveur,
  un corps à lire, des en-têtes à poser. Le script monte le routeur sur
  `node:http` — vingt lignes, celles que l'hôte écrira ;
- **la concurrence.** Deux agents qui tirent la même file au même instant :
  24 messages, 24 émissions distinctes, aucun doublon. C'est le bail qui
  tranche, et un `Map` interrogé séquentiellement ne le démontre pas.

L'agent y est simulé — `emettre()` rend « parti » sans rien émettre. **Tout le
reste est réel**, et la boucle « demander, émettre, acquitter » y est écrite
exactement comme un agent Android devra la faire : le script vaut donc aussi de
spécification pour qui l'écrira.
