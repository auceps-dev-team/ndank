/**
 * Ndank — l'adaptateur Bictorys, contre le vrai Bictorys.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE CINQUIÈME, ET LE PREMIER QUI N'A RIEN COÛTÉ À DÉCOUVRIR
 *
 * Flutterwave a coûté trois versions, Paystack un facteur cent, lomi. une
 * demi-journée de sondage. Celui-ci a marché du premier appel, parce qu'il a
 * été écrit après avoir lu `afrotools` — un registre qui documente les pièges
 * en plus des champs.
 *
 * Ce script vérifie que le registre n'a pas menti, et note où il s'est trompé.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL MÈNE UN PAIEMENT À SON TERME, ET C'EST LE SEUL DU DÉPÔT
 *
 * Bictorys expose un **simulateur** en bac à sable — `/simulator/v1/` — qui
 * approuve ou refuse une transaction sans opérateur. Ce script s'en sert, et
 * constate donc un `succeeded` réel plutôt qu'un `pending` éternel.
 *
 * Il a fallu un échec pour le trouver. Le tunnel hébergé route vers les vrais
 * opérateurs, qui refusent un numéro ordinaire en test : Orange Money a répondu
 * `USER_INVALID`. C'est le chemin **direct**, avec `payment_type`, qui rend un
 * lien de simulateur.
 *
 * Et ce paiement a trouvé un défaut qu'aucun test contre un faux n'aurait vu :
 * la route d'état rend `{id, status}` **sans montant**, donc un `REUSSI` en
 * sortait avec `montant: 0` — et `reconcilier` achète du temps avec ce montant.
 *
 *   BICTORYS_CLE_PUBLIQUE=test_public-… BICTORYS_CLE_PRIVEE=test_secret-… \
 *   node scripts/bac-a-sable-bictorys.mjs
 */
import { fournisseur } from "../dist/encaissement/registre.js";
import {
  lireHorodatage,
  verifierBictorys,
} from "../dist/encaissement/fournisseurs/bictorys.js";
import { createHmac } from "node:crypto";

const PUBLIQUE = process.env["BICTORYS_CLE_PUBLIQUE"] ?? "";
const PRIVEE = process.env["BICTORYS_CLE_PRIVEE"] ?? "";
const SECRET = process.env["BICTORYS_SECRET_WEBHOOK"] ?? "secret-de-demonstration";

let echecs = 0;
let passes = 0;
let sautes = 0;

const verifier = (quoi, condition, detail = "") => {
  condition ? (passes += 1) : (echecs += 1);
  console.log(
    `  ${condition ? "✓" : "✗"} ${quoi}${!condition && detail ? ` — ${detail}` : ""}`,
  );
};

const sauter = (quoi, pourquoi) => {
  sautes += 1;
  console.log(`  · ${quoi} — ${pourquoi}`);
};

if (PUBLIQUE === "" || PRIVEE === "") {
  console.log("Ndank — l'adaptateur Bictorys, contre le vrai Bictorys\n");
  console.log("BICTORYS_CLE_PUBLIQUE ou BICTORYS_CLE_PRIVEE absente.");
  process.exit(0);
}

console.log("Ndank — l'adaptateur Bictorys, contre le vrai Bictorys\n");

const jour = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const REFERENCE = `${jour}-1-essai${Date.now().toString(36).slice(-6)}`;

const bic = fournisseur("bictorys", {
  clePublique: PUBLIQUE,
  clePrivee: PRIVEE,
  secretWebhook: SECRET,
});

console.log(`▸ Référence de ce passage : ${REFERENCE}\n`);

// ── 1. le garde-fou ───────────────────────────────────────────────────────
console.log("▸ Le garde-fou");

let refuse = false;
try {
  fournisseur("bictorys", {
    clePublique: "public-de-production",
    clePrivee: "secret-de-production",
    secretWebhook: "x",
  });
} catch {
  refuse = true;
}
verifier("des clés sans préfixe `test_` sont refusées", refuse);

// ── 2. inviter ────────────────────────────────────────────────────────────
console.log("\n▸ inviter — contre la vraie API");

const demande = {
  reference: REFERENCE,
  montant: 2000,
  devise: "XOF",
  libelle: "Pass Créateur",
  abonne: {
    nom: "Essai Ndank",
    courriel: "essai@ndank.test",
    telephone: "+2250718350482",
  },
  retour: "https://exemple.ci/ndank/retour",
};

const invitation = await bic.inviter(demande);

console.log(`  url    : ${invitation.url?.slice(0, 78)}…`);
console.log(`  charge : ${invitation.identifiantFournisseur}`);

verifier(
  "il rend une URL vers laquelle envoyer l'abonné",
  typeof invitation.url === "string" && invitation.url.startsWith("https://"),
);
verifier(
  "il rend l'identifiant de la charge",
  invitation.identifiantFournisseur !== null,
);
verifier("l'état est EN_ATTENTE", invitation.etat === "EN_ATTENTE", invitation.etat);
verifier(
  "il ne prétend pas connaître une expiration qu'on ne lui a pas dite",
  invitation.expireLe === null,
);

// ── 3. la page de paiement ────────────────────────────────────────────────
console.log("\n▸ La page de paiement");

const page = await fetch(invitation.url, { redirect: "follow" });
verifier("la page hébergée répond", page.ok, `HTTP ${page.status}`);

// ── 4. constater ──────────────────────────────────────────────────────────
console.log("\n▸ constater");

const parId = await bic.constater(REFERENCE, invitation.identifiantFournisseur);
console.log(`  par identifiant : ${parId.etat}`);

verifier(
  "une charge que personne n'a payée rend EN_ATTENTE, jamais ECHOUE",
  parId.etat === "EN_ATTENTE",
  parId.etat,
);
verifier("et ne prétend pas avoir été réglée", parId.regleLe === null);

// Le bac à sable rend `id: null` ; l'adaptateur doit reprendre le nôtre plutôt
// que de perdre le fil.
verifier(
  "l'identifiant n'est pas perdu quand Bictorys rend `id: null`",
  parId.identifiantFournisseur === invitation.identifiantFournisseur,
  String(parId.identifiantFournisseur),
);

// Le chemin sans identifiant : écrit mais non éprouvable ici.
const sansId = await bic.constater(REFERENCE);
if (sansId.etat === "EN_ATTENTE" && sansId.identifiantFournisseur === null) {
  sauter(
    "le balayage par référence n'a rien pu prouver",
    "GET /pay/v1/transactions rend une liste vide en bac à sable, même avec " +
      "une charge en attente. Ce chemin reste non vérifié.",
  );
} else {
  verifier("le balayage par référence retrouve la charge", true);
}

// ── 5. un paiement mené à son terme ───────────────────────────────────────
console.log("\n▸ Un vrai paiement, par le simulateur");
console.log("  (le tunnel hébergé route vers les vrais opérateurs, qui refusent");
console.log("   un numéro ordinaire en bac à sable — « USER_INVALID ». Le chemin");
console.log("   direct, lui, rend un lien de simulateur.)");

const REF_PAYEE = `${jour}-2-paye${Date.now().toString(36).slice(-5)}`;

// Appel direct plutôt que par l'adaptateur : `inviter` omet délibérément
// `payment_type` pour laisser l'abonné choisir son opérateur, et c'est ce
// paramètre qui donne accès au simulateur.
const creee = await fetch(
  "https://api.test.bictorys.com/pay/v1/charges?payment_type=wave_money",
  {
    method: "POST",
    headers: { "X-Api-Key": PUBLIQUE, "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: 100,
      currency: "XOF",
      country: "SN",
      paymentReference: REF_PAYEE,
      successRedirectUrl: "https://exemple.ci/ok",
      errorRedirectUrl: "https://exemple.ci/ko",
      // Le numéro de test du bac à sable, tiré de leurs propres fixtures. Un
      // vrai numéro ivoirien est refusé : les opérateurs ne connaissent pas ce
      // compte en test.
      customerObject: { name: "Essai Ndank", phone: "221700000001", country: "SN" },
    }),
  },
);

const directe = await creee.json();
verifier("le chemin direct rend 201", creee.status === 201, String(creee.status));
verifier(
  "et un lien de simulateur plutôt qu'un vrai opérateur",
  typeof directe.link === "string" && directe.link.includes("/simulator/"),
);

// Le simulateur redirige vers une page d'approbation dont le formulaire poste
// sur `confirm` ou `cancel`. On confirme.
await fetch(
  `https://api.test.bictorys.com/simulator/v1/confirm?transaction_id=${directe.transactionId}`,
  { method: "POST" },
);

const paye = await bic.constater(REF_PAYEE, directe.transactionId);

console.log(`  → ${paye.etat}, ${paye.montant} ${paye.devise}, réglé le ${paye.regleLe?.toISOString().slice(0, 10)}`);

verifier("le paiement est constaté REUSSI", paye.etat === "REUSSI", paye.etat);

/**
 * Le défaut que ce paiement a trouvé, et que rien d'autre n'aurait trouvé.
 *
 * `/status` rend `{id, status}` sans montant. Un `REUSSI` à zéro aurait fait
 * acheter zéro jour à `reconcilier` : l'abonné aurait payé, le fournisseur
 * l'aurait confirmé, et le cycle n'aurait pas bougé.
 */
verifier(
  "et il porte son montant, que la route d'état ne donne pourtant pas",
  paye.montant === 100,
  String(paye.montant),
);
verifier("et son horodatage", paye.regleLe !== null);

const parRef = await bic.constater(REF_PAYEE);
verifier(
  "le balayage par référence le retrouve aussi",
  parRef.etat === "REUSSI" && parRef.montant === 100,
  `${parRef.etat} / ${parRef.montant}`,
);

// ── 6. la signature du webhook ────────────────────────────────────────────
console.log("\n▸ Le webhook");

const corps = JSON.stringify({
  id: "11111111-1111-4111-8111-111111111111",
  type: "payment",
  pspName: "wave_money",
  amount: 2000,
  currency: "XOF",
  paymentReference: REFERENCE,
  status: "succeeded",
  timestamp: "2026-09-14 18:45:44.10254",
});

const horodatage = String(Date.now());
const signature = createHmac("sha256", SECRET)
  .update(`${horodatage}.${corps}`, "utf8")
  .digest("hex");

const signes = {
  "x-webhook-signature": signature,
  "x-webhook-timestamp": horodatage,
};

const issue = bic.lireWebhook(corps, signes);
verifier("un événement signé se lit", issue?.etat === "REUSSI", String(issue?.etat));
verifier("et porte notre référence", issue?.reference === REFERENCE);
verifier("le montant revient en unités mineures", issue?.montant === 2000);

// Le test que Flutterwave ne passe pas.
let corpsAltereRefuse = false;
try {
  bic.lireWebhook(corps.replace('"amount":2000', '"amount":200000'), signes);
} catch {
  corpsAltereRefuse = true;
}
verifier("un corps modifié en route est REFUSÉ", corpsAltereRefuse);

// Et celui que ni lomi. ni Paystack ne passent : le rejeu.
let rejeuRefuse = false;
try {
  const vieux = String(Date.now() - 10 * 60 * 1000);
  bic.lireWebhook(corps, {
    "x-webhook-signature": createHmac("sha256", SECRET)
      .update(`${vieux}.${corps}`, "utf8")
      .digest("hex"),
    "x-webhook-timestamp": vieux,
  });
} catch {
  rejeuRefuse = true;
}
verifier(
  "un événement rejoué dix minutes plus tard est REFUSÉ (aucun autre fournisseur ne le fait)",
  rejeuRefuse,
);

// Le repli par secret partagé, qui ne lie pas le corps.
const parSecret = bic.lireWebhook(corps, { "x-secret-key": SECRET });
verifier("le repli par secret partagé fonctionne", parSecret?.etat === "REUSSI");

verifier(
  "mais il accepte un corps modifié — c'est la limite du secret partagé",
  verifierBictorys(
    corps.replace('"amount":2000', '"amount":200000'),
    { "x-secret-key": SECRET },
    SECRET,
  ),
);

// ── 7. l'horodatage qui n'est pas de l'ISO ────────────────────────────────
console.log("\n▸ L'horodatage");

const lu = lireHorodatage("2026-08-08 18:45:44.10254");
console.log(`  « 2026-08-08 18:45:44.10254 » → ${lu?.toISOString()}`);

verifier(
  "un horodatage sans fuseau est lu en UTC, et non en heure du serveur",
  lu?.toISOString() === "2026-08-08T18:45:44.102Z",
  String(lu?.toISOString()),
);
verifier(
  "un horodatage déjà en ISO n'est pas décalé une seconde fois",
  lireHorodatage("2026-08-08T18:45:44.102Z")?.toISOString() ===
    "2026-08-08T18:45:44.102Z",
);

// ══════════════════════════════════════════════════════════════════════════

console.log(`\n${passes} vérifiées, ${echecs} en échec, ${sautes} hors de portée.`);

if (echecs > 0) {
  console.error("\nL'adaptateur Bictorys ne tient pas.");
  process.exit(1);
}

console.log("\nDe l'invitation au webhook signé, contre le vrai Bictorys.");
console.log(
  `Pour aller plus loin, ouvrez ce lien et payez :\n  ${invitation.url}`,
);
