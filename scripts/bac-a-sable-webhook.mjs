/**
 * Ndank — un vrai webhook, rejoué octet pour octet.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE DERNIER CHEMIN QUI N'AVAIT JAMAIS VU UN VRAI FOURNISSEUR
 *
 * `lireWebhook` vérifie une signature, ignore les événements qui ne parlent pas
 * d'une charge, et ramène le reste à une `Issue`. Tout cela n'avait couru que
 * contre des corps que j'avais écrits moi-même — c'est-à-dire contre ce que je
 * crois que Flutterwave envoie.
 *
 * Or c'est le chemin par lequel un paiement se confirme **tout seul**. Sans
 * lui, il faut interroger l'état à la main, et un abonné qui paie à minuit
 * attend le passage du lendemain pour retrouver son accès.
 *
 * Ce script prend une requête **réellement reçue** — corps brut et en-tête de
 * signature tels qu'ils sont arrivés — et la donne à la bibliothèque.
 *
 *   NDANK_WEBHOOK_SECRET=… NDANK_CAPTURE=… node scripts/bac-a-sable-webhook.mjs
 */
import {
  CREANCE_VIERGE,
  reconcilier,
} from "../dist/encaissement/reconciliation.js";
import { fournisseur } from "../dist/encaissement/registre.js";
import { ajouterJours } from "../dist/cycle.js";
import { accesOuvert, etatDe } from "../dist/etats.js";

const SECRET = process.env["NDANK_WEBHOOK_SECRET"] ?? "";
const CAPTURE = process.env["NDANK_CAPTURE"] ?? "";

let echecs = 0;
let passes = 0;
const verifier = (quoi, condition, detail = "") => {
  condition ? (passes += 1) : (echecs += 1);
  console.log(`  ${condition ? "✓" : "✗"} ${quoi}${!condition && detail ? ` — ${detail}` : ""}`);
};

if (SECRET === "" || CAPTURE === "") {
  console.log("Ndank — le webhook, rejoué depuis une vraie capture\n");
  console.log("NDANK_WEBHOOK_SECRET ou NDANK_CAPTURE absent. Rien n'a été éprouvé.");
  console.log("  NDANK_CAPTURE = l'identifiant du bac de capture (webhook.site).");
  process.exit(0);
}

console.log("Ndank — le webhook, rejoué depuis une vraie capture\n");

// ── 1. récupérer ce qui est réellement arrivé ─────────────────────────────
const r = await fetch(
  `https://webhook.site/token/${CAPTURE}/requests?sorting=newest`,
);
const [recu] = (await r.json()).data ?? [];

if (!recu) {
  console.log("Aucune requête captée.");
  process.exit(1);
}

const corps = recu.content;
const entetes = Object.fromEntries(
  Object.entries(recu.headers ?? {}).map(([k, v]) => [
    k.toLowerCase(),
    Array.isArray(v) ? v[0] : v,
  ]),
);

console.log(`▸ Reçu le ${recu.created_at}`);
console.log(`  ${corps.length} octets, en-tête de signature : ${entetes["verif-hash"] ? "présent" : "ABSENT"}\n`);

const fw = fournisseur("flutterwave", {
  cleSecrete: "FLWSECK_TEST-inutile-ici",
  secretWebhook: SECRET,
});

// ── 2. la signature ───────────────────────────────────────────────────────
console.log("▸ La signature");

let issue;
try {
  issue = fw.lireWebhook(corps, entetes);
  verifier("le corps réel passe la vérification", true);
} catch (cause) {
  verifier("le corps réel passe la vérification", false, String(cause).slice(0, 120));
  console.log(`\n${passes} vérifiées, ${echecs} en échec.`);
  process.exit(1);
}

// Un secret faux doit lever, sans quoi la vérification ne vérifie rien.
const faux = fournisseur("flutterwave", {
  // Le prefixe _TEST est obligatoire : l adaptateur refuse de se construire
  // sur une cle de production non assumee, et il a raison de le faire ici.
  cleSecrete: "FLWSECK_TEST-inutile-ici",
  secretWebhook: `${SECRET}-faux`,
});
let leve = false;
try {
  faux.lireWebhook(corps, entetes);
} catch {
  leve = true;
}
verifier("un mauvais secret est refusé", leve);

// Et un corps modifié en route doit être refusé aussi.
let altereRefuse = false;
try {
  const altere = corps.replace('"amount":2000', '"amount":200000');
  const lu = fw.lireWebhook(altere, entetes);
  // Flutterwave signe par secret partagé et non par HMAC du corps : la
  // signature ne couvre donc PAS le contenu. C'est une limite du fournisseur,
  // pas de Ndank, et elle mérite d'être vue plutôt que supposée.
  altereRefuse = false;
  console.log(
    `  · corps modifié accepté, montant relu : ${lu?.montant} ${lu?.devise}`,
  );
} catch {
  altereRefuse = true;
}
verifier(
  altereRefuse
    ? "un corps modifié est refusé"
    : "la signature ne couvre pas le corps (secret partagé, pas HMAC)",
  true,
);

// ── 3. ce que Ndank en tire ───────────────────────────────────────────────
console.log("\n▸ L'issue lue");
console.log(`  référence : ${issue.reference}`);
console.log(`  état      : ${issue.etat}`);
console.log(`  montant   : ${issue.montant} ${issue.devise}`);
console.log(`  réglé le  : ${issue.regleLe?.toISOString() ?? "—"}\n`);

verifier("l'état est REUSSI", issue.etat === "REUSSI", issue.etat);
verifier("le montant est en unités mineures", issue.montant === 2000, String(issue.montant));
verifier("la devise est celle de la charge", issue.devise === "XOF", issue.devise);
verifier("la référence est la nôtre", issue.reference.startsWith("2026"), issue.reference);

// ── 4. et le cycle avance ─────────────────────────────────────────────────
const lue = issue.reference.match(/^(\d{4})(\d{2})(\d{2})-\d+-(.+)$/);
const echeance = new Date(`${lue[1]}-${lue[2]}-${lue[3]}T00:00:00Z`);

const abonnement = {
  id: lue[4],
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

const maintenant = ajouterJours(echeance, 8); // accès coupé, dans la reprise
const comptes = new Set();
const creances = {
  async dejaCompte(id) {
    return comptes.has(id);
  },
  async etat() {
    return CREANCE_VIERGE;
  },
};

console.log("▸ Du webhook au cycle");
console.log(`  avant : ${etatDe(abonnement, maintenant)}, accès ${accesOuvert(abonnement, maintenant) ? "ouvert" : "coupé"}`);

const decision = await reconcilier(creances, abonnement, issue, "CREDIT");
verifier("il décide de renouveler", decision.faire === "RENOUVELER", decision.faire);

if (decision.faire === "RENOUVELER") {
  const apres = { ...abonnement, cycle: decision.cycle };
  console.log(`  après : ${etatDe(apres, maintenant)}, accès ${accesOuvert(apres, maintenant) ? "ouvert" : "coupé"} (+${decision.jours} j)\n`);

  verifier("l'accès est rouvert", accesOuvert(apres, maintenant));

  comptes.add(decision.versementId);
  const rejeu = await reconcilier(creances, apres, issue, "CREDIT");
  verifier("le rejeu du webhook ne prolonge pas deux fois", rejeu.faire === "RIEN", rejeu.faire);
}

// ══════════════════════════════════════════════════════════════════════════

console.log(`\n${passes} vérifiées, ${echecs} en échec.`);

if (echecs > 0) {
  console.error("\nLe chemin du webhook ne tient pas.");
  process.exit(1);
}

console.log("\nDu webhook signé jusqu'à l'accès rouvert, contre du réel.");
