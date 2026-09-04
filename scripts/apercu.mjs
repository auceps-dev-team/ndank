/**
 * Ndank — voir les pages sans monter de serveur.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI CE SCRIPT EXISTE, MAINTENANT QUE L'APPLICATION EST AILLEURS
 *
 * Les tableaux de bord vivent dans Ndank App, et cette bibliothèque n'a plus à
 * s'en occuper. Mais deux pages restent de son ressort, parce qu'elles sont
 * servies par le serveur du marchand et par personne d'autre : celle qu'un
 * abonné ouvre en cliquant le lien de son SMS, et le checkout public qu'on met
 * sur un site.
 *
 * Un marchand qui les intègre a besoin de les voir avant de les brancher. Sans
 * ce script, il lui faut une base, un fournisseur de paiement, un jeton signé
 * et un abonné en retard — c'est-à-dire tout le système en marche pour vérifier
 * une couleur de bouton.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL PASSE PAR LE ROUTEUR, ET NON PAR LE RENDU
 *
 * `page/rendu` n'est pas exporté du paquet : un hôte monte `routeurPage` et ne
 * touche jamais aux fonctions de rendu. Appeler celles-ci directement ici
 * donnerait un aperçu de quelque chose que personne n'exécute — et laisserait
 * passer sans bruit une erreur de routage, un mauvais code de statut ou une vue
 * mal choisie.
 *
 * Ce qu'on rend est donc exactement ce qu'un abonné recevrait, statut compris.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LES DATES SONT RELATIVES À AUJOURD'HUI, ET C'EST NÉCESSAIRE
 *
 * Des dates fixes vieilliraient : au bout de quelques semaines l'abonnement
 * serait au-delà de sa fenêtre de reprise, la page répondrait 410, et l'aperçu
 * ne montrerait plus qu'un message d'expiration. C'est arrivé la première fois
 * que ce script a tourné.
 *
 *   node scripts/apercu.mjs [dossier]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { routeurPage } from "../dist/page/routeur.js";
import { lienOffre, signerLien } from "../dist/page/lien.js";

const SORTIE = process.argv[2] ?? "apercu-pages";
const BASE = "https://p.exemple.ci/v";
const SECRET = "un-secret-d-apercu-qui-ne-sert-a-rien-d-autre";
const J = 86_400_000;

/**
 * Un abonné à trois jours de son échéance : c'est le moment où la page compte.
 * Il a encore son accès, il a reçu un rappel, et il n'a pas encore payé.
 */
const abonnement = {
  id: "abo-apercu",
  abonneId: "usr-apercu",
  cadence: "MENSUEL",
  cycle: {
    debut: new Date(Date.now() - 27 * J),
    echeance: new Date(Date.now() + 3 * J),
    accesJusquA: new Date(Date.now() + 10 * J),
    repriseJusquA: new Date(Date.now() + 40 * J),
  },
  resilieeLe: null,
  suspenduLe: null,
  montant: 5000,
  devise: "XOF",
  libelle: "Pass Créateur",
};

/**
 * Un faux encaissement.
 *
 * L'aperçu ne demande jamais de paiement — il ne fait que des `GET`. Le
 * fournisseur n'est là que parce que la page affiche la liste des moyens, et
 * qu'un routeur sans aucun moyen n'aurait rien à montrer.
 */
const faux = () => ({
  async demander() {
    return { issue: "EN_ATTENTE", identifiant: "apercu", instruction: null };
  },
  async etat() {
    return { issue: "EN_ATTENTE" };
  },
});

const routeur = routeurPage({
  base: BASE,
  secret: SECRET,
  marque: "Votre marque",
  dossier: {
    async abonnement(id) {
      return id === abonnement.id ? abonnement : null;
    },
  },
  fournisseurs: [
    { nom: "orange", libelle: "Orange Money", encaissement: faux() },
    { nom: "wave", libelle: "Wave", encaissement: faux() },
    { nom: "mtn", libelle: "MTN MoMo", encaissement: faux() },
  ],
  montant: (mineures, devise) => `${mineures.toLocaleString("fr-FR")} ${devise}`,
  retour: "https://exemple.ci",
  indicatifParDefaut: "225",
  offres: async () => [
    {
      id: "createur",
      libelle: "Pass Créateur",
      montant: 5000,
      devise: "XOF",
      cadence: "MENSUEL",
      actif: true,
    },
  ],
  souscriptions: {
    async abonne() {
      return abonnement.abonneId;
    },
    async abonneParReference() {
      return null;
    },
    async enCours() {
      return null;
    },
    async ouvrir() {
      return abonnement;
    },
  },
});

const jourLimite = Math.floor(Date.now() / J) + 15;
const jetonRelance = signerLien(SECRET, {
  abonnementId: abonnement.id,
  jourLimite,
});
const jetonOffre = lienOffre(BASE, SECRET, "createur").split("/o/")[1];

const pages = [
  [
    "relance.html",
    `/${jetonRelance}`,
    "ce que l'abonné voit en cliquant le lien de son SMS",
  ],
  [
    "checkout.html",
    `/o/${jetonOffre}`,
    "le lien public qu'on met sur un site pour vendre une offre",
  ],
];

mkdirSync(SORTIE, { recursive: true });

let fautes = 0;

for (const [nom, chemin, quoi] of pages) {
  const reponse = await routeur({ methode: "GET", chemin, parametres: {} });

  writeFileSync(join(SORTIE, nom), reponse.corps, "utf8");

  // Le statut est vérifié et non seulement affiché : une page qui rend 410
  // s'ouvre parfaitement dans un navigateur et ne montre pas ce qu'on croit.
  const va = reponse.statut === 200;
  if (!va) fautes += 1;

  console.log(
    `  ${va ? "✓" : "✗"} ${nom.padEnd(15)} ${reponse.statut}  ` +
      `${String(reponse.corps.length).padStart(5)} octets  — ${quoi}`,
  );
}

console.log(`\n→ dans ${SORTIE}/ — à ouvrir dans un navigateur.`);
console.log("  Autonomes : ni JavaScript, ni ressource externe, thème clair et sombre.");

if (fautes > 0) {
  console.error(`\n${fautes} page(s) n'ont pas rendu 200.`);
  process.exit(1);
}
