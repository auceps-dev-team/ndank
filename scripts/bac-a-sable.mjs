/**
 * Ndank — l'épreuve contre les vrais bacs à sable.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QUE LES 379 TESTS NE PEUVENT PAS DIRE
 *
 * Tous les adaptateurs de paiement sont éprouvés contre un faux `Http` qui
 * rejoue ce que **je crois** que l'API du fournisseur fait. C'est ce qui les
 * rend testables sans compte marchand, et c'est aussi leur limite : un faux ne
 * dément jamais celui qui l'a écrit.
 *
 * Trois choses ne se vérifient qu'ici :
 *
 *   — **la forme réelle de la requête.** Un en-tête mal nommé, un champ absent,
 *     un encodage attendu ailleurs — le faux les accepte tous ;
 *   — **le jeu de caractères d'une référence.** On affirme que Paystack limite
 *     une référence aux alphanumériques et à `-`, `.`, `=`, `_`. Ici on le
 *     constate ;
 *   — **le refus d'une référence en double**, sur lequel repose tout le
 *     correctif de la 0.7.0. C'est une affirmation dans un commentaire tant que
 *     personne ne l'a vue.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL NE TOURNE PAS DANS `npm test`, ET C'EST DÉLIBÉRÉ
 *
 * La suite du dépôt tourne en une seconde, sans réseau et sans compte. C'est ce
 * qui fait qu'on la lance. Y glisser des appels réels la rendrait lente,
 * intermittente, et dépendante d'un service tiers — donc on cesserait de la
 * croire quand elle échoue.
 *
 *     npm run bac-a-sable
 *
 * Sans clés, il ne fait rien et le dit. Aucune raison de bloquer quelqu'un qui
 * n'a pas de compte de test.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL LIT `dist/`, ET NON `src/`
 *
 * Le paquet construit est ce qu'un hôte reçoit. L'éprouver ici fait d'une
 * pierre deux coups : les adaptateurs sont vérifiés contre les fournisseurs, et
 * le paquet contre lui-même.
 */

import { fournisseur } from "../dist/encaissement/registre.js";
import { referenceDeVersement } from "../dist/encaissement/reconciliation.js";

const CLE_PAYSTACK = process.env["PAYSTACK_CLE_SECRETE"] ?? "";
const CLE_FLUTTERWAVE = process.env["FLUTTERWAVE_CLE_SECRETE"] ?? "";

let echecs = 0;
let passes = 0;
let sautes = 0;

function verifier(quoi, condition, detail = "") {
  if (condition) {
    passes += 1;
    console.log(`  ✓ ${quoi}`);
    return;
  }

  echecs += 1;
  console.log(`  ✗ ${quoi}${detail ? ` — ${detail}` : ""}`);
}

/** Un abonné de test. Le numéro est celui que Paystack documente pour ses essais. */
const ABONNE = {
  nom: "Awa Ndank",
  courriel: "essai@ndank.test",
  telephone: "+2348123456789",
};

// ─────────────────────────────────────────────────────────────── paystack ──

async function paystack() {
  console.log("\n▸ Paystack");

  if (CLE_PAYSTACK === "") {
    sautes += 1;
    console.log("  — sauté : PAYSTACK_CLE_SECRETE absente");
    return;
  }

  if (!CLE_PAYSTACK.startsWith("sk_test_")) {
    // Un vrai débit sur un vrai abonné se fait une fois, et se regrette
    // longtemps. Ce script initie de vraies demandes de paiement.
    throw new Error(
      "PAYSTACK_CLE_SECRETE ne commence pas par « sk_test_ ». " +
        "Ce script initie de vraies demandes de paiement : refusez une clé de " +
        "production plutôt que de la découvrir sur un relevé.",
    );
  }

  const p = fournisseur("paystack", { cleSecrete: CLE_PAYSTACK });

  // Paystack ne traite pas le XOF sur un compte d'essai ordinaire : on éprouve
  // la forme des requêtes, pas la devise de production.
  const echeance = new Date();
  const unique = `essai${Date.now().toString(36)}`;
  const reference = referenceDeVersement(unique, echeance, 0);

  verifier(
    "la référence n'emploie que des caractères acceptés",
    /^[A-Za-z0-9\-.=_]+$/.test(reference),
    reference,
  );

  let invitation;

  try {
    invitation = await p.inviter({
      reference,
      montant: 50_000,
      devise: "NGN",
      libelle: "Essai Ndank",
      abonne: ABONNE,
      retour: "https://p.ndank.test/v/retour",
    });
  } catch (cause) {
    verifier("l'invitation part", false, String(cause).slice(0, 200));
    return;
  }

  verifier("l'invitation rend une URL de validation", invitation.url !== null);
  verifier("l'invitation renvoie notre référence", invitation.reference === reference);
  verifier(
    "l'invitation porte un identifiant fournisseur",
    invitation.identifiantFournisseur !== null,
  );

  // LE POINT QUI COMPTE : la référence en double. Tout le correctif de la
  // 0.7.0 repose sur l'affirmation que Paystack la refuse.
  let doublon = null;
  try {
    await p.inviter({
      reference,
      montant: 50_000,
      devise: "NGN",
      libelle: "Essai Ndank",
      abonne: ABONNE,
      retour: "https://p.ndank.test/v/retour",
    });
  } catch (cause) {
    doublon = cause;
  }

  verifier(
    "une référence déjà vue est refusée — c'est ce qui justifie la 0.7.0",
    doublon !== null,
    doublon === null
      ? "Paystack a accepté deux fois la même référence : le correctif reposait sur une hypothèse fausse"
      : "",
  );

  const issue = await p.constater(reference);

  verifier("le constat retrouve la transaction", issue.reference === reference);
  verifier(
    "le constat rend un état lisible",
    ["EN_ATTENTE", "ECHOUE", "EXPIRE", "REUSSI"].includes(issue.etat),
    issue.etat,
  );
  verifier(
    "le constat rapporte le montant et la devise",
    issue.montant === 50_000 && issue.devise === "NGN",
    `${issue.montant} ${issue.devise}`,
  );

  // Une référence qui n'existe pas ne doit pas ressembler à un échec de
  // paiement : conclure couperait l'accès de quelqu'un.
  let absente = null;
  try {
    await p.constater(`inexistante-${Date.now()}`);
  } catch (cause) {
    absente = cause;
  }

  verifier(
    "constater une référence inexistante lève plutôt que de rendre ECHOUE",
    absente !== null,
  );
}

// ──────────────────────────────────────────────────────────── flutterwave ──

async function flutterwave() {
  console.log("\n▸ Flutterwave");

  if (CLE_FLUTTERWAVE === "") {
    sautes += 1;
    console.log("  — sauté : FLUTTERWAVE_CLE_SECRETE absente");
    return;
  }

  const f = fournisseur("flutterwave", {
    cleSecrete: CLE_FLUTTERWAVE,
    secretWebhook: process.env["FLUTTERWAVE_SECRET_WEBHOOK"] ?? "essai",
    // Jamais la production depuis ce script.
    production: false,
  });

  const unique = `essai${Date.now().toString(36)}`;
  const reference = referenceDeVersement(unique, new Date(), 0);

  try {
    const invitation = await f.inviter({
      reference,
      montant: 2000,
      devise: "XOF",
      libelle: "Essai Ndank",
      abonne: { ...ABONNE, telephone: "+2250700000000" },
      retour: "https://p.ndank.test/v/retour",
    });

    verifier("l'invitation renvoie notre référence", invitation.reference === reference);
    verifier(
      "l'invitation donne une URL ou une instruction",
      invitation.url !== null || invitation.instruction !== null,
      "les deux sont nulles : l'abonné n'a nulle part où valider",
    );

    const issue = await f.constater(reference);
    verifier("le constat retrouve la charge", issue.reference === reference);
  } catch (cause) {
    // On ne fait pas échouer sur ce seul point : le bac à sable Flutterwave
    // change d'adresse et de forme plus souvent que celui de Paystack, et
    // c'est précisément ce qu'on vient mesurer.
    verifier("l'échange aboutit", false, String(cause).slice(0, 300));
  }
}

// ──────────────────────────────────────────────────────────────────────────

console.log("Ndank — épreuve contre les bacs à sable");
console.log("Aucune de ces vérifications ne tourne dans `npm test`.");

await paystack();
await flutterwave();

console.log(
  `\n${passes} vérifiées, ${echecs} en échec, ${sautes} fournisseur(s) sauté(s).`,
);

if (echecs > 0) process.exitCode = 1;

if (passes === 0 && echecs === 0) {
  console.log(
    "\nRien n'a été éprouvé. Posez PAYSTACK_CLE_SECRETE (sk_test_…) ou " +
      "FLUTTERWAVE_CLE_SECRETE dans votre environnement.",
  );
}
