/**
 * Ndank — l'adaptateur lomi., contre le vrai lomi.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE PREMIER ADAPTATEUR ÉCRIT APRÈS AVOIR APPELÉ L'API
 *
 * Les trois autres ont été écrits d'après une documentation, puis corrigés par
 * la réalité : Flutterwave a coûté trois versions parce que la v4 ne pouvait
 * même pas s'authentifier, Paystack a coûté un facteur cent sur les montants,
 * et la passerelle Android a demandé quatre tentatives et une heure.
 *
 * Celui-ci a été écrit **après** un relevé complet du bac à sable, et ce script
 * vérifie que le relevé n'a pas menti.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QU'IL NE PEUT PAS ÉPROUVER, ET POURQUOI
 *
 * Aucun canal de paiement n'est raccordé au compte marchand. Mesuré :
 *
 *     POST /charge/wave → « Wave provider not configured for this organization
 *                           (missing Aggregated Merchant ID) »
 *
 * et il n'existe, sur 132 routes documentées, aucune route pour y remédier :
 * c'est lomi. qui raccorde, après identification du marchand. Donc **aucun
 * paiement ne peut aboutir**, et la moitié du chemin — de l'issue au cycle —
 * reste hors de portée jusque-là.
 *
 * Le webhook non plus : son secret `whsec_…` n'est pas exposé par l'API, il se
 * recopie du tableau de bord. Quand vous l'aurez, posez `LOMI_SECRET_WEBHOOK`
 * et les vérifications de signature s'ajouteront d'elles-mêmes.
 *
 *   LOMI_CLE_SECRETE=lomi_sk_test_… node scripts/bac-a-sable-lomi.mjs
 */
import { fournisseur } from "../dist/encaissement/registre.js";
import { versFournisseur } from "../dist/devise.js";

const CLE = process.env["LOMI_CLE_SECRETE"] ?? "";
const SECRET = process.env["LOMI_SECRET_WEBHOOK"] ?? "";

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

if (CLE === "") {
  console.log("Ndank — l'adaptateur lomi., contre le vrai lomi.\n");
  console.log("LOMI_CLE_SECRETE absente. Rien n'a été éprouvé.");
  process.exit(0);
}

console.log("Ndank — l'adaptateur lomi., contre le vrai lomi.\n");

// La référence porte l'échéance : c'est elle qui borne le balayage de
// `constater`, et elle change à chaque passage pour ne pas retomber sur les
// liens du passage précédent.
const jour = new Date().toISOString().slice(0, 10).replace(/-/g, "");
const REFERENCE = `${jour}-1-essai${Date.now().toString(36).slice(-6)}`;

const lomi = fournisseur("lomi", {
  cleSecrete: CLE,
  secretWebhook: SECRET === "" ? "whsec_absent" : SECRET,
});

console.log(`▸ Référence de ce passage : ${REFERENCE}\n`);

// ── 1. le garde-fou de démarrage ──────────────────────────────────────────
console.log("▸ Le garde-fou");

let refuse = false;
try {
  fournisseur("lomi", {
    cleSecrete: "lomi_pk_aaaaaaaaaaaa",
    secretWebhook: "x",
  });
} catch {
  refuse = true;
}
verifier(
  "une clé sans marqueur de test est refusée (c'est celle qui écrit en production)",
  refuse,
);

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

const invitation = await lomi.inviter(demande);

console.log(`  url      : ${invitation.url}`);
console.log(`  lien     : ${invitation.identifiantFournisseur}`);
console.log(`  expire   : ${invitation.expireLe?.toISOString().slice(0, 10)}`);

verifier("il rend une URL vers laquelle envoyer l'abonné", typeof invitation.url === "string" && invitation.url.startsWith("https://"));
verifier("il rend l'identifiant du lien", invitation.identifiantFournisseur !== null);
verifier("l'état est EN_ATTENTE", invitation.etat === "EN_ATTENTE", invitation.etat);

// Le point qui décide de tout : un lien de soixante minutes serait mort avant
// que l'abonné n'ouvre son SMS le lendemain matin.
const joursDeVie = invitation.expireLe
  ? Math.round((invitation.expireLe.getTime() - Date.now()) / 86_400_000)
  : 0;
console.log(`  → le lien vit ${joursDeVie} jours\n`);
verifier(
  "le lien survit à une nuit, et à toute l'échelle de relance",
  joursDeVie >= 30,
  `${joursDeVie} jours`,
);

// ── 3. la page de paiement répond vraiment ────────────────────────────────
console.log("▸ La page de paiement");

const page = await fetch(invitation.url, { redirect: "follow" });
verifier("la page de paiement répond", page.ok, `HTTP ${page.status}`);

// ── 4. l'idempotence, réparée ici parce qu'elle ne l'est pas chez eux ─────
console.log("\n▸ Le rejeu");
console.log("  (trois POST /payment-links avec la même clé ont rendu trois liens :");
console.log("   c'est l'adaptateur qui protège, pas le fournisseur)");

const rejeu = await lomi.inviter(demande);

verifier(
  "un inviter rejoué rend le MÊME lien",
  rejeu.identifiantFournisseur === invitation.identifiantFournisseur,
  `${invitation.identifiantFournisseur} puis ${rejeu.identifiantFournisseur}`,
);
verifier("et donc la même URL", rejeu.url === invitation.url);

// ── 5. constater, par les deux chemins ────────────────────────────────────
console.log("\n▸ constater");

// Personne n'a payé — aucun canal n'est raccordé. Ce qu'on vérifie ici, c'est
// que l'absence de paiement ne se lit pas comme un échec.
const sansRien = await lomi.constater(REFERENCE);
console.log(`  sans paiement : ${sansRien.etat}`);

verifier(
  "un cycle que personne n'a payé rend EN_ATTENTE, jamais ECHOUE",
  sansRien.etat === "EN_ATTENTE",
  sansRien.etat,
);
verifier("et ne prétend pas avoir été réglé", sansRien.regleLe === null);

// Le chemin par identifiant : lomi. ne sait chercher que par le sien.
let leveSurInconnu = false;
try {
  await lomi.constater(REFERENCE, "00000000-0000-4000-8000-000000000000");
} catch {
  leveSurInconnu = true;
}
verifier(
  "un identifiant inexistant lève plutôt que de rendre un faux ECHOUE",
  leveSurInconnu,
);

// ── 6. le webhook ─────────────────────────────────────────────────────────
console.log("\n▸ Le webhook");

if (SECRET === "") {
  sauter(
    "la signature n'a pas été éprouvée",
    "LOMI_SECRET_WEBHOOK absent. Le secret whsec_ ne s'obtient qu'au tableau " +
      "de bord : l'API ne l'expose ni à la création ni à la relecture.",
  );
} else {
  const { createHmac } = await import("node:crypto");
  const corps = JSON.stringify({
    id: "evt_essai",
    data: {
      object: {
        transaction_id: "11111111-1111-4111-8111-111111111111",
        gross_amount: 2000,
        currency_code: "XOF",
        status: "completed",
        metadata: { ndank_reference: REFERENCE },
        created_at: new Date().toISOString(),
      },
    },
  });

  const signature = createHmac("sha256", SECRET).update(corps, "utf8").digest("hex");
  const issue = lomi.lireWebhook(corps, { "x-lomi-signature": signature });

  verifier("un événement signé se lit", issue?.etat === "REUSSI", String(issue?.etat));
  verifier("et porte notre référence", issue?.reference === REFERENCE);

  // Le test que Flutterwave ne passe pas.
  let refuseAltere = false;
  try {
    lomi.lireWebhook(corps.replace("2000", "200000"), {
      "x-lomi-signature": signature,
    });
  } catch {
    refuseAltere = true;
  }
  verifier(
    "un corps modifié en route est REFUSÉ (Flutterwave l'accepte)",
    refuseAltere,
  );
}

// ── 7. les unités, contre la vraie réponse ────────────────────────────────
console.log("\n▸ Les unités");
console.log(`  versFournisseur(2000, "XOF", 0) = ${versFournisseur(2000, "XOF", 0)}`);
console.log("  (lomi. : « for XOF, 5000 means 5,000 XOF » — unités mineures ISO)");
console.log("  (leur propre SDK π-SPI dit l'inverse : des centimes)\n");
verifier("le franc CFA passe sans conversion", versFournisseur(2000, "XOF", 0) === 2000);

// ══════════════════════════════════════════════════════════════════════════

console.log(`\n${passes} vérifiées, ${echecs} en échec, ${sautes} hors de portée.`);

if (echecs > 0) {
  console.error("\nL'adaptateur lomi. ne tient pas.");
  process.exit(1);
}

console.log("\nDe l'invitation au constat, contre le vrai lomi.");
console.log(
  "Reste hors de portée : le paiement lui-même — aucun canal n'est raccordé\n" +
    "au compte marchand, et aucune route d'API ne permet de le faire.",
);
