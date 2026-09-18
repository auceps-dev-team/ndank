# Ce qui est éprouvé, et ce qui ne l'est pas

> La liste des paris, et les bacs à sable qui les lèvent.
>
> [← Retour au README](../README.md)

---

# Ce qui n'est pas encore éprouvé

**Le paquet n'est pas publié sur npm, et il ne le sera pas avant que cette liste
soit vide.**

824 tests passent — mesuré le 18 septembre 2026, 39 fichiers, zéro échec. Ils
tournent presque tous contre des faux que j'ai écrits — et un faux ne dément
jamais son auteur. **Un test absent non plus** : voir ce que la 0.24.4 a dû
retirer. Chaque ligne non cochée est un pari.

**Quatre l'ont été le 4 septembre 2026**, en installant `ndank` dans
[Baobart](https://github.com/auceps-dev-team/Baobart) et en appliquant son
schéma à un vrai PostgreSQL (Prisma 6.19.3, branche `Ndank-Baobart-Test`).

- [x] **L'adaptateur Prisma contre un vrai PostgreSQL.** `ClientNdank` est une
      interface structurelle, et les tests un `Map` en mémoire.
      → `portsPrisma` construit, `offres()` relit la grille, `souscrire()` crée
      puis refuse le doublon au second clic, `dossier.abonnement` retrouve la
      ligne, `tableau.compter` compte. Un passage complet a couru :
      `vus=1 relances=1 suspendus=0 clos=0 injoignables=0 echecs=0`.
- [x] **Une migration.** `prisma/` ne contenait que `schema.prisma`.
      → `prisma migrate dev --name ndank_import` génère et applique. Les dix
      tables sont vérifiées dans `information_schema.tables`. Aucun ajustement
      de forme n'a été nécessaire.
- [x] **Le filtre JSON de `signauxPrisma`.** `detail: { path: ["canal"] }`
      supposait un comportement de Prisma sur PostgreSQL jamais observé.
      → deux événements écrits, la clause en rend exactement un. C'est ce dont
      `bilan()` dépend pour distinguer une passerelle SMS morte d'échecs
      dispersés — si elle avait rendu zéro en silence, l'alerte n'aurait jamais
      sonné.
- [x] **`$transaction`.** Le piège du client transactionnel était corrigé contre
      un faux, qui ne reproduit pas l'isolation.
      → `interventions.ensemble` est bien branché sur `prisma.$transaction`,
      une levée à l'intérieur remonte à l'appelant, et le compte de `versement`
      est identique avant et après. Le retour arrière est bien celui de
      PostgreSQL.

Restent quatre paris, tous à moitié levés.

- [ ] **Les passerelles d'envoi.** Cinq sont écrites ; **trois ont émis pour de
      vrai**, et les deux du courriel sont désormais rejouables.

      **Resend** — le 5 septembre 2026, puis le 11. Une relance complète,
      rédigée par `redigerCourriel`, part et rend son identifiant ; clé
      invalide → 401, domaine non vérifié → 403. Elle a atteint une **vraie
      boîte** le 9 septembre — et elle est tombée dans les indésirables, faute
      de SPF et de DMARC sur le domaine d'envoi.

      **Brevo** — le 11 septembre 2026. Même relance, même vraie boîte, un
      identifiant `<…@smtp-relay.mailin.fr>` en retour. Deux choses que seul
      l'appel réel pouvait dire : **la clé API est restreinte par adresse IP**
      là où la clé SMTP ne l'est pas — un `401` qui nomme l'IP et non la clé,
      donc facile à lire de travers — et le compte n'a **aucun domaine
      authentifié**, ce qui promet le même sort qu'à Resend.

      ```
      npm run bac-a-sable-courriel
      ```

      Onze vérifications, zéro échec, les deux passerelles dans un seul
      passage. L'essai de septembre avait été fait à la main : un essai qu'on
      ne peut pas rejouer ne prouve rien le lendemain.

      **La passerelle Android** — le 7 septembre 2026, un Samsung A15 et une SIM
      Orange. `Delivered` en cinq secondes, en mode local. Voir le récit
      plus haut : quatre échecs et trois défauts de code avant d'y arriver.

      **Twilio et Expo n'ont jamais été appelés.**

- [x] **La passerelle Android.** Écrite d'après la documentation, elle n'avait
      jamais appelé un téléphone. Elle l'a fait le 7 septembre 2026, et l'essai
      a trouvé deux défauts qu'aucun test ne pouvait voir : la raison d'un échec
      qu'on jetait, et le mode local qui visait le mauvais chemin.

- [ ] **Flutterwave et MTN.** **Flutterwave est levé.** Le chemin entier a
      tourné contre du réel, le 7 septembre 2026 : invitation, paiement mené à
      son terme sur un vrai numéro, **webhook signé reçu**, rejoué octet pour
      octet, cycle avancé, accès rouvert, rejeu sans effet.

      ```
      ▸ La signature
        ✓ le corps réel passe la vérification
        ✓ un mauvais secret est refusé
      ▸ Du webhook au cycle
        avant : SUSPENDUE, accès coupé
        après : ACTIVE, accès ouvert (+30 j)
        ✓ le rejeu du webhook ne prolonge pas deux fois
      ```

      `npm run bac-a-sable-webhook` le rejoue depuis une capture.

      **MTN n'a jamais été appelé.**

- [ ] **Bictorys.** Dix pays — Cameroun et Nigeria compris, là où lomi. s'arrête
      aux huit de l'UEMOA. Dix-huit vérifications contre le vrai bac à sable, le
      14 septembre 2026, **zéro échec**.

      ```
      npm run bac-a-sable-bictorys
      ```

      C'est le premier adaptateur qui n'a **rien coûté à découvrir** : écrit
      d'après [`afrotools`](https://github.com/afrotools/afrotools), un registre
      public qui documente les *pièges* en plus des champs, il a marché au
      premier appel. Deux réserves sur ce registre : son README annonce que
      chaque fiche est vérifiée contre l'API réelle, alors que **9 schémas sur
      157** portent le statut `verified` — mais plusieurs pièges citent des
      appels réels. Ce sont les pièges qui portent la preuve, pas l'étiquette.

      **Sa signature de webhook est la meilleure des cinq — sur le papier.**
      HMAC-SHA256 de `horodatage.corps` : elle lie le contenu **et** protège du
      rejeu, ce qu'aucune autre ne fait.

      **Mais elle est désactivée par défaut**, compte par compte. Un webhook
      réellement reçu le 14 septembre 2026 ne portait, pour toute preuve, qu'un
      `x-secret-key` — le secret en clair.

      Ce paragraphe a dit « elle n'existe pas » jusqu'à la 0.22.4, et c'était
      faux : `docs.bictorys.com/docs/intégration-en` la documente, même formule
      et même fenêtre. La page de validation des webhooks, elle, n'en parle
      pas — et c'est la seule que nous avions lue. « La documentation n'en parle
      pas » n'a jamais voulu dire « la documentation que j'ai lue n'en parle
      pas ».

      Conséquence pratique inchangée : **n'attendez pas la signature.** Sur un
      compte où elle n'est pas activée, c'est le repli qui tourne, un montant
      réécrit de 100 à 100 000 passe, et c'est la réconciliation qui protège.

      **Un paiement a abouti**, et c'est le seul fournisseur du dépôt dont le
      bac à sable mène la boucle entière tout seul : Bictorys expose un
      simulateur qui approuve une transaction sans opérateur.

      Il a fallu un échec pour le trouver. Le tunnel hébergé route vers les
      **vrais** opérateurs, qui refusent un numéro ordinaire en test — Orange
      Money répond `USER_INVALID`. C'est le chemin direct, avec `payment_type`,
      qui donne accès au simulateur.

      Ce paiement a trouvé un défaut qu'aucun test contre un faux n'aurait vu :
      la route d'état rend `{id, status}` **sans montant**, donc un succès en
      sortait avec `montant: 0`. Corrigé en 0.22.1.

      **Ce paragraphe a surestimé la portée du défaut jusqu'à la 0.24.4.** Il
      ajoutait que « `reconcilier` achète du temps avec ce montant ». C'est
      faux, et c'est vérifiable : `reconcilier` refuse un montant nul depuis la
      **0.3.0** — `fb7959f`, 3 septembre 2026, onze jours avant la mesure — et
      rend un `INCIDENT`, traduit en `REFUSE` motivé par `intervention.ts`.

      La conséquence réelle n'est pas un crédit silencieux de zéro jour : c'est
      **un abonné qui a payé et qui se fait refuser**, dont l'accès ne rouvre
      pas tant que personne ne traite l'incident. Aussi cassé, plus visible.

      Pourquoi l'affirmation a tenu onze jours dans trois fichiers : **la garde
      de `reconcilier` n'avait aucun test.** Un faux qu'on écrit ne dément
      jamais son auteur — un test absent non plus. Il en existe un depuis la
      0.24.4.

- [ ] **lomi.** Le premier adaptateur **écrit après avoir appelé l'API**, et non
      d'après une documentation. Douze vérifications contre le vrai bac à sable,
      le 10 septembre 2026 : invitation, lien durable de quarante-cinq jours,
      page de paiement qui répond, rejeu qui rend le même lien, constat qui ne
      conclut pas à l'échec faute de nouvelle.

      ```
      npm run bac-a-sable-lomi
      ```

      **Le paiement lui-même reste hors de portée** : aucun canal n'est raccordé
      au compte marchand — « *Wave provider not configured for this
      organization* » — et sur 132 routes documentées, **aucune ne permet d'y
      remédier**. C'est lomi. qui raccorde, après identification du marchand.

      **La signature du webhook non plus** : elle est un vrai HMAC-SHA256 du
      corps brut, mais son secret `whsec_` n'est pas exposé par l'API et se
      recopie du tableau de bord.

      Le relevé complet est dans `docs/lomi.md`.

- [x] **Les unités de Flutterwave.** On supposait des unités **majeures**, sans
      l'avoir vérifié — la forme exacte de l'erreur de facteur 100 déjà
      rencontrée sur Paystack.

      **La supposition était juste, et c'est mesuré.** Une charge réelle en bac
      à sable, `amount: 2000` en XOF, a rendu :

      ```json
      { "amount": 2000, "charged_amount": 2000, "app_fee": 40 }
      ```

      Quarante francs de commission sur deux mille, soit 2 %. Si Flutterwave
      avait lu 2 000 comme des unités mineures — vingt francs — la commission
      aurait été de 0,4.

      **Et le tableau de bord marchand l'affiche : `XOF 2,000.00`.** C'est le
      même écran qui, sur Paystack, avait affiché `XOF 20.00` pour la même
      somme et révélé l'erreur de facteur 100. Le contraste vaut démonstration.

      **Et l'essai le plus naturel n'aurait rien appris.** Pour le franc CFA,
      `versFournisseur` est l'identité : zéro décimale des deux côtés, donc
      2 000 part comme 2 000 quelle que soit la convention. Sans la commission
      qui trahit l'échelle, il aurait fallu une devise à décimales.

- [x] **`POST /projection`.** Atteint un vrai serveur le 7 septembre 2026,
      quand Ndank App a servi la route. Le vrai `pousser` de cette
      bibliothèque, sur de vraies sockets :

      ```
      1. Poussée de 250 lignes, par lots de 100
        ok  les 250 lignes sont parties
        ok  découpées en 3 lots
      2. La même poussée, rejouée
        ok  toujours 250 cartes, pas 500
      3. Ce qui a traversé
        ok  l'échéance est intacte
        ok  l'empreinte est celle de `projectionDe`
      4. Ce que la route refuse
        ok  annoncer le site d'un autre est refusé en 403
      ```

      Le découpage en lots, les en-têtes réellement composés et les dates
      converties en ISO n'avaient jamais traversé HTTP. Quatorze vérifications,
      zéro échec, reproduites de part et d'autre.

## Ce que l'installation a appris en plus

Trois choses que la suite de tests ne pouvait pas dire, et qui ont été
corrigées en 0.13.2 :

- la consigne d'installation du schéma **ne fonctionnait pas**. Elle proposait
  un second fichier `prisma/ndank.prisma`, ce qui demande la préversion
  `prismaSchemaFolder` de Prisma 6 ;
- `bornesDe` s'importe de `ndank/api/tableau`, pas de `ndank/api` — qui porte le
  routeur. Le README le citait sans dire d'où ;
- `grille()` rend un **tableau**, pas un objet à interroger. Le README ne le
  disait pas, et il fallait le deviner.

Et une qu'on ne peut pas corriger, seulement nommer : **Expo n'exige aucun
identifiant**, donc `verifierEnvoi` n'a rien à comparer et ne signalera jamais
un push mal branché. C'est le seul canal dont on ne peut pas dire au démarrage
s'il est prêt.

# Éprouver contre les vrais fournisseurs

```
npm run bac-a-sable
```

Tous les adaptateurs de paiement sont testés contre un faux `Http` qui rejoue ce
qu'on **croit** que l'API du fournisseur fait. C'est ce qui les rend éprouvables
sans compte marchand, et c'est aussi leur limite : un faux ne dément jamais celui
qui l'a écrit.

Ce script initie de vraies demandes chez Paystack et Flutterwave, à partir du
paquet construit. Sans clés, il ne fait rien et le dit. Il **refuse une clé de
production** — un vrai débit sur un vrai abonné se fait une fois et se regrette
longtemps.

Il ne tourne pas dans `npm test` : la suite du dépôt tourne en une seconde, sans
réseau et sans compte, et c'est ce qui fait qu'on la lance.

## Ce qu'il a trouvé la première fois qu'il a tourné

**Paystack marque une transaction `abandoned` trois secondes après sa création.**
Pas « expirée » : « pas encore payée ». L'adaptateur le traduisait en `EXPIRE`,
et la page annonçait donc à l'abonné que sa demande avait expiré pendant qu'il
saisissait son code. Corrigé en 0.8.1.

Aucune relecture du code ne l'aurait attrapé — le mot anglais dit le contraire
de ce que le champ signifie — et aucun test contre un faux non plus : c'est
celui qui écrit le faux qui décide quand renvoyer `abandoned`, et il le renvoie
quand il pense à l'abandon.

Il a aussi **confirmé** ce qui n'était qu'une affirmation : Paystack refuse une
référence déjà vue (`Duplicate Transaction Reference`), ce sur quoi repose tout
le correctif de la 0.7.0.

# Voir les pages sans rien monter

Les tableaux de bord sont partis chez Ndank App, mais deux pages restent servies
par le serveur du marchand et par personne d'autre : celle qu'un abonné ouvre en
cliquant le lien de son SMS, et le checkout public.

Les voir avant de les brancher demanderait sinon une base, un fournisseur de
paiement, un jeton signé et un abonné en retard — c'est-à-dire tout le système
en marche pour vérifier une couleur de bouton.

```sh
npm run apercu                              # depuis le dépôt
node node_modules/ndank/scripts/apercu.mjs  # depuis un projet qui l'installe
```

```
  ✓ relance.html    200   3352 octets  — ce que l'abonné voit en cliquant le lien de son SMS
  ✓ checkout.html   200   3765 octets  — le lien public qu'on met sur un site
```

L'aperçu passe par `routeurPage`, et non par les fonctions de rendu — qui ne
sont pas exportées. Ce qu'il écrit est donc exactement ce qu'un abonné
recevrait, **statut compris** : le script vérifie le code de réponse au lieu de
se contenter de l'afficher, parce qu'une page qui rend 410 s'ouvre parfaitement
dans un navigateur et ne montre pas ce qu'on croit.

Les fichiers sont autonomes : ni JavaScript, ni ressource externe, thème clair et
sombre. Ils s'ouvrent hors ligne.
