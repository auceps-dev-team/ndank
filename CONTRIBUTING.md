# Contribuer à Ndank

Merci d'être là. Ce fichier dit surtout **une** chose : où nous sommes bloqués,
et pourquoi nous ne pouvons pas nous débloquer seuls.

---

## Ce que Ndank est, en trois phrases

Le mobile money ne sait pas prélever à l'initiative du marchand. Il n'existe
aucun mandat de prélèvement généralisé en zone franc CFA : chaque débit exige que
l'abonné valide sur son téléphone.

Ndank en tire la conséquence : **il rappelle, et l'abonné valide.** Une échelle
de relance, deux horloges — l'échéance et la fin d'accès — et des états déduits
des dates, jamais stockés.

TypeScript, `dependencies: {}`, licence MIT.

---

## La règle qui gouverne tout le reste

> **Un test contre un faux qu'on a écrit soi-même ne contredit jamais son
> auteur.**

Ce dépôt compte plus de huit cents tests. Ils passent tous. Et chacun des
défauts sérieux de son histoire a été trouvé ailleurs :

| Ce qui l'a trouvé | Ce que 800 tests ne voyaient pas |
|---|---|
| De vraies clés Flutterwave | l'adaptateur v4 ne pouvait même pas s'authentifier |
| Une vraie boîte Gmail | deux relances portaient le même sujet ; SPF et DMARC absents |
| Un vrai téléphone Android | la raison d'un échec, jetée ; le mode local visait le mauvais chemin |
| Un vrai webhook | la signature de Flutterwave n'authentifie pas le corps |
| Un vrai paiement Bictorys | un succès sans montant : l'abonné payait, et se faisait refuser |
| Une relecture extérieure | un champ `debut` qui mourait à la frontière du routeur |
| Un test qui manquait | trois fichiers affirmaient le contraire de ce que `reconcilier` fait |

D'où la distinction que ce dépôt tient partout : ce qui est **écrit** et ce qui
est **éprouvé**. Le `README` porte une liste de paris non levés, et tant qu'elle
n'est pas vide, **le paquet n'est pas publié sur npm**.

C'est là que vous pouvez aider.

---

## Ce qui n'a jamais été appelé

Trois adaptateurs sont écrits, testés contre des faux, et **n'ont jamais parlé à
leur fournisseur**. Nous n'avons ni les comptes ni, pour l'un d'eux, le
matériel.

### Twilio — SMS

`src/envoi/transporteurs/twilio.ts`

Ce qu'il faudrait : un compte d'essai Twilio (les crédits offerts suffisent), un
numéro d'envoi, et un numéro de test qui reçoive.

Ce qu'il faudrait vérifier, dans cet ordre d'importance :

1. **qu'un SMS part et arrive** — avec une relance composée par `redigerSms`, et
   non un « ceci est un test » : c'est le repli GSM-7 et la découpe en segments
   qu'on veut voir en vrai ;
2. **ce que `Remise.reference` contient** — Twilio rend un `SID`, et nous
   supposons son emplacement dans la réponse ;
3. **qu'une clé fausse est refusée**, et avec quel code ;
4. **ce qui arrive à un numéro invalide** — l'erreur doit être lisible, pas un
   échec muet qui compterait un `injoignable` de plus.

Il n'existe pas encore de script pour ça. `scripts/bac-a-sable-courriel.mjs` est
le modèle le plus proche : deux passerelles, un envoi réel, une clé fausse, un
destinataire absent.

### Expo — notifications push

`src/envoi/transporteurs/expo.ts`

Ce qu'il faudrait : une application Expo, un appareil réel, et un jeton de
notification.

**Ce transporteur a une particularité qu'il faut connaître avant de commencer :
Expo n'exige aucun identifiant.** `verifierEnvoi` n'a donc rien à comparer au
démarrage et ne signalera jamais un push mal branché. C'est le seul canal dont
on ne peut pas dire, au lancement, s'il est prêt — et c'est précisément pour ça
qu'un essai réel compte double ici.

À vérifier : qu'une notification arrive ; ce que rend Expo pour un jeton
révoqué — c'est le cas courant, un abonné qui désinstalle — et si cette réponse
permet de retirer le jeton proprement.

### MTN MoMo — encaissement

`src/encaissement/fournisseurs/mtn.ts`

Le plus accessible des trois : le portail développeur MTN délivre des
identifiants de bac à sable en libre-service, sans compte marchand.

C'est aussi le dernier adaptateur **branché** qui n'ait jamais parlé à son
fournisseur. Les quatre autres l'ont fait, et **chacun nous a démenti au premier
appel** : convention de montant, version d'API, chemin, forme de réponse. Il n'y
a aucune raison que celui-ci fasse exception.

À vérifier : `inviter` (c'est un `RequestToPay`), `constater`, la forme réelle
de `X-Reference-Id`, et ce que MTN rend quand l'abonné refuse sur son téléphone.

`scripts/bac-a-sable-cycle.mjs` montre la forme attendue : du fournisseur à
`reconcilier`, jusqu'à l'accès rouvert.

---

## Les quatre opérateurs sans adaptateur

**Orange**, **Wave**, **Moov** et **Djamo** n'ont que leurs fondations : ils
déclarent les champs qu'ils attendront, pour qu'un hôte puisse ouvrir ses comptes
marchands à l'avance, et lèvent un message utile en attendant.

Deux choses à savoir avant de vous lancer :

- **lomi. et Bictorys les couvrent déjà tous les quatre.** Un marchand qui veut
  Wave aujourd'hui passe par un agrégateur. Un adaptateur direct se justifie par
  les frais, pas par la couverture ;
- **Wave n'a aucun bac à sable.** Sa documentation est nette : *« There is no
  sandbox environment. All calls hit production. »* L'éprouver veut dire déplacer
  de l'argent réel, et c'est à peser avant de commencer.

---

## Comment aider, concrètement

1. **Ouvrez une issue avant d'écrire du code.** Dites quel fournisseur, quel
   compte vous avez, ce que vous comptez mesurer. Nous vous dirons ce qui est
   déjà su — cela vous fera gagner l'après-midi que nous avons perdu ailleurs.

2. **Écrivez un script de bac à sable**, pas seulement des tests. Le modèle est
   dans `scripts/` : il lit ses identifiants dans l'environnement, ne fait rien
   et le dit quand ils manquent, et compte ses vérifications. Un essai qu'on ne
   peut pas rejouer ne prouve rien le lendemain — nous l'avons appris avec
   Resend, éprouvé à la main en septembre et irreproductible ensuite.

3. **Rapportez ce qui vous a démenti**, pas seulement ce qui a marché. Les
   commentaires les plus utiles de ce dépôt racontent une erreur : pourquoi on
   croyait autre chose, et ce qui l'a corrigée. Un `// corrigé` sans le pourquoi
   se fait défaire six mois plus tard.

4. **Distinguez « mesuré » de « lu ».** Si vous reprenez une information d'une
   documentation sans l'avoir appelée, dites-le. Nous avons publié une version
   annonçant qu'un fournisseur signait ses webhooks en HMAC — c'était écrit dans
   un registre tiers, ce n'existait pas, et il a fallu un vrai webhook pour le
   voir.

---

## Ce que nous ne pouvons pas accepter

**Aucun identifiant dans une *pull request*.** Ni clé, ni jeton, ni secret de
webhook, ni dans un fichier, ni dans un test, ni tronqué. Les scripts de bac à
sable lisent tout dans l'environnement, et c'est la seule voie.

Si vous en avez poussé un par mégarde, dites-le dans la PR plutôt que de le
retirer discrètement : il restera dans l'historique, et il faudra le révoquer.

**Aucune dépendance de production.** `dependencies: {}` est vérifié par
`src/paquet.test.ts`, et c'est une partie de ce qui rend Ndank acceptable à
installer. Un adaptateur s'écrit contre l'API REST, en lisant le SDK du
fournisseur comme référence si besoin.

---

## Avant d'ouvrir une PR

```sh
npm run verifier      # typecheck, tests, build
npm run livrable      # le `dist` est-il plus vieux que la source ?
```

**La seconde commande mérite un mot**, parce que son absence a coûté deux
incidents en deux jours. `dist/` est dans `.gitignore`, les tests importent par
chemins relatifs, et `tsc --noEmit` lit la source : **on peut donc avoir quatre
voyants au vert et un paquet en retard.** Un consommateur en `file:../ndank` lit
le paquet construit — son propre typecheck restera vert lui aussi, puisqu'il
compare son code à un `.d.ts` où votre champ n'existe pas encore.

`npm run verifier` finit par `build`, donc il suffit qu'il soit le **dernier**
geste. C'est quand on reconstruit puis qu'on modifie encore que le piège se
referme.

Une remarque sur les tests, si vous travaillez sur plusieurs projets Node à la
fois : **Vitest lance un processus par cœur.** Deux suites en parallèle ne se
corrompent pas, elles ralentissent — et un test lent dépasse son délai, échoue,
et se lit comme une régression. Avant d'annoncer un test cassé, rejouez le
fichier seul.

Le code et les commentaires sont en français. Les noms aussi : `echeance`,
`accesJusquA`, `relance`. Ce n'est pas une coquetterie — les gens qui
maintiendront ce code parlent français, et un `dueDate` au milieu d'un
`abonnement` est une couture de plus.

---

## Le reste

- Le `README` porte la liste des paris non levés, avec ce qui a été mesuré et
  quand.
- `CHANGELOG.md` raconte chaque version, y compris les affirmations que nous
  avons dû retirer.
- `docs/` garde les relevés de fournisseurs — ce qui a été mesuré chez eux, et
  ce qui n'a été que lu.
