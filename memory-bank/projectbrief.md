# Project Brief — Ndank

## Vision et Contexte
**Ndank** (du wolof *« doucement, pas à pas »*) est une bibliothèque logicielle et un moteur métier TypeScript pur conçus pour gérer les abonnements et paiements récurrents dans le contexte africain, plus spécifiquement en Afrique de l'Ouest et Centrale (zones UEMOA / CEMAC, devises XOF, XAF, GHS, NGN, KES, etc.).

### Le Problème Fondamental Résolu
En Afrique, le mode de paiement dominant pour les particuliers et professionnels est le **Mobile Money** (Orange Money, Wave, MTN MoMo, Moov, Djamo). 
Contrairement aux cartes bancaires (SEPA, Stripe, Visa/Mastercard) :
1. **Le Mobile Money ne permet pas le débit automatique récurrent direct (« pull » sans consentement à chaque échéance)** : il n'y a pas d'autorisation récurrente réutilisable (`reusable = true`). Chaque prélèvement nécessite une validation manuelle sur le téléphone de l'abonné (saisie d'un code PIN / validation USSD / notification dans l'app).
2. **Le recouvrement repose sur la relance programmée (« push »)** : plutôt que de prélever dans le dos de l'abonné, le système doit orchestrer une échelle d'avertissements et de liens de paiement signés, périssables et inviolables.
3. **Le découplage des horloges** : il existe une séparation nette entre la date d'échéance contractuelle (`echeance`) et la date de coupure de service (`accesJusquA`), séparées par une période de grâce (7 jours par défaut) et une période de reprise (30 jours par défaut).

## Périmètre et Capacités (Scope)
- **Cœur fonctionnel pur (Niveau 1)** : Moteur de cycle, gestion des états déduits sans colonne d'état, calcul d'échéances sans flottants, réconciliation de paiements partiels (crédit vs prorata), encodage GSM-7 / UCS-2 avec repli sans dégradation du lien, génération de liens signés HMAC-SHA256 (base64url, 96 bits de sceau tronqué pour tenir dans 1 SMS).
- **Adaptateur de persistance (Niveau 2)** : Schéma Prisma multi-tenant (`Projet`, `Offre`, `Abonne`, `Abonnement`, `Relance`, `Invitation`, `Versement`, `WebhookRecu`, `Evenement`, `Passage`), adaptateur structurel sans dépendance directe à `@prisma/client`.
- **Intégration d'infrastructure (Niveau 3)** :
  - **Encaissement** : Flutterwave (v3), Paystack (avec conversion de centièmes 100x), MTN MoMo Collections (UUID déterministes, cache de jeton porteur), et fondations typées pour Wave, Orange Money, Moov, Djamo.
  - **Envoi multi-canal** : Courriel (Resend, Brevo), SMS (Twilio, Passerelle Android locale/cloud avec accusé réel `Delivered`), Push (Expo), limiteur de débit et cadence anti-détection d'opérateur pour SIM.
  - **Interface & Pages abonnées** : Page de validation de renouvellement HTML pur sans JavaScript (zéro dépendance externe, CSP stricte, non indexable, résistant aux proxys 3G/USSD), Checkout public d'abonnement.
  - **API Tableau de bord** : Routeur de lecture seule en temps constant (`routeurApi`) et routeur de gestes manuels mutateurs protégé avec en-tête `X-Ndank-Auteur` (`routeurGestes`).
  - **Surveillance & Télémétrie** : Battements de cœur (`battement`), signaux multi-niveaux (`sante`), journalisation tamponnée en base (`journal`).

## Utilisateurs Cibles et Cas d'Usage
- **Éditeurs SaaS et services numériques en Afrique** : Écoles, logiciels de gestion, médias en ligne, plateformes d'apprentissage voulant facturer mensuellement ou trimestriellement des abonnés par Mobile Money.
- **Développeurs TypeScript / Node.js** : Intégrateurs cherchant un moteur éprouvé sur le terrain évitant les pièges des fuseaux horaires, des centièmes de francs CFA, et des déconnexions d'abonnés dues à des crons manqués.

## Modèle Métier et Philosophie de Conception
- **Zéro dépendance d'exécution** (`dependencies: {}`) : ni Prisma, ni Express, ni bibliothèque tierce dans le bundle de production.
- **Zéro état stocké** : L'état d'un abonnement n'est jamais une colonne en base de données. Il est déduit en temps réel des dates civiles UTC (`ACTIVE`, `A_RENOUVELER`, `SUSPENDUE`, `EXPIREE`, `RESILIEE`).
- **Paiements partiels supportés** : Les abonnés peuvent verser en plusieurs fois ; le système applique soit une politique de `CREDIT` (déduit du reste à payer), soit de `PRORATA` (achète des jours de service proportionnels).
- **Empirisme du terrain** : Chaque particularité technique découle d'expérimentations sur les vraies API (tableau de bord Paystack, API Flutterwave v3, passerelle Android locale).
