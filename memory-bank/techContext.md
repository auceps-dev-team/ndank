# Tech Context — Ndank

## Stack Technique
- **Langage** : TypeScript 5.9+ (strict mode, noUncheckedIndexedAccess).
- **Runtime cible** : Node.js >= 18.0.0 (compatible Bun, Deno, environnements Edge / Cloudflare Workers).
- **Gestionnaire de paquets** : `npm` (avec `package-lock.json`).
- **Bundler & Packaging** : `tsup` 8.5.1 (compilation ESM `.js` + CJS `.cjs` + `.d.ts` et `.d.cts` pour 33 points d'entrée exportés).
- **Framework de test** : `vitest` 3.2.7 (34 fichiers de test, 657 tests unitaires et d'intégration, 100% de réussite en ~1.3s).
- **ORM / Persistance optionnelle** : Prisma 6.7.0 (fourni via `prisma/schema.prisma`, mais l'adaptateur `src/prisma/client.ts` utilise un typage structurel pour éviter d'imposer `@prisma/client` en production).
- **Dépendances de production** : **0 (ZÉRO)** (`dependencies: {}` dans `package.json`).
- **Dépendances de développement** : `@prisma/client`, `prisma`, `tsup`, `typescript`, `vitest`.

## Topologie du Projet
```
ndank/
├── .github/
│   └── workflows/
│       └── verifier.yml        # CI GitHub Actions (Node 18 & 20, tests, build, pack)
├── prisma/
│   └── schema.prisma           # Schéma PostgreSQL / SQLite / MySQL pour le Niveau 2
├── scripts/
│   ├── apercu.mjs              # Génération hors-ligne du rendu des pages abonnées
│   ├── bac-a-sable.mjs         # Tests réels d'intégration contre les bacs à sable (Paystack, etc.)
│   └── epreuve-paquet.mjs      # Test d'installation et d'import ESM/CJS via npm pack
├── src/
│   ├── api/
│   │   ├── gestes.ts           # Endpoints POST protégés pour actions manuelles (X-Ndank-Auteur)
│   │   ├── routeur.ts          # Routeur GET en lecture seule pour le dashboard
│   │   └── tableau.ts          # Définition des bornes temporelles et des types du tableau
│   ├── encaissement/
│   │   ├── fournisseurs/       # Adaptateurs passerelles de paiement
│   │   │   ├── directs.ts      # Fondations typées (Wave, Orange Money, Moov, Djamo)
│   │   │   ├── flutterwave.ts  # Adaptateur Flutterwave v3 (unités majeures)
│   │   │   ├── mtn.ts          # Adaptateur MTN MoMo (Collections API, tokens temporaires)
│   │   │   └── paystack.ts     # Adaptateur Paystack (unités mineures x100)
│   │   ├── port.ts             # Interface Encaissement, types Demande, Issue, Versement
│   │   ├── reconciliation.ts   # Logique de réconciliation paiement -> cycle, format des références
│   │   ├── registre.ts         # Validation de configuration et factory de fournisseurs
│   │   └── signature.ts        # Validation cryptographique timing-safe des webhooks
│   ├── envoi/
│   │   ├── transporteurs/      # Passerelles de communication
│   │   │   ├── appel.ts        # Client HTTP utilitaire pour transporteurs
│   │   │   ├── brevo.ts        # Transporteur courriel Brevo
│   │   │   ├── expo.ts         # Transporteur push mobile Expo
│   │   │   ├── fondations.ts   # Fondations typées (Orange SMS, Africa's Talking, FCM, WebPush)
│   │   │   ├── passerelle-android.ts # Passerelle SMS Android locale ou cloud (android-sms-gateway)
│   │   │   ├── resend.ts       # Transporteur courriel Resend
│   │   │   └── twilio.ts       # Transporteur SMS Twilio
│   │   ├── compose.ts          # Agrégation multi-canaux avec repli automatique (courriel/sms/push)
│   │   ├── limite.ts           # Limiteur de débit, gigue/hasard et plafond journalier
│   │   ├── port.ts             # Interface Envoi, types Message, Remise, Coordonnées
│   │   ├── redaction.ts        # Génération des templates (GSM-7 strict, push, HTML minimal)
│   │   └── registre.ts         # Factory et vérification au démarrage des transporteurs
│   ├── page/
│   │   ├── lien.ts             # Chiffrement/signature HMAC-SHA256 tronqué des jetons URL
│   │   ├── montage.ts          # Adaptateurs universels (fetch Web standard Request/Response et Node req/res)
│   │   ├── port.ts             # Types requêtes/réponses de la page abonné
│   │   ├── rendu.ts            # Moteur de template HTML pur avec CSS inline, zéro JavaScript
│   │   ├── routeur.ts          # Contrôleur GET/POST de validation et checkout
│   │   └── vue.ts              # Logique d'affichage et sélection des moyens de paiement
│   ├── prisma/
│   │   ├── adaptateur.ts       # Implémentation complète des ports Ndank sur Prisma
│   │   ├── client.ts           # Types structurels évitant la dépendance dure à @prisma/client
│   │   ├── journal.ts          # Tampon d'événements et vidage par lots (batching)
│   │   └── sante.ts            # Mesure des signaux d'intégrité en base
│   ├── webhook/
│   │   └── gestionnaire.ts     # Réception, signature brute et déduplication des webhooks
│   ├── argent.ts               # Métriques financières normalisées (MRR, encaissement, évolution)
│   ├── battement.ts            # Surveillance de l'exécution régulière du cron (heartbeat)
│   ├── code.ts                 # Codes de connexion SMS temporaires HOTP / RFC 4226 avec rate-limiting
│   ├── cycle.ts                # Arithmétique calendaire civile UTC (jours, échéances, cadences)
│   ├── devise.ts               # Multiplicateurs et exposants ISO 4217 (unités mineures entières)
│   ├── dossier.ts              # Port d'accès unifié aux informations abonné et hooks
│   ├── etats.ts                # Échelle des relances et déduction fonctionnelle des 5 états
│   ├── gsm7.ts                 # Tables de transcodage GSM 03.38 vs UCS-2 et comptage de segments
│   ├── html.ts                 # Échappement des entités HTML universel
│   ├── http.ts                 # Typage et utilitaire d'injection client HTTP pur
│   ├── identite.ts             # Normalisation E.164 et hachage HMAC inter-marchands avec poivre
│   ├── intervention.ts         # Actions manuelles (marquerPaye, suspendre, retablir, resilier)
│   ├── moteur.ts               # Boucle quotidienne de traitement par grappes (passer, parGrappes)
│   ├── offre.ts                # Validation du catalogue tarifaire et cadences
│   ├── ports.ts                # Interfaces cœurs Lecture, Ecriture, Envoi, etc.
│   ├── projection.ts           # Projection croisée des cartes abonnés vers l'application Ndank App
│   ├── reglement.ts            # Arithmétique des paiements partiels (politiques CREDIT et PRORATA)
│   ├── relances.ts             # Calcul des coûts de relance et métriques de ponctualité abonnés
│   ├── sante.ts                # Moteur d'évaluation de santé globale et diagnostics textuels
│   ├── souscription.ts         # Initialisation et création de nouveaux abonnements après paiement
│   └── web.ts                  # Abstraction unifiée requête/réponse HTTP sans dépendance
├── CHANGELOG.md                # Historique exhaustif de v0.1.0 à v0.17.1
├── LICENSE                     # Licence MIT
├── package.json                # Configuration du package, scripts et 33 exports déclarés
├── README.md                   # Documentation maîtresse approfondie (1589 lignes)
├── tsconfig.json               # Options de compilation TS
└── tsup.config.ts              # Configuration multi-formats ESM/CJS de tsup
```

## Variables d'Environnement Documentées (`.env.example`)
- **Fournisseurs de Paiement** :
  - `PAYSTACK_CLE_SECRETE` : Clé secrète `sk_...`
  - `FLUTTERWAVE_CLE_SECRETE` : Clé secrète `FLWSECK_...`
  - `FLUTTERWAVE_SECRET_WEBHOOK` : Secret de signature webhook
  - `MTN_UTILISATEUR_API`, `MTN_CLE_API`, `MTN_CLE_ABONNEMENT`, `MTN_ENVIRONNEMENT`, `MTN_BASE`
- **Transporteurs de Relance** :
  - `RESEND_CLE_API`, `RESEND_EXPEDITEUR`
  - `BREVO_CLE_API`, `BREVO_EXPEDITEUR`
  - `TWILIO_SID`, `TWILIO_JETON`, `TWILIO_EXPEDITEUR`, `TWILIO_INDICATIF`
  - `PASSERELLE_ANDROID_BASE`, `PASSERELLE_ANDROID_UTILISATEUR`, `PASSERELLE_ANDROID_MOT_DE_PASSE`
  - `EXPO_JETON_ACCES`
- **Sécurité et Liens** :
  - `NDANK_SECRET_LIENS` : Clé secrète pour le sceau HMAC des liens de validation
  - `NDANK_JETON_API` : Jeton d'authentification pour le dashboard en lecture seule
  - `NDANK_JETON_GESTES` : Jeton serveur distinct pour les actions manuelles d'intervention
  - `NDANK_POIVRE_IDENTITE` : Poivre cryptographique pour le hachage inter-marchands

## Scripts Clés
- `npm test` : Lance la suite vitest complète (mode run).
- `npm run test:watch` : Vitest en mode interactif.
- `npm run build` : Compilation `tsup` produisant les artefacts dans `dist/`.
- `npm run verifier` : Enchaîne `prisma generate`, `tsc --noEmit`, `vitest run`, `tsup` et `epreuve-paquet.mjs`.
- `npm run apercu` : Génère les rendus HTML statiques de la page abonné.
- `npm run bac-a-sable` : Exécute les requêtes réelles contre les bacs à sable Flutterwave/Paystack.
