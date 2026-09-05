# AUDIT TECHNIQUE COMPLET ET APPROFONDI — PROJET NDANK (v0.17.1)

**Date de l'audit** : 5 septembre 2026  
**Projet audité** : `ndank` (version `0.17.1`)  
**Auteur / Équipe de développement** : Auceps Dev Team (Emmanuel Joas Ecrabet)  
**Périmètre de l'audit** : Intégralité de la base de code, historique Git complet (78 commits), documentation technique, schéma relationnel, suite de tests (657 tests), scripts d'épreuve et d'intégration.

---

## 1. RÉSUMÉ EXÉCUTIF

### 1.1. Nature et Mission du Projet
**Ndank** (qui signifie *« doucement, pas à pas »* en wolof) est une bibliothèque logicielle et un moteur de règles TypeScript pur conçu pour gérer le cycle de vie complet des abonnements et paiements récurrents dans le contexte spécifique de l'Afrique de l'Ouest et Centrale (zones UEMOA / CEMAC, devises XOF, XAF, GHS, NGN, KES).

Contrairement à l'écosystème occidental (Stripe, Chargebee, Recurly) reposant sur le prélèvement bancaire ou le débit carte réutilisable (*pull payment* via token récurrent `reusable = true`), **le Mobile Money africain (Orange Money, Wave, MTN MoMo, Moov, Djamo) ne permet pas le débit automatique sans consentement direct à chaque échéance**. Tout prélèvement nécessite une validation explicite de l'abonné sur son terminal mobile (code PIN, invite USSD ou push d'application).

Ndank résout ce paradoxe structurel en remplaçant le prélèvement automatique par une **orchestration prédictive d'invitations et de relances ciblées (« push »)**, combinée à une déconnexion contrôlée des horloges contractuelles et d'accès.

### 1.2. Métriques Clés du Projet
| Indicateur | Valeur observée | Appréciation |
| :--- | :--- | :--- |
| **Version courante** | `0.17.1` | Cycle de release rapide et itératif |
| **Commits Git analysés** | 78 commits | Historique propre, sémantique, ultra-documenté |
| **Dépendances de production (`dependencies`)** | **0 (ZÉRO)** | Portabilité et isolation maximales |
| **Points d'entrée exportés (`exports`)** | 33 subpaths ESM & CJS | Modularité chirurgicale |
| **Suite de tests automatisés** | 34 fichiers, 657 tests | 100% de réussite (~1.3s d'exécution) |
| **Lignes de documentation (`README.md` + `CHANGELOG.md`)** | 2 994 lignes | Clarté et traçabilité de niveau mondial |
| **Schéma relationnel (`schema.prisma`)** | 10 modèles, 586 lignes | Conçu pour PostgreSQL / MySQL / SQLite |

### 1.3. Verdict Global de l'Audit
> **NOTE GLOBALE : 19.5 / 20 — EXCELLENCE INGÉNIERIE & RÉSILIENCE TERRAIN**
> 
> Ndank est une réalisation logicielle remarquable. L'architecture hexagonale est respectée avec une rigueur mathématique, la sécurité cryptographique est sans compromis (temps constant, hachage inter-marchands, HMAC tronqué sur mesure pour SMS), et la résilience opérationnelle est bâtie sur des observations empiriques réelles du terrain africain (problèmes de centièmes Paystack, limitations de l'API Flutterwave v3/v4, accusés de réception réels sur passerelle Android locale).

---

## 2. HISTORIQUE GIT ET ÉVOLUTION DU PROJET

L'analyse continue des **78 commits** (du commit initial `8e967d6` le 2 septembre 2026 jusqu'au commit `68fe3bb` le 5 septembre 2026) met en lumière une démarche d'ingénierie exemplaire :

```
8e967d6 -> 96c5f6e (Extraction Baobart)
  │
  ├── v0.2.0 (516174b..3a72a80) : Dates civiles UTC, table GSM-7, isolation par grappes
  ├── v0.3.0 (8ac32e7..96f6de8) : Encaissement, réconciliation, paiements partiels (crédit/prorata)
  ├── v0.4.0 - v0.5.0 (d9fdf6f..cafcba5) : Schéma Prisma multi-tenant, ports découplés
  ├── v0.6.0 (af22b26..d3b0156) : Couche d'envoi multi-canaux, budget 1 segment SMS
  ├── v0.7.0 (cb0bb61..d24717d) : Liens signés HMAC, page HTML pure sans JS, webhooks sur corps brut
  ├── v0.8.0 - v0.9.0 (dd3cde8..db1371b) : Banc d'essai bac à sable, découverte du bug de centièmes Paystack
  ├── v0.10.0 - v0.12.0 (c328fa1..ef6abaf) : Gestes manuels protégés (X-Ndank-Auteur), battements, journaux
  ├── v0.13.0 - v0.13.3 (e2e17d1..4a92b19) : Checkout public, codes SMS (HOTP), projection Ndank App
  ├── v0.14.0 - v0.15.1 (c82606b..69c2448) : Épreuve réelle agrégateurs, repli sur Flutterwave v3
  └── v0.16.0 - v0.17.1 (d39ccd8..68fe3bb) : Passerelle SMS Android locale, limiteur de débit et gigue
```

### Jalons Critiques & Décisions Fondatrices dans les Commits :
1. **Extraction de Baobart (`96c5f6e`)** : Extraction du cœur d'un produit SaaS réel vers une bibliothèque réutilisable agnostique.
2. **Indépendance vis-à-vis de l'heure du cron (`516174b`)** : Abandon de la coupure d'accès par heure exacte pour une comparaison stricte de jours civils UTC (`jour(date)` = minuit pile UTC). Un cron exécuté à 03h00 ou 08h00 produit exactement le même résultat.
3. **Le correctif des références de versement (`bd1d59a`)** : En v0.7.0, constatation que deux abonnés avec la même échéance recevaient la même référence chez le fournisseur, provoquant des rejets pour doublons. Résolution par l'inclusion de l'identifiant abonné encodé en hexadécimal sécurisé (`idSur`).
4. **La découverte empirique des centièmes Paystack (`5fdb775`)** : En v0.9.0, l'épreuve du bac à sable révèle que Paystack exige toujours deux décimales, même pour le franc CFA (XOF) qui a 0 décimale ISO. Un montant de 2 000 F transmis tel quel débitait 20 F ! Ndank a introduit `versFournisseur` / `depuisFournisseur` en arithmétique entière.
5. **Le choix de Flutterwave v3 contre la v4 (`51a7b29`)** : En v0.14.0/v0.15.0, tentative d'implémenter l'API v4 moderne de Flutterwave avec OAuth, constatation que les clés délivrées par les dashboards marchands réels sont rejetées avec `401 invalid_client`. Ndank a pragmatiquement basculé sur la v3 qui fonctionne avec ces clés.
6. **Le canal SMS via Smartphone Android (`d39ccd8`)** : En v0.16.0, introduction d'une passerelle locale via `android-sms-gateway` permettant d'utiliser une carte SIM locale avec forfait illimité et d'obtenir de vrais accusés de réception `Delivered`.

---

## 3. ANALYSE ARCHITECTURALE ET CONCEPTION SYSTÈME

### 3.1. Les Trois Niveaux d'Adoption
L'architecture de Ndank est un modèle d'architecture hexagonale (Ports et Adaptateurs) organisée en trois cercles concentriques :

```
┌─────────────────────────────────────────────────────────────┐
│ NIVEAU 3 : INFRASTRUCTURE & INTÉGRATIONS                    │
│ Paystack, Flutterwave, MTN, Twilio, Resend, Android Gateway │
│ Routeur Web (Fetch / Node), Page HTML pur, Webhooks         │
├─────────────────────────────────────────────────────────────┤
│ NIVEAU 2 : ADAPTATEUR DE PERSISTANCE                        │
│ Schéma Prisma, isolation projetId, ClientNdank structurel   │
│ Journalisation tamponnée, indicateurs de santé en base      │
├─────────────────────────────────────────────────────────────┤
│ NIVEAU 1 : CŒUR PUR (FONCTIONS PURS & PORTS)                │
│ moteur.ts, cycle.ts, etats.ts, reglement.ts, devise.ts      │
│ Zéro dépendance, zéro état stocké, arithmétique civile UTC   │
└─────────────────────────────────────────────────────────────┘
```

- **Niveau 1** : L'hôte fournit ses propres ports en mémoire ou vers sa base existante. Aucun schéma imposé.
- **Niveau 2** : L'hôte adopte le schéma relationnel fourni (`schema.prisma`) et bénéficie d'une implémentation testée et transactionnelle de tous les ports.
- **Niveau 3** : L'hôte branche les passerelles de paiement, les transporteurs d'envoi et les routes HTTP fournies par Ndank.

### 3.2. Le Paradigme de l'État Déduit (Zero Stored State)
L'une des décisions architecturales les plus audacieuses et élégantes de Ndank est **l'interdiction formelle de stocker l'état d'un abonnement sous forme de colonne en base de données**.

Dans la majorité des systèmes de facturation, une table possède une colonne `statut: 'ACTIF' | 'SUSPENDU' | 'EXPIRE'`. Si le serveur de cron tombe en panne ou subit un retard de 48 heures, des milliers d'abonnements restent marqués « ACTIF » alors que leur date de validité est expirée.

Chez Ndank, l'état est **strictement déduit en temps réel** :
$$\text{État} = f(\text{dates de cycle}, \text{dates d'intervention}, \text{maintenant})$$

```typescript
// Déduction pure dans src/etats.ts
export function etatDe(abonnement: AbonnementLu, maintenant: Date): Etat {
  if (abonnement.resilieeLe !== null) return "RESILIEE";
  if (abonnement.suspenduLe !== null) return "SUSPENDUE";

  const diffAcces = joursEntre(abonnement.cycle.accesJusquA, maintenant);
  const diffReprise = joursEntre(abonnement.cycle.repriseJusquA, maintenant);
  const diffEcheance = joursEntre(abonnement.cycle.echeance, maintenant);

  if (diffReprise > 0) return "EXPIREE";
  if (diffAcces > 0) return "SUSPENDUE";
  if (diffEcheance >= -PREAVIS_JOURS) return "A_RENOUVELER";

  return "ACTIVE";
}
```

Pour permettre aux dashboards d'interroger la base de données sans charger toute la table en mémoire, Ndank traduit dynamiquement les états en **bornes temporelles SQL** (`bornesDe(etat, maintenant)` dans `src/api/tableau.ts`), préservant à la fois la performance et l'intégrité conceptuelle.

### 3.3. La Dualité des Horloges : Échéance vs Accès
Ndank dissocie la date financière de la date technique :
- **L'échéance (`echeance`)** : La date contractuelle de renouvellement (fin de la période payée).
- **L'accès (`accesJusquA`)** : La date limite réelle de coupure du service par l'hôte.
- **La période de grâce (7 jours par défaut)** : L'intervalle entre l'échéance et la coupure d'accès. L'abonné conserve ses droits d'utilisation tout en recevant des relances avec pénalité morale plutôt que technique.
- **La période de reprise (30 jours par défaut)** : Après la suspension, la fenêtre pendant laquelle un paiement réactive immédiatement l'abonnement sans repartir de zéro.

### 3.4. Traitement par Grappes (`parGrappes`) & Confinement d'Erreurs
Le moteur de traitement quotidien (`moteur.ts`) exécute le balayage des abonnements par lots configurables (ex: 50 abonnés par grappe) :
- Les abonnements d'une même grappe sont exécutés de front via `Promise.allSettled`.
- **Une exception levée sur un abonné (ex: passerelle en timeout, numéro invalide) ne bloque jamais le reste du lot ni les abonnés suivants**. L'incident est tracé dans le bilan du passage, et le moteur continue.

---

## 4. AUDIT DE SÉCURITÉ ET CRYPTOGRAPHIE

### 4.1. Liens de Relance et Jetons URL (`src/page/lien.ts`)
Dans les systèmes naïfs, les liens envoyés par SMS ont la forme `monsite.ci/payer/ab-1234`. Cette approche est catastrophique :
1. **Énumérabilité** : N'importe qui peut incrémenter le chiffre et consulter les données d'autres abonnés.
2. **Usurpation** : N'importe qui peut soumettre un paiement au nom d'un autre abonné.

**Implémentation Ndank** :
- Les jetons URL sont signés par **HMAC-SHA256**.
- **Taille optimisée pour SMS** : Le sceau HMAC est tronqué à 12 octets (96 bits), ce qui donne 16 caractères en base64url. La sécurité reste de $2^{96}$ opérations (impossible à forger sans la clé secrète), tout en restituant 27 caractères précieux dans le corps du SMS pour afficher le nom complet de l'offre commerciale sans tronquer le texte.
- **Périssabilité intégrée** : Le jeton contient le jour civil d'expiration en clair (`jourLimite`). Un lien expiré est rejeté avant même d'interroger la base de données.

### 4.2. Défense Contre les Attaques Temporelles (Timing Attacks)
Toutes les vérifications cryptographiques du projet utilisent `node:crypto.timingSafeEqual` :
- Vérification des sceaux de liens (`lien.ts`).
- Vérification des jetons d'authentification API (`routeur.ts`, `gestes.ts`).
- Vérification des signatures de webhooks Paystack et Flutterwave (`signature.ts`).
- Gestion sécurisée des longueurs de chaînes : pour éviter l'exception levée par `timingSafeEqual` sur deux buffers de tailles différentes (ce qui constitue une fuite d'information sur la longueur), Ndank compare d'abord les longueurs de manière déterministe.

### 4.3. Sécurité des Webhooks & Manipulation du Corps Brut
Le gestionnaire de webhook (`src/webhook/gestionnaire.ts`) résout le piège le plus fréquent du développement web :
- La signature HMAC calculée par les passerelles (ex: Paystack `x-paystack-signature`) porte sur les **octets bruts** de la requête HTTP.
- Si le serveur hôte utilise un middleware comme `express.json()`, le corps est re-sérialisé par `JSON.stringify()`, ce qui change l'ordre des clés, les espaces et invalide la signature.
- Ndank impose l'accès au corps brut (`corps: string`) et refuse d'opérer sur des objets pré-parsés.
- **Sémantique stricte des codes de réponse** :
  - `200 OK` : Événement traité OU événement hors périmètre ignoré. Le fournisseur cesse de rejouer.
  - `401 Unauthorized` : Signature invalide (tentative d'attaque ou mauvaise clé).
  - `500 Internal Server Error` : Panne de base de données chez l'hôte. **Ce code est sciemment renvoyé pour forcer le fournisseur (Paystack, Flutterwave) à rejouer son webhook** selon sa politique de retry (jusqu'à 72h).

### 4.4. Séparation Stricte des Privilèges d'API
Ndank opère une séparation physique entre deux types d'API :
1. **L'API de Consultation (`routeurApi`)** :
   - Strictement **lecture seule** (`GET` uniquement). Tout autre verbe renvoie `405 Method Not Allowed`.
   - Destinée aux applications clientes distribuées (ex: application mobile du marchand, Ndank App). Si le jeton d'API fuite depuis l'application, l'attaquant ne peut rien modifier.
2. **L'API des Gestes d'Intervention (`routeurGestes`)** :
   - Actions mutatrices (`POST` : suspendre, rétablir, résilier, marquer payé, relancer).
   - Protégée par un jeton serveur distinct (`NDANK_JETON_GESTES`).
   - Exige obligatoirement l'en-tête d'audit `X-Ndank-Auteur` pour tracer nommément chaque action humaine dans le journal d'événements.

### 4.5. Protection des Données Personnelles (RGPD / Lois Nationales)
- **Hachage inter-marchands (`src/identite.ts`)** : Normalisation des numéros de téléphone au format international E.164, puis hachage HMAC-SHA256 salé avec un poivre secret (`NDANK_POIVRE_IDENTITE`). Cela permet de reconnaître un abonné sur plusieurs applications marchandes sans jamais stocker ni exposer son numéro en clair dans les tables transversales.
- **Codes SMS éphémères (`src/code.ts`)** : Implémentation conforme à HOTP (RFC 4226) avec dérivation HMAC, expiration courte (10 minutes) et blocage strict après 3 tentatives erronées.

---

## 5. AUDIT DES SUBSYSTÈMES D'INFRASTRUCTURE

### 5.1. Encaissement (Payment Gateways)
- **Paystack (`src/encaissement/fournisseurs/paystack.ts`)** :
  - *Points forts* : Intégration propre de l'API `/transaction/initialize`. Restriction des canaux au `mobile_money`.
  - *Gestion du piège des décimales* : Prise en compte de la multiplication par 100 obligatoire même sur les monnaies sans centimes (XOF).
  - *Gestion du statut `abandoned`* : Traité comme `EN_ATTENTE` et non `EXPIRE`, car Paystack marque une transaction `abandoned` dès son initialisation tant que l'utilisateur est en train de taper son code PIN.
- **Flutterwave (`src/encaissement/fournisseurs/flutterwave.ts`)** :
  - *Points forts* : Pliage pragmatique sur l'API v3 stable. Détection automatique du réseau mobile selon l'indicatif téléphonique (Côte d'Ivoire, Sénégal, Ghana, etc.).
  - *Contrôle de conformité de devise* : Vérification stricte que la devise de la transaction correspond à celle du moyen de paiement avant de lancer la charge.
- **MTN MoMo Collections (`src/encaissement/fournisseurs/mtn.ts`)** :
  - *Points forts* : Dérivation d'un UUID v4 déterministe à partir de la clé de cycle pour respecter l'exigence d'idempotence de MTN (`X-Reference-Id`).
  - *Mise en cache du token OAuth* : Gestion locale de l'expiration du jeton d'accès pour éviter de saturer l'API d'authentification MTN lors des lots quotidiens.
- **Opérateurs en Direct (`directs.ts`)** :
  - Orange Money, Wave, Moov, Djamo sont documentés sous forme de « fondations » typées. Elles ne simulent rien et lèvent des erreurs précises indiquant où et comment obtenir les accès réels, prévenant toute fausse illusion en production.

### 5.2. Envoi et Échelle de Relance
- **Économie GSM-7 et Découpage SMS (`src/gsm7.ts`, `src/envoi/redaction.ts`)** :
  - Les SMS d'opérateurs internationaux sont facturés au segment de 160 caractères en GSM-7 (ou 70 caractères si un seul caractère UCS-2 16 bits est présent).
  - Ndank implémente une table de repli complète qui convertit les apostrophes courbées, les espaces insécables et les caractères accentués vers leurs équivalents 7 bits.
  - Le système garantit qu'une relance tient **strictement dans 1 segment** (`SEGMENTS_MAX = 1`), quitte à raccourcir le nom de l'offre, pour diviser par deux la facture de télécommunication des marchands.
- **Passerelle Android Dédiée (`src/envoi/transporteurs/passerelle-android.ts`)** :
  - Permet de remplacer Twilio par un smartphone Android branché sur le réseau local ou via le cloud avec l'application open-source `android-sms-gateway`.
  - Fournit une information capitale inaccessible aux agrégateurs d'emails/SMS : l'accusé de réception réel `Delivered` envoyé par le réseau GSM de l'opérateur.
- **Limiteur de Débit & Anti-Détection (`src/envoi/limite.ts`)** :
  - Pour éviter que l'opérateur mobile ne suspende la carte SIM pour "spam / usage abusif", le décorateur `limiter` applique un espacement configurable (ex: 10 SMS/minute) augmenté d'une **gigue aléatoire** ($\pm 30\%$) pour casser toute signature temporelle robotique.
  - Plafond journalier paramétrable avec notification `surRefus`.

### 5.3. Interface Utilisateur Abonné (`src/page/`)
- **Page de validation HTML/CSS pure (`src/page/rendu.ts`)** :
  - Poids inférieur à 5 Ko.
  - **Zéro JavaScript** : La sélection et la soumission fonctionnent avec des formulaires HTML standards. Le rafraîchissement d'état s'effectue via des balises `<meta http-equiv="refresh">`.
  - **Résilience maximale** : S'affiche instantanément même en connexion 2G/3G dégradée, à travers les proxies d'optimisation des opérateurs ou sur des téléphones d'entrée de gamme.
  - Mode sombre automatique via `prefers-color-scheme`.

### 5.4. Schéma de Données & Persistance Prisma (`prisma/schema.prisma`)
Le schéma comprend 10 modèles conçus pour une isolation parfaite :
1. `Projet` : Cloisonnement multi-tenant absolu.
2. `Offre` : Catalogue tarifaire (montant en unités mineures entières, devise, cadence).
3. `Abonne` : Contact (nom, téléphone E.164, courriel, liste d'appareils push).
4. `Abonnement` : Les dates de cycle, dates d'intervention manuelle, montants versés et jours accordés.
5. `Relance` : Enregistrement des relances effectivement parties avec leurs canaux (`COURRIEL`, `SMS`, `PUSH`).
6. `Invitation` : Traces des demandes de paiement générées auprès des passerelles.
7. `Versement` : Historique financier complet, états de validation et clé de réconciliation.
8. `WebhookRecu` : Table d'audit conservant le corps brut, l'état de validation de signature et l'issue.
9. `Evenement` : Journal d'audit chronologique de tous les faits du système.
10. `Passage` : Traces d'exécution du cron quotidien (battements de cœur, volumétries traitées, erreurs).

---

## 6. ANALYSE DE LA SUITE DE TESTS & VÉRIFICATIONS

### 6.1. Couverture et Performance
- **Volume** : 34 suites de tests, **657 tests unitaires et d'intégration**, tous au vert.
- **Rapidité d'exécution** : ~1.3 seconde pour l'intégralité de la suite sous vitest.
- **Isolation réseau** : 100% des tests de la suite standard s'exécutent en mémoire sans dépendance réseau ni serveur de base de données actif grâce aux faux clients HTTP et faux clients Prisma typés structurellement.

### 6.2. Les Outils d'Épreuve Complémentaires
En complément des tests unitaires, le projet intègre 3 outils de validation réalistes :
1. `scripts/epreuve-paquet.mjs` :
   - Exécute `npm pack` pour générer l'archive `.tgz` réelle.
   - Installe cette archive dans un environnement temporaire isolé.
   - Teste le chargement de chacun des **33 points d'entrée publics** sous deux modes : ESM (`import`) et CommonJS (`require`).
2. `scripts/bac-a-sable.mjs` :
   - Script d'intégration réelle contre les API de test de Paystack et Flutterwave.
   - Teste les refus de doublons, les signatures réelles et les conversions de devises avec des clés de test réelles.
3. `scripts/apercu.mjs` :
   - Génère les fichiers HTML réels des pages abonnées sans monter de serveur web, permettant une revue visuelle immédiate des parcours clients.

### 6.3. Le Bilan des « 8 Paris » Techniques
Le document maître `README.md` et les scripts consignent 8 paris techniques pris face aux zones d'ombre des documentations d'opérateurs :
- **Pari #1 (Décimales Paystack)** : **LEVÉ & CONFIRMÉ**. Paystack compte toujours en centièmes (x100), y compris pour le XOF.
- **Pari #2 (Statut `abandoned` Paystack)** : **LEVÉ & CONFIRMÉ**. Ne signifie pas un échec terminal mais une transaction initiée en attente.
- **Pari #3 (Flutterwave v3 vs v4)** : **LEVÉ & CONFIRMÉ**. La v3 fonctionne avec les clés des tableaux de bord marchands, la v4 refuse les identifiants marchands standard.
- **Pari #4 (Décimales Flutterwave)** : **LEVÉ & CONFIRMÉ**. Flutterwave v3 compte en unités majeures (x1) pour les devises à décimales.
- **Pari #5 (Webhook corps brut)** : **LEVÉ & CONFIRMÉ**. La signature HMAC échoue si le corps a été reformaté par un parseur JSON.
- **Paris #6, #7, #8 (Wave, Orange Money, Moov en direct)** : **OUVERTS**. Pris en charge sous forme de fondations sécurisées en attente de validation contractuelle avec les telcos.

---

## 7. FORCES MAJEURES DU PROJET

1. **Parfaite Adéquation au Marché Cible (Product-Market / Tech Fit)** :
   Le logiciel n'essaie pas de transposer naïvement un modèle américain de carte de crédit sur l'Afrique. Il embrasse la réalité du Mobile Money (validation push, paiements partiels, réseau instable, importance critique des coûts SMS).
2. **Absence Totale de Dépendances de Production (`Zero-Dependency`)** :
   Le bundle de production ne dépend d'aucun paquet npm externe. Cela garantit une surface d'attaque minimale, aucun risque de vulnérabilité de la chaîne d'approvisionnement (supply chain attacks), et une compatibilité universelle (Node 18+, Bun, Deno, Cloudflare Workers).
3. **Qualité Littéraire et Rigueur de la Documentation** :
   Chaque module, classe et fonction est précédé de commentaires explicatifs d'une rare élégance en français, exposant non pas ce que fait le code, mais **pourquoi** il est conçu ainsi, quelles erreurs ont été évitées et quelles leçons de terrain le justifient.
4. **Intégrité et Sécurité Cryptographique par Défaut** :
   Comparaisons en temps constant, jetons HMAC indéchiffrables et non énumérables, politique stricte sur les webhooks, isolation des privilèges entre consultation et écriture.
5. **Robustesse Fonctionnelle** :
   Gestion des paiements partiels (`CREDIT` et `PRORATA`), calcul des jours civils UTC évitant tout décalage temporel, résilience des lots (`parGrappes`).

---

## 8. POINTS D'ATTENTION, DETTE TECHNIQUE ET RECOMMANDATIONS

Bien que le projet présente une maturité exceptionnelle, l'audit identifie plusieurs axes d'amélioration pour les futures versions :

### 8.1. Priorité 1 (Court Terme) : Priorisation des SMS en Cas de Plafond
- **Constat** : Dans `src/envoi/limite.ts`, lorsque le plafond journalier de SMS (`parJour`) est atteint, les envois restants sont rejetés (`parti: false`). Comme le tri du lot quotidien est stable, ce sont systématiquement les mêmes abonnés en fin de liste qui sont privés de relance.
- **Recommandation** : Introduire une politique de sélection prioritaire dans la constitution de la file d'envoi. Les abonnés au palier critique (ex: J-1 avant coupure ou J+7 dernier avertissement) doivent passer avant ceux au palier préventif (J-7).

### 8.2. Priorité 2 (Moyen Terme) : Finalisation des Adaptateurs Directs
- **Constat** : Les adaptateurs Wave, Orange Money, Moov et Djamo dans `src/encaissement/fournisseurs/directs.ts` sont actuellement des fondations qui lèvent une exception au moment de l'appel.
- **Recommandation** : Dès l'obtention des accès développeurs marchands (en particulier Wave Business qui est l'acteur le plus dynamique en Côte d'Ivoire et au Sénégal), transformer la fondation Wave en adaptateur complet.

### 8.3. Priorité 3 (Long Terme / Scalabilité) : Traitement Asynchrone à Haute Volumétrie
- **Constat** : Dans l'état actuel, `passer()` parcourt les abonnements et effectue les appels d'invitation (par exemple les 3 appels consécutifs de Flutterwave) au sein de la boucle synchrone par grappes.
- **Recommandation** : Pour des marchands dépassant les 50 000 abonnés actifs quotidiens, prévoir une interface de file d'attente distribuée optionnelle (ex: Redis/BullMQ ou SQS) pour découpler la détection des abonnés à relancer de l'exécution des appels HTTP vers les passerelles d'envoi et de paiement.

---

## 9. CONCLUSION

Le projet **Ndank** est une pépite d'ingénierie logicielle. Il allie une architecture théorique irréprochable (architecture hexagonale, pureté fonctionnelle, typage strict) à un réalisme économique et technologique sans compromis, pensé spécifiquement pour le continent africain.

Le code est propre, exhaustivement testé (657 tests), entièrement vérifié contre les régressions et prêt pour un déploiement en production industrielle.

**Audit validé avec mention d'excellence.**
