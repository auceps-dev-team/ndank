# System Patterns & Architecture — Ndank

## 1. Architecture Hexagonale & Séparation des Niveaux
Ndank est architecturé selon trois niveaux progressifs d'adoption :
- **Niveau 1 : Le Cœur Pur (`ndank`)** :
  - Zéro I/O, zéro framework, zéro dépendance.
  - Tout est fonction pure recevant des données et rendant une décision (`gesteDuJour`, `cycleApresPaiement`, `reconcilier`, `redigerSms`).
  - L'hôte fournit les ports (`Lecture`, `Ecriture`, `Envoi`, `Creances`).
- **Niveau 2 : L'Adaptateur Prisma (`ndank/prisma`)** :
  - Implémente tous les ports contre un schéma relationnel multi-tenant fourni (`prisma/schema.prisma`).
  - Cloisonnement strict et systématique par `projetId`.
  - Pas de dépendance directe au package `@prisma/client` : typage structurel ouvert sur `ClientNdank`.
- **Niveau 3 : L'Intégration d'Infrastructure (`ndank/encaissement`, `ndank/envoi`, `ndank/page`, `ndank/api`, `ndank/webhook`)** :
  - Adaptateurs tiers (Paystack, Flutterwave, MTN, Resend, Twilio, Android).
  - Gestionnaires de requêtes HTTP abstraits (`Request`/`Response` standard web ou Node `(req, res)` via `montage.ts`).

## 2. Décisions Fondatrices d'Ingénierie

### 2.1. L'État Déduit, Jamais Stocké
- **Problème résolu** : Dans les architectures classiques, une colonne `etat` en base devient désynchronisée dès qu'un cron plante, est retardé ou tourne deux fois.
- **Solution Ndank** : L'état d'un abonnement est une fonction pure de ses dates calendaires UTC :
  $$\text{État} = f(\text{echeance}, \text{accesJusquA}, \text{repriseJusquA}, \text{resilieeLe}, \text{suspenduLe}, \text{closLe}, \text{maintenant})$$
- Les états possibles sont strictement délimités :
  - `RESILIEE` : Résiliation manuelle actée (`resilieeLe !== null`).
  - `SUSPENDUE` : Suspension manuelle (`suspenduLe !== null`) OU l'accès a expiré (`accesJusquA < maintenant`) alors que la période de reprise reste ouverte (`repriseJusquA >= maintenant`).
  - `EXPIREE` : La période de reprise est dépassée (`repriseJusquA < maintenant`).
  - `A_RENOUVELER` : L'accès est actif (`accesJusquA >= maintenant`) et l'échéance est entrée dans la fenêtre de préavis de 7 jours.
  - `ACTIVE` : L'accès est actif et l'échéance est au-delà du préavis.

### 2.2. Les Deux Horloges (Échéance vs Accès)
- `echeance` marque la fin de la période payée (le terme contractuel).
- `accesJusquA` marque la coupure physique du service.
- Par défaut, une période de grâce de 7 jours sépare l'échéance de la coupure. Pendant la grâce, l'état est `A_RENOUVELER` (l'accès est maintenu pour éviter l'attrition brutale et donner le temps de payer).

### 2.3. L'Arithmétique Calendaire Civile UTC
- Pour éviter les décalages d'heures (passage à l'heure d'été/hiver, dérive de l'heure d'exécution du cron à 03h00 vs 05h00), tous les calculs de jours sont ramenés aux **jours civils UTC** (`jour(date)` = minuit pile UTC).
- Deux instants du même jour civil donnent `joursEntre = 0`.

### 2.4. Le Zéro Flottant Monétaire (ISO 4217)
- Ndank stocke tous les montants sous forme d'entiers en unités mineures ISO 4217 (ex: centimes, kobo, pesewas, ou francs CFA entiers sans subdivision).
- Les conversions spécifiques aux fournisseurs (Paystack qui compte en centièmes même pour XOF, Flutterwave v3 qui attend des unités majeures) sont encapsulées hermétiquement dans chaque adaptateur via `versFournisseur` et `depuisFournisseur`.

### 2.5. L'Idempotence et la Structure des Références
- Les références de versement encodent l'échéance, le numéro de tentative et l'abonnement :
  $$\text{ref} = \text{YYYYMMDD} - \text{numéro} - \text{idSur(abonnementId)}$$
- `idSur` encode en hexadécimal tout identifiant contenant des caractères hors de `[A-Za-z0-9-]` pour respecter la politique la plus stricte (Paystack).
- Déduplication obligatoire via `Creances.dejaCompte(versementId)` pour neutraliser les rejeux automatiques de webhooks.

### 2.6. Sécurité Cryptographique & Protection des Données
- **Liens signés base64url** : Jeton composé de `abonnementId + jourLimite + sceau HMAC-SHA256 (12 octets / 96 bits)`.
- **Comparaisons en temps constant** : Utilisation de `crypto.timingSafeEqual` pour tous les jetons d'API, gestes d'intervention et signatures de webhooks afin de prévenir les attaques par canal auxiliaire (timing attacks).
- **Hachage inter-marchands** : Normalisation E.164 + HMAC-SHA256 avec poivre secret pour réconcilier l'historique d'un utilisateur entre marchands sans exposer son numéro de téléphone.
- **Codes de connexion SMS (HOTP)** : RFC 4226 avec troncature dynamique, expirations courtes (10 min) et rate limiting strict (3 tentatives max, fenêtre glissante).

### 2.7. Échelle de Relance & Optimisation des Coûts
- Palier progressif : J-7, J-3, J-1, J0, J+3, J+7.
- Économie GSM-7 : Remplacement automatique des caractères Unicode non supportés (ligatures, apostrophes typographiques, espaces insécables) pour garantir qu'un SMS de relance ne dépasse jamais 1 segment (160 caractères 7 bits).
- Ordre d'essai des canaux par palier : Courriel (gratuit) -> Push (gratuit) -> SMS (payant). Le SMS n'est mobilisé que lorsque les canaux gratuits échouent ou lors des paliers critiques.
- Passerelle Android dédiée : Possibilité d'émettre des SMS via un terminal Android local équipé d'un forfait SIM local pour réduire drastiquement les coûts par rapport aux agrégateurs internationaux. Limiteur de débit avec gigue temporelle pour éviter le blocage de la carte SIM par l'opérateur.

### 2.8. Conception de l'Interface Utilisateur Abonné
- Page de validation HTML5 pure : 0 Ko de JavaScript, CSS inline épuré supportant le mode sombre (`prefers-color-scheme`), aucun appel de ressource CDN externe (évite les blocages par les proxys des telcos en 3G).
- Headers de sécurité stricts : `Cache-Control: no-store, private`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'`.
