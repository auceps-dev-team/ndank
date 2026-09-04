repo: auceps-dev-team/ndank
branch: main
path: src

## Last sync

date: 2026-09-03T10:44:20Z

### Updated in this project

- Créé `Ndank.dc.html` : les 12 écrans (marchand + abonné) en un seul Design Component.
- Timeline du cycle J−7 → J+7 dérivée de `PALIERS` (canaux et coûts réels).
- Écrans « Paramètres du cycle » et « Journal » calqués sur `graceJours`, `repriseJours`, `PREAVIS_JOURS` dérivé et `bilan.echecs`.
- États d'abonnement (ACTIVE / A_RENOUVELER / SUSPENDUE / EXPIREE / RESILIEE) utilisés tels quels dans l'UI.

## Screen map

| Écran (dans Ndank.dc.html) | Fichiers source |
|---|---|
| Tableau de bord (vues A et B) | src/etats.ts, src/moteur.ts, README.md |
| Abonnés · Fiche abonné | src/etats.ts, src/cycle.ts |
| Plans & tarifs | src/cycle.ts (Cadence, JOURS_DE_CADENCE) |
| Revenus & encaissements | src/moteur.ts |
| Journal des relances | src/moteur.ts (bilan.echecs), src/etats.ts (Geste) |
| Paramètres du cycle | src/cycle.ts (Reglages), src/etats.ts (PALIERS, PREAVIS_JOURS, relancesAnnoncees) |
| Page de paiement · Checkout public | README.md, src/moteur.ts (finaliserRenouvellement) |
| Mes abonnements (abonné) | src/etats.ts (relancesAnnoncees), src/cycle.ts |
| Onboarding marchand · Connexion | README.md |
