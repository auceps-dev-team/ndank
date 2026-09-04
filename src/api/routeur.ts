import { timingSafeEqual } from "node:crypto";

import { joursEntre } from "../cycle";
import { etatDe, type Etat } from "../etats";
import type { ReponseWeb, RequeteWeb } from "../page/port";
import { bornesDe, type LigneTableau, type Tableau } from "./tableau";

/**
 * Ndank — l'API que le tableau de bord consomme.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ELLE NE SAIT QUE LIRE, ET CE N'EST PAS UNE POLITESSE
 *
 * Le tableau de bord ne parle pas à la base : il parle à cette API. Le détour
 * existe pour une raison précise — rendre une manipulation depuis le tableau de
 * bord **impossible** plutôt qu'interdite.
 *
 * Une application cliente est distribuée. Son code est lisible, son jeton est
 * extractible, et tout ce qu'elle peut faire, quiconque tient ce jeton peut le
 * faire. Si elle parlait à la base, « lecture seule » reposerait sur des droits
 * qu'on aurait pensé à restreindre — et qu'on aurait un jour élargis « juste
 * pour un bouton ».
 *
 * Ici il n'y a rien à restreindre. Le port `Tableau` n'a aucun verbe qui écrit,
 * et ce routeur refuse tout ce qui n'est pas `GET`. Un jeton volé donne accès à
 * des chiffres, jamais à un changement.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CES CHIFFRES SONT DES DONNÉES PERSONNELLES
 *
 * Une ligne dit ce que telle personne doit, à quoi elle est abonnée, et depuis
 * combien de temps elle est en retard. Sans authentification, l'adresse est
 * publique et le fichier d'abonnés avec elle.
 *
 * Le jeton est donc obligatoire — `routeurApi` refuse de se construire sans —
 * et comparé à temps constant. Ce dernier point compte plus qu'il n'en a l'air :
 * une comparaison ordinaire sort au premier caractère qui diffère, et le temps
 * de réponse laisse alors deviner le jeton, caractère par caractère.
 */

/** Combien de lignes une page peut rendre. */
export const PAR_PAGE_MAX = 100;
const PAR_PAGE_DEFAUT = 25;

/** Les états qu'on peut demander. Dérivé, pour qu'un ajout suive tout seul. */
const ETATS: readonly Etat[] = [
  "ACTIVE",
  "A_RENOUVELER",
  "SUSPENDUE",
  "RESILIEE",
  "EXPIREE",
];

export interface ReglagesApi {
  tableau: Tableau;
  /**
   * Le jeton que le tableau de bord présente.
   *
   * Obligatoire. Le rendre facultatif aurait fait qu'un oubli de configuration
   * ouvre le fichier d'abonnés — une panne silencieuse, du genre qu'on ne
   * découvre pas.
   */
  jeton: string;
  /** Où raconter les accès. Facultatif. */
  journal?: (fait: { route: string; statut: number }) => void;
}

function json(statut: number, valeur: unknown): ReponseWeb {
  return {
    statut,
    entetes: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    },
    corps: JSON.stringify(valeur),
  };
}

/** Comparaison à temps constant. Deux longueurs différentes valent faux. */
function memeJeton(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");

  if (x.length !== y.length) return false;

  return timingSafeEqual(x, y);
}

/** Le jeton présenté, ou `null`. */
function jetonPresente(requete: RequeteWeb): string | null {
  const entete = requete.entetes["authorization"];
  if (typeof entete !== "string") return null;

  const trouve = /^Bearer\s+(.+)$/i.exec(entete.trim());
  return trouve?.[1] ?? null;
}

/** Une ligne, telle que le tableau de bord la reçoit. */
function versJson(
  ligne: LigneTableau,
  maintenant: Date,
): Record<string, unknown> {
  const etat = etatDe(
    {
      cycle: {
        debut: ligne.echeance,
        echeance: ligne.echeance,
        accesJusquA: ligne.accesJusquA,
        repriseJusquA: ligne.repriseJusquA,
      },
      resilieeLe: ligne.resilieeLe,
    },
    maintenant,
  );

  return {
    id: ligne.id,
    abonneId: ligne.abonneId,
    libelle: ligne.libelle,
    montant: ligne.montant,
    devise: ligne.devise,
    cadence: ligne.cadence,
    // L'état est calculé ici, à l'instant de la réponse — jamais lu d'une
    // colonne. C'est la même règle que partout : la base garde les faits, pas
    // les conclusions.
    etat,
    echeance: ligne.echeance.toISOString(),
    accesJusquA: ligne.accesJusquA.toISOString(),
    repriseJusquA: ligne.repriseJusquA.toISOString(),
    joursRestants: joursEntre(maintenant, ligne.accesJusquA),
    resilieeLe: ligne.resilieeLe?.toISOString() ?? null,
    closLe: ligne.closLe?.toISOString() ?? null,
  };
}

/**
 * Fabrique le routeur de l'API.
 *
 *   `GET /resume`             les comptes par état, et ce qu'ils représentent ;
 *   `GET /abonnements`        une page, filtrée par état ;
 *   `GET /abonnements/<id>`   un abonnement.
 */
export function routeurApi(
  reglages: ReglagesApi,
): (requete: RequeteWeb) => Promise<ReponseWeb> {
  if (reglages.jeton.trim() === "") {
    // À la construction, et non au premier appel : le premier appel viendrait
    // du tableau de bord, mais le second pourrait venir de n'importe qui.
    throw new Error(
      "routeurApi : un jeton est obligatoire. Sans lui, l'adresse expose le " +
        "fichier d'abonnés — ce que chaque ligne dit, c'est ce que telle " +
        "personne doit.",
    );
  }

  const raconter = (route: string, statut: number): void => {
    try {
      reglages.journal?.({ route, statut });
    } catch {
      /* le journal observe */
    }
  };

  return async function repondre(requete: RequeteWeb): Promise<ReponseWeb> {
    const morceaux = requete.chemin.split("/").filter((m) => m !== "");
    const route = `/${morceaux.join("/")}`;

    const rendre = (reponse: ReponseWeb): ReponseWeb => {
      raconter(route, reponse.statut);
      return reponse;
    };

    // Aucune méthode qui écrit n'est acceptée, pas même en la déclarant.
    // C'est la moitié de la raison d'être de cette API.
    if (requete.methode.toUpperCase() !== "GET") {
      return rendre(
        json(405, {
          erreur: "Cette API est en lecture seule.",
        }),
      );
    }

    const presente = jetonPresente(requete);

    if (presente === null || !memeJeton(presente, reglages.jeton)) {
      return rendre(json(401, { erreur: "Jeton absent ou invalide." }));
    }

    const maintenant = new Date();

    if (morceaux[0] === "resume" && morceaux.length === 1) {
      return rendre(json(200, await resume(reglages.tableau, maintenant)));
    }

    if (morceaux[0] === "abonnements" && morceaux.length === 1) {
      return rendre(await lister(reglages, requete, maintenant));
    }

    if (morceaux[0] === "abonnements" && morceaux.length === 2) {
      const ligne = await reglages.tableau.ligne(morceaux[1]!);

      if (ligne === null) {
        return rendre(json(404, { erreur: "Abonnement introuvable." }));
      }

      return rendre(json(200, versJson(ligne, maintenant)));
    }

    return rendre(json(404, { erreur: "Route inconnue." }));
  };
}

/**
 * Les comptes par état.
 *
 * Un appel par état, et non un balayage : c'est le seul moyen d'obtenir ces
 * chiffres sans charger la table, puisqu'aucune colonne ne porte l'état. Cinq
 * requêtes indexées valent mieux qu'une lecture complète, y compris à cent
 * mille abonnés.
 */
async function resume(
  tableau: Tableau,
  maintenant: Date,
): Promise<Record<string, unknown>> {
  const comptes: Record<string, number> = {};

  for (const etat of ETATS) {
    comptes[etat] = await tableau.compter(bornesDe(etat, maintenant));
  }

  const actifs = (comptes["ACTIVE"] ?? 0) + (comptes["A_RENOUVELER"] ?? 0);

  return {
    calculeLe: maintenant.toISOString(),
    comptes,
    /** Ceux qui ont accès au service, maintenant. C'est le chiffre qui compte. */
    actifs,
    /** Ceux qu'il faut aller chercher : la grâce court encore. */
    aRattraper: (comptes["A_RENOUVELER"] ?? 0) + (comptes["SUSPENDUE"] ?? 0),
  };
}

/** Une page d'abonnements. */
async function lister(
  reglages: ReglagesApi,
  requete: RequeteWeb,
  maintenant: Date,
): Promise<ReponseWeb> {
  const demande = requete.parametres["etat"];

  if (demande !== undefined && !ETATS.includes(demande as Etat)) {
    return json(400, {
      erreur: `État inconnu : « ${demande} ».`,
      connus: ETATS,
    });
  }

  // Sans état demandé, on rend les vivants — ceux dont il peut encore advenir
  // quelque chose. Rendre tout le fichier par défaut ferait payer une lecture
  // complète à chaque ouverture du tableau de bord.
  const bornes =
    demande === undefined
      ? { resiliee: false, close: false }
      : bornesDe(demande as Etat, maintenant);

  const depuis = Math.max(0, entier(requete.parametres["depuis"], 0));
  const combien = Math.min(
    PAR_PAGE_MAX,
    Math.max(1, entier(requete.parametres["combien"], PAR_PAGE_DEFAUT)),
  );

  const [total, lignes] = await Promise.all([
    reglages.tableau.compter(bornes),
    reglages.tableau.lister(bornes, { depuis, combien }),
  ]);

  return json(200, {
    total,
    depuis,
    combien,
    lignes: lignes.map((l) => versJson(l, maintenant)),
  });
}

function entier(valeur: string | undefined, defaut: number): number {
  const n = Number.parseInt(valeur ?? "", 10);
  return Number.isFinite(n) ? n : defaut;
}
