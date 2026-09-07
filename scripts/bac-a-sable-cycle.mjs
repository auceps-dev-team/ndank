/**
 * Ndank — le chemin qui décide si un abonné garde son accès.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE SEUL QUI N'AVAIT JAMAIS TOURNÉ CONTRE UN VRAI FOURNISSEUR
 *
 * On savait demander un paiement, et on savait constater qu'il avait eu lieu.
 * On n'avait jamais prouvé qu'on en tirait les conséquences.
 *
 *     paiement confirmé → reconcilier → versement compté → échéance repoussée
 *
 * C'est ce chemin-là qui décide si quelqu'un garde son accès, et il n'avait
 * couru que contre des faux — c'est-à-dire contre ce que je crois que
 * Flutterwave répond, jamais contre ce qu'il répond.
 *
 * Ce script prend une transaction **réellement réglée** en bac à sable, la
 * relit par l'adaptateur, et la donne à `reconcilier`. La réponse du
 * fournisseur est authentique ; seul le stockage est en mémoire.
 *
 *   FLUTTERWAVE_CLE_SECRETE=FLWSECK_TEST-… node scripts/bac-a-sable-cycle.mjs
 */
import { fournisseur } from "../dist/encaissement/registre.js";
import {
  CREANCE_VIERGE,
  lireReference,
  reconcilier,
} from "../dist/encaissement/reconciliation.js";
import { ajouterJours } from "../dist/cycle.js";
import { etatDe, accesOuvert } from "../dist/etats.js";

const CLE = process.env["FLUTTERWAVE_CLE_SECRETE"] ?? "";
const REFERENCE = process.env["FLUTTERWAVE_REFERENCE"] ?? "20260905-1-essaimtob3l31";

let echecs = 0;
let passes = 0;

const verifier = (quoi, condition, detail = "") => {
  condition ? (passes += 1) : (echecs += 1);
  console.log(`  ${condition ? "✓" : "✗"} ${quoi}${!condition && detail ? ` — ${detail}` : ""}`);
};

if (CLE === "") {
  console.log("Ndank — le cycle, contre un vrai paiement");
  console.log("\nFLUTTERWAVE_CLE_SECRETE absente. Rien n'a été éprouvé.");
  process.exit(0);
}

console.log("Ndank — le cycle, contre un vrai paiement\n");

// ── 1. relire un paiement réellement réglé ────────────────────────────────
const fw = fournisseur("flutterwave", { cleSecrete: CLE, secretWebhook: "essai" }, undefined);
const issue = await fw.constater(REFERENCE);

console.log(`▸ Ce que Flutterwave rapporte de ${REFERENCE}`);
console.log(`  état     : ${issue.etat}`);
console.log(`  montant  : ${issue.montant} ${issue.devise}  (unités mineures Ndank)`);
console.log(`  réglé le : ${issue.regleLe?.toISOString() ?? "—"}\n`);

verifier("le fournisseur confirme le règlement", issue.etat === "REUSSI", issue.etat);
verifier("le montant revient en unités mineures", issue.montant === 2000, String(issue.montant));
verifier("la devise est celle demandée", issue.devise === "XOF", issue.devise);

// La référence porte l'échéance visée et l'abonnement : c'est ce qui empêche
// qu'un versement soit imputé au mauvais cycle.
const lue = lireReference(REFERENCE);
verifier("la référence se relit", lue !== null);
if (lue) {
  console.log(
    `  → cycle visé ${lue.cycle}, abonnement ${lue.abonnement}, ` +
      `versement n°${lue.numero}\n`,
  );
}

// ── 2. un abonnement en retard, tel qu'il serait en base ──────────────────
const echeance = new Date("2026-09-05T00:00:00Z");
const abonnement = {
  // L'identifiant que porte la référence réelle. Le premier passage de ce
  // script avait mis un autre id, et « reconcilier » a refusé net :
  // « versement fabriqué pour l'abonnement essaimtob3l31, présenté sur
  // abo-essai ». Le garde-fou marche, contre une vraie référence.
  id: "essaimtob3l31",
  abonneId: "usr-essai",
  cadence: "MENSUEL",
  cycle: {
    debut: ajouterJours(echeance, -30),
    echeance,
    accesJusquA: ajouterJours(echeance, 7),
    repriseJusquA: ajouterJours(echeance, 37),
  },
  resilieeLe: null,
  suspenduLe: null,
  montant: 2000,
  devise: "XOF",
  libelle: "Pass Créateur",
};

const avant = new Date("2026-09-13T00:00:00Z"); // après l'accès, dans la reprise
console.log("▸ L'abonnement avant le versement");
console.log(`  échéance : ${abonnement.cycle.echeance.toISOString().slice(0, 10)}`);
console.log(`  état     : ${etatDe(abonnement, avant)}`);
console.log(`  accès    : ${accesOuvert(abonnement, avant) ? "ouvert" : "coupé"}\n`);

verifier("l'accès est coupé avant le paiement", !accesOuvert(abonnement, avant));

// ── 3. reconcilier, contre la vraie réponse ──────────────────────────────
const comptes = new Set();
const creances = {
  async dejaCompte(id) {
    return comptes.has(id);
  },
  // `CREANCE_VIERGE` plutôt qu'un objet écrit à la main : le premier passage
  // avait oublié `joursAccordes`, et le cycle rendu portait une date invalide.
  // Le dépôt exporte cette constante exactement pour cela.
  async etat() {
    return CREANCE_VIERGE;
  },
};

const decision = await reconcilier(creances, abonnement, issue, "CREDIT");

console.log("▸ Ce que Ndank décide");
console.log(`  ${decision.faire}${decision.motif ? ` — ${decision.motif}` : ""}\n`);

// `RENOUVELER` est la décision qui achète du temps : elle porte le cycle
// suivant, déjà calculé. On ne le recalcule pas — deux calculs finiraient par
// diverger, et c'est l'abonné qui verrait la différence.
verifier("il décide de renouveler", decision.faire === "RENOUVELER", decision.faire);

if (decision.faire !== "RENOUVELER") {
  console.log(`\n${passes} vérifiées, ${echecs} en échec.`);
  process.exit(1);
}

// ── 4. le cycle avance, et l'accès rouvre ────────────────────────────────
const suivant = decision.cycle;
const apres = { ...abonnement, cycle: suivant };

console.log("▸ L'abonnement après");
console.log(`  échéance : ${suivant.echeance.toISOString().slice(0, 10)}  (+${decision.jours} j)`);
console.log(`  état     : ${etatDe(apres, avant)}`);
console.log(`  accès    : ${accesOuvert(apres, avant) ? "ouvert" : "coupé"}\n`);

verifier(
  "l'échéance est repoussée d'un mois",
  suivant.echeance.getTime() > abonnement.cycle.echeance.getTime(),
);
verifier("l'accès est rouvert", accesOuvert(apres, avant));
verifier("l'abonnement est actif", etatDe(apres, avant) === "ACTIVE", etatDe(apres, avant));

// ── 5. le rejeu ne compte pas deux fois ──────────────────────────────────
console.log("▸ Le même paiement, rejoué");
// C'est l'identifiant que la décision désigne, et non celui qu'on devine.
comptes.add(decision.versementId);
const rejeu = await reconcilier(creances, apres, issue, "CREDIT");
console.log(`  ${rejeu.faire} — ${rejeu.motif}\n`);

verifier("un versement déjà compté ne prolonge pas une seconde fois", rejeu.faire === "RIEN");

// ══════════════════════════════════════════════════════════════════════════

console.log(`${passes} vérifiées, ${echecs} en échec.`);

if (echecs > 0) {
  console.error("\nLe chemin du cycle ne tient pas.");
  process.exit(1);
}

console.log("\nLe chemin complet tient, contre une vraie confirmation Flutterwave.");
console.log("Reste non éprouvé : le webhook, qui n'a jamais été reçu.");
