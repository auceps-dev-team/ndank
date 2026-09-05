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
import { exposant, versFournisseur } from "../dist/devise.js";

const CLE_PAYSTACK = process.env["PAYSTACK_CLE_SECRETE"] ?? "";
const FW_CLIENT_ID = process.env["FLUTTERWAVE_CLIENT_ID"] ?? "";
const FW_CLIENT_SECRET = process.env["FLUTTERWAVE_CLIENT_SECRET"] ?? "";

/**
 * Ce que Flutterwave compte, et pourquoi le franc CFA ne peut pas le dire.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UN ESSAI EN XOF NE PROUVE RIEN SUR LES UNITÉS
 *
 * On suppose que Flutterwave compte en unités **majeures** — la supposition
 * exacte qui, chez Paystack, a produit un « XOF 20.00 » pour deux mille francs.
 *
 * `versFournisseur` calcule `decimalesFournisseur - exposant(devise)`. Pour
 * Flutterwave, zéro décimale ; pour le XOF, zéro décimale. **L'écart est nul,
 * donc la conversion est l'identité** : 2 000 part comme 2 000, que
 * l'hypothèse soit juste ou fausse.
 *
 * Autrement dit, l'essai le plus naturel — un montant en francs CFA — est
 * précisément celui qui ne peut pas répondre. Il faut une devise qui porte des
 * décimales : le naira, le cedi, le shilling. En NGN, 200 000 mineures
 * (2 000 ₦) partent comme 2 000 — et le tableau de bord marchand tranche.
 *
 * D'où le défaut à NGN, et l'avertissement plus bas quand on choisit une devise
 * qui ne départage pas.
 */
const FW_DEVISE = process.env["FLUTTERWAVE_DEVISE"] ?? "NGN";
const FW_MONTANT = Number.parseInt(
  process.env["FLUTTERWAVE_MONTANT"] ?? "200000",
  10,
);

/**
 * Le numéro doit être du pays de la devise, et l'adaptateur le vérifie.
 *
 * Trouvé en posant NGN par défaut : « l'indicatif +225 paie en XOF,
 * l'abonnement est en NGN ». C'est juste — Flutterwave n'accepte pas un
 * mobile money ivoirien pour une charge en naira — mais cela veut dire que
 * changer la devise sans changer le numéro donne une erreur qui parle de
 * devise et non de numéro, et l'on cherche au mauvais endroit.
 */
const TELEPHONE_PAR_DEVISE = {
  XOF: "+2250700000000",
  NGN: "+2348000000000",
  GHS: "+233200000000",
  KES: "+254700000000",
  UGX: "+256700000000",
};

const FW_TELEPHONE =
  process.env["FLUTTERWAVE_TELEPHONE"] ?? TELEPHONE_PAR_DEVISE[FW_DEVISE] ?? null;


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

/**
 * Un abonné de test.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * L'ADRESSE N'EST PAS EN `.test`, ET C'EST LE BAC À SABLE QUI L'A APPRIS
 *
 * La première version employait `essai@ndank.test`, par réflexe : `.test` est
 * le domaine réservé aux essais (RFC 2606), donc il ne peut atteindre personne.
 *
 * Paystack le refuse. `"email" must be a valid email`, en 400 — un message qui
 * ne dit pas que c'est le domaine de premier niveau qui gêne, et qu'on lit
 * trois fois en cherchant une faute de frappe.
 *
 * C'est exactement le genre de chose qu'un faux `Http` ne dira jamais, et la
 * raison d'être de ce script.
 */
const ABONNE = {
  nom: "Awa Ndank",
  courriel: "awa@baobart.ci",
  telephone: "+2250700000000",
};

/**
 * La devise du compte d'essai.
 *
 * `XOF` par défaut, parce que c'est celle de Ndank. Un compte Paystack n'active
 * que les devises de son marché : les autres reviennent en `403 Currency not
 * supported by merchant`, ce qui est un message clair — pour peu qu'on sache
 * qu'il parle du compte et non de la requête.
 */
const DEVISE = process.env["PAYSTACK_DEVISE"] ?? "XOF";
const MONTANT = Number.parseInt(process.env["PAYSTACK_MONTANT"] ?? "2000", 10);

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
      montant: MONTANT,
      devise: DEVISE,
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
      montant: MONTANT,
      devise: DEVISE,
      libelle: "Essai Ndank",
      abonne: ABONNE,
      retour: "https://p.ndank.test/v/retour",
    });
  } catch (cause) {
    doublon = cause;
  }

  verifier(
    "une référence déjà vue est refusée — c'est ce qui justifie la 0.7.0",
    doublon !== null && /duplicate/i.test(String(doublon)),
    doublon === null
      ? "Paystack a accepté deux fois la même référence : le correctif reposait sur une hypothèse fausse"
      : // Sans ce contrôle du motif, une coupure réseau passerait pour une
        // confirmation : n'importe quelle exception validerait l'assertion.
        `refusé, mais pas pour doublon : ${String(doublon).slice(0, 120)}`,
  );

  const issue = await p.constater(reference);

  verifier("le constat retrouve la transaction", issue.reference === reference);

  /**
   * Une transaction jamais réglée est EN_ATTENTE, jamais EXPIRE.
   *
   * C'est le défaut que ce script a trouvé et que la 0.8.1 corrige. Paystack
   * marque `abandoned` dès l'initialisation ; le lire comme une expiration
   * faisait annoncer à l'abonné que sa demande avait expiré cinq secondes
   * après qu'il eut cliqué sur « Régler ».
   *
   * On le vérifie ici plutôt qu'ailleurs parce que c'est ici que le mensonge
   * était possible : le faux `Http` de la suite rend ce qu'on lui a écrit.
   */
  verifier(
    "une transaction jamais réglée est EN_ATTENTE, et non EXPIRE",
    issue.etat === "EN_ATTENTE",
    `état rendu : ${issue.etat} — si c'est EXPIRE, la page de validation ` +
      `annoncera une expiration à quelqu'un qui est en train de payer`,
  );
  /**
   * L'aller-retour du montant, qui est le second défaut trouvé ici.
   *
   * Ndank compte en unités mineures ISO — `2000` vaut deux mille francs — et
   * Paystack applique deux décimales à tout. Sans conversion, un abonnement à
   * 2 000 F était prélevé vingt francs. Le tableau de bord le montrait :
   *
   *     envoyé « amount: 2000 »    → affiché « XOF 20.00 »
   *     envoyé « amount: 200000 »  → affiché « XOF 2,000.00 »
   *
   * Ce contrôle vérifie que ce qui revient est bien ce qu'on a demandé, ramené
   * à notre unité. Il ne dit rien de ce que Paystack a **affiché** — cela, il
   * faut aller le lire dans le tableau de bord, et c'est pour cette raison que
   * la référence est lisible en clair.
   */
  verifier(
    "le montant fait l'aller-retour sans changer d'ordre de grandeur",
    issue.montant === MONTANT && issue.devise === DEVISE,
    `attendu ${MONTANT} ${DEVISE}, reçu ${issue.montant} ${issue.devise} — ` +
      `un facteur cent signale une convention de décimales qui a changé`,
  );

  console.log(
    `    (à lire dans le tableau de bord : la référence ${reference} doit ` +
      `s'y afficher « XOF ${(MONTANT).toLocaleString("en-US", { minimumFractionDigits: 2 })} »)`,
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

  if (FW_CLIENT_ID === "" || FW_CLIENT_SECRET === "") {
    sautes += 1;
    console.log("  — sauté : FLUTTERWAVE_CLIENT_ID / FLUTTERWAVE_CLIENT_SECRET absents.");
    console.log("    Ce ne sont ni une clé FLWSECK_, ni l'identifiant marchand :");
    console.log("    la v4 échange un couple client contre un jeton de dix minutes.");
    return;
  }

  const f = fournisseur("flutterwave", {
    clientId: FW_CLIENT_ID,
    clientSecret: FW_CLIENT_SECRET,
    secretWebhook: process.env["FLUTTERWAVE_SECRET_WEBHOOK"] ?? "essai",
    // Jamais la production depuis ce script.
    production: false,
  });

  const unique = `essai${Date.now().toString(36)}`;
  const reference = referenceDeVersement(unique, new Date(), 0);

  // Ce qui part réellement sur le fil, calculé avant l'appel pour qu'on puisse
  // le comparer à ce que le tableau de bord marchand annonce.
  const surLeFil = versFournisseur(FW_MONTANT, FW_DEVISE, 0);

  console.log(`  · numéro d'essai : ${FW_TELEPHONE}`);
  console.log(
    `  · Ndank détient ${FW_MONTANT} ${FW_DEVISE} en unités mineures ; ` +
      `envoyé sur le fil : ${surLeFil}`,
  );

  if (exposant(FW_DEVISE) === 0) {
    console.log(
      `  ⚠ ${FW_DEVISE} ne porte aucune décimale : la conversion est l'identité,`,
    );
    console.log("    et cet essai ne peut PAS départager majeures et mineures.");
    console.log("    Relancez avec FLUTTERWAVE_DEVISE=NGN pour la case #8.");
  } else {
    console.log("  → à vérifier dans le tableau de bord Flutterwave :");
    console.log(`    la transaction doit annoncer ${surLeFil} ${FW_DEVISE}.`);
    console.log(
      `    Si elle annonce ${surLeFil / 100} ou ${surLeFil * 100}, ` +
        "l'hypothèse des unités majeures est fausse.",
    );
  }

  try {
    const invitation = await f.inviter({
      reference,
      montant: FW_MONTANT,
      devise: FW_DEVISE,
      libelle: "Essai Ndank",
      abonne: { ...ABONNE, telephone: FW_TELEPHONE },
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
      "FLUTTERWAVE_CLIENT_ID + _SECRET dans votre environnement.",
  );
}
