import { timingSafeEqual } from "node:crypto";

import type { Reglages } from "../cycle";
import {
  marquerPaye,
  relancerMaintenant,
  resilier,
  retablir,
  suspendre,
  type PortsIntervention,
  type Suite,
} from "../intervention";
import type { AbonnementLu } from "../ports";
import type { Politique } from "../reglement";
import type { ReponseWeb, RequeteWeb } from "../web";

/**
 * Ndank — les gestes du tableau de bord, sur une adresse à part.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI CE N'EST PAS `routeurApi` QUI GAGNE LE DROIT D'ÉCRIRE
 *
 * `routeurApi` refuse tout ce qui n'est pas `GET`, et il faut que cela reste
 * vrai. La raison n'a pas changé : il est fait pour une **application cliente**,
 * distribuée, dont le code est lisible et le jeton extractible. Tout ce qu'elle
 * peut faire, quiconque tient ce jeton peut le faire.
 *
 * Les gestes manuels ne sont pas pour elle. Ils sont pour le **serveur de
 * l'hôte**, qui sait qui est connecté, qui journalise ses accès, et qui ne
 * distribue son jeton à personne. Deux publics, deux adresses, deux jetons.
 *
 * Les mélanger aurait fait qu'un jeton volé dans une application Android donne
 * le droit de marquer des abonnements comme payés.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * L'AUTEUR EST OBLIGATOIRE, ET IL NE VIENT PAS DU CORPS
 *
 * Chaque geste porte le nom de qui l'a posé. Mais ce nom ne peut pas être un
 * champ que l'appelant remplit à sa guise : il serait alors déclaratif, donc
 * inutile le jour où l'on cherche à comprendre.
 *
 * Il arrive par l'en-tête `X-Ndank-Auteur`, que le serveur de l'hôte pose
 * lui-même à partir de sa session. Ndank ne sait pas qui est connecté — il n'a
 * aucune authentification d'utilisateur — mais il peut exiger que quelqu'un le
 * lui dise, et refuser d'écrire sinon.
 */

export interface ReglagesGestes {
  ports: PortsIntervention;
  /**
   * Le jeton du serveur de l'hôte. **Distinct de celui du tableau de bord.**
   *
   * Le partager reviendrait à donner le droit d'écrire à une application
   * distribuée — ce que toute cette séparation existe pour empêcher.
   */
  jeton: string;
  /** Où l'abonné va valider, et comment écrire un montant. */
  redaction: {
    lien: (a: AbonnementLu) => string;
    montant: (a: AbonnementLu) => string;
  };
  politique?: Politique;
  reglages?: Reglages;
  journal?: (fait: { route: string; auteur: string | null; statut: number }) => void;
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

/** Le code HTTP d'une suite. Un refus n'est pas une panne. */
function statutDe(suite: Suite): number {
  if (suite.faire === "FAIT") return 200;
  // 200 aussi pour « rien à faire » : le geste a été reçu et compris, il n'y
  // avait simplement rien à poser. Un 4xx ferait afficher une erreur à
  // quelqu'un qui a cliqué deux fois.
  if (suite.faire === "RIEN") return 200;

  return 409;
}

function corpsDe(requete: RequeteWeb): Record<string, unknown> {
  if (requete.corps.trim() === "") return {};

  try {
    const lu = JSON.parse(requete.corps) as unknown;
    return lu !== null && typeof lu === "object"
      ? (lu as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Fabrique le routeur des gestes.
 *
 *   `POST /abonnements/<id>/relancer`
 *   `POST /abonnements/<id>/paiement`
 *   `POST /abonnements/<id>/suspendre`
 *   `POST /abonnements/<id>/retablir`
 *   `POST /abonnements/<id>/resilier`
 *
 * Tout est en `POST`, y compris ce qu'on aurait pu mettre en `DELETE`. Un verbe
 * unique rend la règle lisible d'un coup d'œil : sur cette adresse, tout écrit.
 */
export function routeurGestes(
  reglages: ReglagesGestes,
): (requete: RequeteWeb) => Promise<ReponseWeb> {
  if (reglages.jeton.trim() === "") {
    throw new Error(
      "routeurGestes : un jeton est obligatoire, et il doit être DIFFÉRENT de " +
        "celui du tableau de bord. Le partager reviendrait à donner le droit " +
        "d'écrire à une application distribuée.",
    );
  }

  return async function poser(requete: RequeteWeb): Promise<ReponseWeb> {
    const morceaux = requete.chemin.split("/").filter((m) => m !== "");
    const route = `/${morceaux.join("/")}`;
    const auteur = (requete.entetes["x-ndank-auteur"] ?? "").trim();

    const rendre = (reponse: ReponseWeb): ReponseWeb => {
      try {
        reglages.journal?.({ route, auteur: auteur || null, statut: reponse.statut });
      } catch {
        /* le journal observe */
      }
      return reponse;
    };

    if (requete.methode.toUpperCase() !== "POST") {
      return rendre(json(405, { erreur: "Ces gestes s'appellent en POST." }));
    }

    const presente = /^Bearer\s+(.+)$/i.exec(
      (requete.entetes["authorization"] ?? "").trim(),
    )?.[1];

    if (!presente || !memeJeton(presente, reglages.jeton)) {
      return rendre(json(401, { erreur: "Jeton absent ou invalide." }));
    }

    if (auteur === "") {
      // Refuser plutôt que d'écrire « inconnu ». Un journal qui dit « inconnu »
      // à la moitié de ses lignes ne sert plus à rien, et c'est précisément le
      // jour où l'on cherche qui a fait quoi qu'on s'en aperçoit.
      return rendre(
        json(400, {
          erreur:
            "En-tête « X-Ndank-Auteur » manquant. Chaque geste doit porter le " +
            "nom de qui l'a posé — c'est le serveur de l'hôte qui le pose, " +
            "depuis sa session.",
        }),
      );
    }

    if (morceaux[0] !== "abonnements" || morceaux.length !== 3) {
      return rendre(json(404, { erreur: "Route inconnue." }));
    }

    const abonnementId = morceaux[1]!;
    const geste = morceaux[2]!;
    const corps = corpsDe(requete);

    try {
      switch (geste) {
        case "suspendre": {
          const suite = await suspendre(reglages.ports, abonnementId, {
            auteur,
            motif: typeof corps["motif"] === "string" ? corps["motif"] : undefined,
          });
          return rendre(json(statutDe(suite), suite));
        }

        case "retablir": {
          const suite = await retablir(reglages.ports, abonnementId, { auteur });
          return rendre(json(statutDe(suite), suite));
        }

        case "resilier": {
          const suite = await resilier(reglages.ports, abonnementId, {
            auteur,
            motif: typeof corps["motif"] === "string" ? corps["motif"] : undefined,
          });

          return rendre(
            json(statutDe(suite), {
              ...suite,
              // Rendu pour que l'écran puisse le dire : « votre accès tient
              // jusqu'au… ». Le taire ferait croire à une coupure immédiate.
              accesJusquA: suite.accesJusquA?.toISOString() ?? null,
            }),
          );
        }

        case "relancer": {
          const suite = await relancerMaintenant(
            reglages.ports,
            abonnementId,
            reglages.redaction,
            { auteur },
          );
          return rendre(json(statutDe(suite), suite));
        }

        case "paiement": {
          const montant = Number(corps["montant"]);
          const piece = String(corps["piece"] ?? "");
          const moyen = String(corps["moyen"] ?? "");
          const recuLe =
            typeof corps["recuLe"] === "string" ? new Date(corps["recuLe"]) : new Date();

          if (Number.isNaN(recuLe.getTime())) {
            return rendre(json(400, { erreur: "« recuLe » n'est pas une date." }));
          }

          const suite = await marquerPaye(
            reglages.ports,
            abonnementId,
            { montant, piece, recuLe, moyen, auteur },
            reglages.politique ?? "CREDIT",
            reglages.reglages,
          );

          return rendre(json(statutDe(suite), suite));
        }

        default:
          return rendre(json(404, { erreur: `Geste inconnu : « ${geste} ».` }));
      }
    } catch (cause) {
      // `exiger` lève sur un abonnement introuvable : c'est un lien mort, pas
      // une panne du serveur.
      if (cause instanceof Error && /introuvable/.test(cause.message)) {
        return rendre(json(404, { erreur: "Abonnement introuvable." }));
      }

      throw cause;
    }
  };
}
