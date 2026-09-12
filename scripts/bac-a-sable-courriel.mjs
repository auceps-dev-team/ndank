/**
 * Ndank — les passerelles de courriel, contre de vraies passerelles.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI CE SCRIPT N'EXISTAIT PAS, ET POURQUOI C'ÉTAIT UN TORT
 *
 * Resend avait été éprouvé le 5 septembre 2026, mais **à la main** : quelques
 * commandes tapées dans un terminal, un courriel parti, et rien qui permette de
 * recommencer. Un essai qu'on ne peut pas rejouer ne prouve rien le lendemain.
 *
 * Ce script fait la même chose, mais il reste. Il vaut pour les deux
 * transporteurs de courriel du dépôt.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QU'IL PROUVE, ET CE QU'IL NE PEUT PAS PROUVER
 *
 * `Remise.parti` vaut **« la passerelle a accepté »**, pas « le message est
 * arrivé ». C'est vrai des trois passerelles du dépôt, et il vaut mieux le
 * répéter que le laisser deviner : un rebond arrive plus tard, par un autre
 * chemin, et une adresse inexistante est acceptée sans broncher.
 *
 * Le seul test qui dise « arrivé » est une vraie boîte qu'on ouvre. Posez
 * `COURRIEL_DESTINATION` et allez regarder — **y compris dans les indésirables**,
 * qui est exactement là où le premier essai Resend avait atterri, faute de SPF
 * et de DMARC sur le domaine.
 *
 *   BREVO_CLE_API=xkeysib-… BREVO_EXPEDITEUR=envoi@… \
 *   COURRIEL_DESTINATION=vous@exemple.com \
 *   node scripts/bac-a-sable-courriel.mjs
 */
import { brevo } from "../dist/envoi/transporteurs/brevo.js";
import { resend } from "../dist/envoi/transporteurs/resend.js";
import { redigerCourriel } from "../dist/envoi/redaction.js";

const DESTINATION = process.env["COURRIEL_DESTINATION"] ?? "";

const PASSERELLES = [
  {
    nom: "Brevo",
    cle: process.env["BREVO_CLE_API"] ?? "",
    expediteur: process.env["BREVO_EXPEDITEUR"] ?? "",
    variable: "BREVO_CLE_API",
    fabriquer: (cle, expediteur) =>
      brevo({ cleApi: cle, expediteur, nomExpediteur: "Ndank" }),
    fausseCle: "xkeysib-fausse-cle-pour-eprouver-le-refus",
  },
  {
    nom: "Resend",
    cle: process.env["RESEND_CLE_API"] ?? "",
    expediteur: process.env["RESEND_EXPEDITEUR"] ?? "",
    variable: "RESEND_CLE_API",
    // Resend n'a pas de champ de nom : il se met dans l'expéditeur,
    // « Ndank <envoi@domaine> ».
    fabriquer: (cle, expediteur) => resend({ cleApi: cle, expediteur }),
    fausseCle: "re_fausse_cle_pour_eprouver_le_refus",
  },
];

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

console.log("Ndank — les passerelles de courriel, contre de vraies passerelles\n");

/**
 * Une vraie relance, composée par la bibliothèque.
 *
 * Pas un « ceci est un test » : le sujet, le corps, la salutation et le délai
 * sortent de `redigerCourriel`, comme pour un abonné. C'est le seul moyen de
 * voir ce qu'un abonné verrait — y compris l'encodage des accents, que seule
 * une vraie boîte peut démentir.
 */
const message = {
  cle: "20260911-J0",
  destinataire: "Awa",
  offre: "Pass Créateur",
  montant: "2 000 F CFA",
  lien: "https://exemple.ci/ndank/r/jeton-de-demonstration",
  joursRestants: 0,
  dernier: false,
};

const contenu = redigerCourriel(message);

console.log("▸ Ce que la bibliothèque a rédigé");
console.log(`  sujet : ${contenu.sujet}`);
console.log(`  corps : ${contenu.texte.length} caractères\n`);

verifier("le sujet n'est pas vide", contenu.sujet.length > 0);
verifier("le corps porte le lien", contenu.texte.includes(message.lien));
verifier("l'abonné est salué par son nom", contenu.texte.includes("Awa"));

// ══════════════════════════════════════════════════════════════════════════

for (const p of PASSERELLES) {
  console.log(`\n▸ ${p.nom}`);

  if (p.cle === "" || p.expediteur === "") {
    sauter(
      `${p.nom} n'a pas été éprouvé`,
      `${p.variable} ou son expéditeur est absent.`,
    );
    continue;
  }

  const passerelle = p.fabriquer(p.cle, p.expediteur);

  // ── 1. un envoi réel ────────────────────────────────────────────────────
  if (DESTINATION === "") {
    sauter(
      "aucun envoi réel",
      "COURRIEL_DESTINATION absent. On ne devine pas une adresse à qui écrire.",
    );
  } else {
    let remise;
    try {
      remise = await passerelle.envoyer(
        { nom: "Awa", courriel: DESTINATION, telephone: null, appareils: [] },
        contenu,
      );
    } catch (cause) {
      verifier(`${p.nom} accepte la relance`, false, String(cause).slice(0, 200));
      continue;
    }

    console.log(`  parti : ${remise.parti}  référence : ${remise.reference ?? "—"}`);

    verifier(`${p.nom} accepte la relance`, remise.parti === true);
    verifier(
      "et rend un identifiant, par lequel on pourra un jour la suivre",
      remise.reference !== null,
    );
  }

  // ── 2. une clé fausse doit être refusée ─────────────────────────────────
  // Sans quoi la vérification ne vérifie rien : une passerelle qui accepte
  // n'importe quelle clé accepterait aussi la nôtre après sa révocation, et
  // le moteur compterait des relances parties qui n'existent pas.
  const menteuse = p.fabriquer(p.fausseCle, p.expediteur);
  let refuse = false;
  try {
    const r = await menteuse.envoyer(
      { nom: null, courriel: DESTINATION || "essai@exemple.test", telephone: null, appareils: [] },
      contenu,
    );
    refuse = r.parti === false;
  } catch {
    refuse = true;
  }
  verifier("une clé fausse est refusée", refuse);

  // ── 3. une adresse absente n'est pas une panne ──────────────────────────
  // Beaucoup d'abonnés n'ont pas de courriel. Le moteur doit passer au canal
  // suivant, pas lever.
  const sansAdresse = await passerelle.envoyer(
    { nom: "Awa", courriel: null, telephone: "+2250700000000", appareils: [] },
    contenu,
  );
  verifier(
    "un abonné sans adresse rend « pas parti » plutôt que de lever",
    sansAdresse.parti === false,
  );
}

// ══════════════════════════════════════════════════════════════════════════

console.log(`\n${passes} vérifiées, ${echecs} en échec, ${sautes} hors de portée.`);

if (echecs > 0) {
  console.error("\nLa chaîne du courriel ne tient pas.");
  process.exit(1);
}

if (DESTINATION !== "") {
  console.log(
    `\nAllez ouvrir ${DESTINATION} — **et les indésirables.** « Parti » veut dire\n` +
      "« accepté par la passerelle », jamais « lu par quelqu'un ». Sans SPF ni\n" +
      "DMARC sur le domaine d'envoi, un courriel parfaitement accepté finit\n" +
      "dans le dossier que personne n'ouvre.",
  );
}
