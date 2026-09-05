# Active Context — Ndank

## État Actuel du Projet
- **Version courante** : `0.17.1` (mise à jour de documentation et packaging SMS actée dans le commit `68fe3bb`).
- **Statut de la suite de tests** : 34 suites de tests, 657 tests unitaires et d'intégration réussis (100% de succès).
- **Arborescence Git** :
  - Branche active : `main` (travail propre, aucun fichier non suivi ou non commité).
  - Branche secondaire : `feat/promesses` (ancrée historiquement sur le commit `235d326`).
  - Total de 78 commits retraçant l'évolution méticuleuse du projet depuis l'extraction initiale du cœur de Baobart (`8e967d6` le 02/09/2026).

## Décisions Récentes (v0.14.0 à v0.17.1)
1. **Pliage de l'API Flutterwave sur la v3 (`51a7b29`, `c82606b`)** : Abandon de la v4 suite à la constatation empirique en bac à sable que les comptes marchands réels reçoivent des clés `FLWSECK_...` rejetées par l'IDP OAuth v4 (`401 invalid_client`). La v3 fonctionne immédiatement et de manière stable.
2. **Support de la Passerelle SMS Android (`d39ccd8`)** : Ajout du transporteur `passerelleAndroid` compatible avec `android-sms-gateway` (Apache 2.0). Permet l'envoi de SMS via un smartphone local avec forfait SIM local et fournit l'état de livraison réel `Delivered`.
3. **Protection de SIM et Facture via Limiteur de Débit (`dbbc2a1`, `68fe3bb`)** : Décorateur `limiter()` pour temporiser les envois de SMS avec gigue aléatoire (ex: 10/min avec variation de ±30%) et plafond journalier pour éviter les blocages d'opérateurs télécoms et les dérives de coûts.
4. **Clarification du statut des « 8 Paris »** :
   - 4 paris levés et confirmés sur le terrain (décimales Paystack, décimales Flutterwave en unités majeures, webhook Flutterwave v3, corps brut de webhook).
   - 4 paris toujours ouverts (les réponses réelles d'Orange Money, Wave, Moov et Djamo en direct sans passer par un agrégateur).
5. **Audit complet et approfondi du projet réalisé** : Rapport technique exhaustif consigné dans `audit_complet_ndank.md` et dans les artefacts de conversation.
6. **Décision d'architecture majeure sur le canal SMS (v0.18.0)** :
   - Adoption du **flux inversé (long-polling sortant)** : le terminal local (smartphone Android ou modem USB) interroge le serveur du marchand (y compris hébergé dans le Cloud) via une connexion HTTP tenue 25s. Résout le NAT sans aucun tiers.
   - Introduction d'une **file d'attente SMS durable** dans le SDK permettant la réémission en minutes en cas de coupure temporaire.
   - Refonte de la validité des liens de paiement : **lien frais calculé par palier** (écart jusqu'au rappel suivant + marge) plutôt que 15 jours fixes ou 24h rigides (qui casseraient la remontée des SMS).
   - Relais Ndank App repositionné en composant secondaire pour les marchands sans aucun matériel.


## Dette Technique et Défis Ouverts
1. **Fournisseurs d'encaissement en direct (`src/encaissement/fournisseurs/directs.ts`)** :
   - Orange Money, Wave, Moov, Djamo sont actuellement des « fondations » typées levant une erreur explicite. L'implémentation complète nécessite des accès aux portails développeurs ou des contrats marchands directs avec les opérateurs telco respectifs.
2. **Passerelles SMS et Push en attente (`src/envoi/transporteurs/fondations.ts`)** :
   - Orange SMS, Africa's Talking, Firebase Cloud Messaging (FCM), et WebPush sont déclarés sous forme de fondations.
3. **Passage de requêtes synchrones vers files d'attente (Asynchronisme à haute volumétrie)** :
   - Pour de très grands volumes (ex: > 50 000 abonnés quotidiens), la boucle `passer` et les appels synchrones à Flutterwave (3 requêtes par invitation) pourraient bénéficier d'une architecture orientée messages/files d'attente (bullmq, rabbitmq ou sqs), bien que le traitement par grappes (`parGrappes`) limite déjà l'empreinte mémoire.
4. **Ordre du lot en cas de saturation de plafond SMS** :
   - Si le plafond journalier de SMS est atteint quotidiennement, les abonnés en fin de liste ne reçoivent pas leur relance. Une permutation circulaire ou un tri basé sur l'urgence critique du palier pourrait être introduit.
