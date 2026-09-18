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

## La documentation

Ce README dit ce qu'est Ndank et pourquoi il existe. Le reste vit à côté, une
page par sujet — parce qu'une page de deux mille lignes ne se lit pas, elle se
parcourt.

| | |
|---|---|
| [Démarrer](docs/demarrer.md) | installer, déclarer ce qu'on vend, faire naître un abonnement |
| [Les relances](docs/relances.md) | l'échelle, ce qu'elle garantit, les pièges de la rédaction |
| [Le SMS, et la file](docs/sms.md) | ce qu'un SMS coûte vraiment ici, et pourquoi la connexion s'inverse |
| [Encaisser](docs/encaissement.md) | les cinq temps, le lien signé, la page de validation, les webhooks |
| [Le tableau de bord](docs/tableau-de-bord.md) | ce qu'un marchand lit, et les cinq gestes qu'il pose |
| [Savoir que le moteur tourne](docs/sante.md) | le battement, les cinq états, ce que la santé ne dit pas |
| [L'espace abonné](docs/abonnes.md) | la vue multi-sites, la connexion par code, les permissions |
| [Ce qui est éprouvé](docs/eprouve.md) | **la liste des paris**, et les bacs à sable qui les lèvent |

Et deux relevés de fournisseurs, pour ce qui a été mesuré chez eux plutôt que
lu : [lomi.](docs/lomi.md) et [π-SPI](docs/pi-spi.md).

---

## Ce qui est éprouvé, et ce qui ne l'est pas

C'est la page qu'il faut lire avant de faire confiance à ce paquet.

**Plus de huit cents tests passent. Ils tournent presque tous contre des faux que
j'ai écrits — et un faux ne dément jamais son auteur.** Chaque défaut sérieux de
ce dépôt a été trouvé ailleurs : par de vraies clés, une vraie boîte aux lettres,
un vrai téléphone, un vrai webhook, ou une relecture extérieure.

**Quatre adaptateurs de paiement sur cinq ont parlé à leur fournisseur.**
Flutterwave, Paystack, lomi. et Bictorys l'ont fait ; MTN jamais. S'y ajoutent
quatre fondations — Orange, Wave, Moov et Djamo — qui déclarent leurs champs sans
avoir d'adaptateur à éprouver. Des cinq passerelles d'envoi, trois ont émis pour
de vrai ; Twilio et Expo jamais.

**Le paquet n'est pas publié sur npm**, et il ne le sera pas avant que cette
liste soit vide. Le détail, avec les dates et ce que chaque essai a démenti, est
dans [Ce qui est éprouvé](docs/eprouve.md).

Si vous avez un compte Twilio, un appareil Expo ou un accès MTN,
[CONTRIBUTING.md](CONTRIBUTING.md) dit exactement quoi mesurer et dans quel
ordre.

---

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
