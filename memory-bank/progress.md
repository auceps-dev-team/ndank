# Progress & Roadmap — Ndank

## Milestones Terminés
- [x] **v0.1.0 - v0.2.0** : Extraction du cœur de Baobart, arithmétique de cycle civile UTC, gestion des états sans persistance d'état, table GSM-7 avec repli et décompte de segments, traitement par grappes sans blocage sur incident.
- [x] **v0.3.0** : Couche d'encaissement, réconciliation des paiements, support des versements partiels (`CREDIT` et `PRORATA`), adaptateurs Paystack, Flutterwave et MTN MoMo.
- [x] **v0.4.0 - v0.5.0** : Schéma Prisma Niveau 2 (`schema.prisma`), isolation multi-tenant par `projetId`, typage structurel `ClientNdank` sans dépendance de runtime.
- [x] **v0.6.0** : Couche d'envoi multi-canaux (`compose`), gestion des transporteurs (Twilio, Resend, Brevo, Expo), rédaction des messages sous contrainte stricte de 1 segment SMS.
- [x] **v0.7.0** : Liens de relance signés HMAC-SHA256 (96 bits tronqués base64url), page de validation HTML pure sans JS, gestionnaire de webhooks à vérification sur corps brut, API en lecture seule.
- [x] **v0.8.0 - v0.9.0** : Banc d'essai bac à sable (`bac-a-sable.mjs`), correction majeure des décimales Paystack (centimes obligatoires sur XOF), clarification du statut `abandoned`.
- [x] **v0.10.0 - v0.12.0** : Gestes d'intervention manuels protégés (`suspendre`, `retablir`, `resilier`, `marquerPaye` avec transaction atomique), battements de cœur (`battement`), journalisation tamponnée par lots (`journal`).
- [x] **v0.13.0** : Intégration croisée Ndank App, checkout public d'abonnement, codes de connexion SMS sécurisés (HOTP), projection de cartes d'abonnements, calcul de ponctualité et coûts.
- [x] **v0.14.0 - v0.15.1** : Épreuve réelle des agrégateurs, alignement Flutterwave sur l'API v3 stable, validation des accusés Resend.
- [x] **v0.16.0 - v0.17.1** : Transporteur SMS Passerelle Android locale (`android-sms-gateway`) avec accusé réel `Delivered`, limitation de débit (`limiter`) avec gigue et plafond journalier, documentation complète du câblage SMS.

## Tâches en Cours / Immédiates
- [x] Parcours exhaustif et analyse continue de chaque document, fichier et commit du projet.
- [x] Création et initialisation du système Memory Bank (`projectbrief.md`, `techContext.md`, `systemPatterns.md`, `activeContext.md`, `progress.md`).
- [x] Rédaction et publication de l'Audit Complet et Approfondi du Projet (`audit_complet_ndank.md`).
- [ ] **Chantier SMS v0.18.0** : Implémentation de la file d'attente SMS et de la route de long-polling (flux inversé).
- [ ] **Sécurité Liens** : Ajustement de la durée de validité des liens calculée par palier (intervalle inter-relances).



## Roadmap Future & Pistes d'Évolution
- [ ] **Intégrations Opérateurs en Direct (Niveau 3.1)** :
  - Implémentation réelle de l'adaptateur Wave Business (dès obtention des accès API marchands).
  - Implémentation de l'adaptateur Orange Money Web Payment (dès validation des contrats de licence développeur Orange).
- [ ] **Passerelles SMS Régionales (Niveau 3.2)** :
  - Intégration directe d'Orange SMS API et d'Africa's Talking SMS pour offrir des alternatives managées à Twilio en Afrique de l'Ouest.
- [ ] **Traitement Asynchrone par File de Messages** :
  - Adaptateur optionnel pour déporter l'émission des relances et invitations de paiement dans un worker asynchrone (ex: Redis / BullMQ) pour les bases de données dépassant 50 000 abonnés actifs.
- [ ] **Amélioration de l'ordonnancement en cas de plafond de relance** :
  - Gestion d'une file prioritaire basée sur la criticité des paliers (ex: relancer prioritairement les abonnés à J-1 et J+7 plutôt que J-7 en cas de saturation de quota journalier).
