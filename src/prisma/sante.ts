import type { Battements, Trace } from "../battement";
import type { BilanCanal, Signaux } from "../sante";
import type { ClientNdank } from "./client";

/**
 * Ndank — les signaux de santé, lus dans une base Prisma.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * D'OÙ VIENT « TENTÉS », ET POURQUOI PAS DU JOURNAL
 *
 * C'est le seul arbitrage de ce fichier, et il vaut d'être écrit parce que le
 * chemin évident donne un résultat faux.
 *
 * Le journal ne conserve **pas** les envois réussis, sauf si l'hôte a demandé
 * `envoisReussis: true` — c'est délibéré, un envoi qui part n'a rien à
 * raconter. En tirer les tentatives donnerait donc `tentes === echoues` pour
 * tous les canaux, et `bilan()` annoncerait chaque jour que toutes les
 * passerelles sont mortes. Une alerte qui se déclenche toujours ne se lit plus
 * au bout d'une semaine.
 *
 * Les envois réussis se comptent donc ailleurs : dans `Relance.canaux`, qui
 * porte « les canaux par lesquels elle est effectivement partie » et qui est
 * écrit quoi qu'il arrive. Tentés = partis + échoués, chacun lu là où il est
 * réellement.
 */

export interface ReglagesSignaux {
  projetId: string;
  /** Les canaux qu'on interroge. Ceux que l'hôte a réellement branchés. */
  canaux?: readonly string[];
}

const CANAUX = ["COURRIEL", "SMS", "PUSH"] as const;

/**
 * Branche les signaux sur une base Prisma.
 *
 * Le battement est fourni à part : il vient de `portsPrisma`, et il n'y a
 * aucune raison d'en construire un second.
 */
export function signauxPrisma(
  client: ClientNdank,
  battements: Battements,
  reglages: ReglagesSignaux,
): Signaux {
  const { projetId } = reglages;
  const canaux = reglages.canaux ?? CANAUX;

  return {
    battements,

    async envois(depuis: Date, jusqua: Date): Promise<readonly BilanCanal[]> {
      const bilans: BilanCanal[] = [];

      for (const canal of canaux) {
        // Les partis : `has` sur le tableau de canaux de la relance.
        const partis = await client.relance.count({
          where: {
            abonnement: { projetId },
            envoyeeLe: { gte: depuis, lt: jusqua },
            canaux: { has: canal },
          },
        });

        // Les échoués : le journal, où le canal vit dans le détail JSON.
        const echoues = await client.evenement.count({
          where: {
            projetId,
            type: "envoi.echoue",
            quandLe: { gte: depuis, lt: jusqua },
            detail: { path: ["canal"], equals: canal },
          },
        });

        // Un canal dont il ne s'est rien passé n'est pas un canal mort : il
        // n'avait rien à faire. L'omettre évite d'avoir à distinguer les deux
        // plus haut.
        if (partis + echoues > 0) {
          bilans.push({ canal: libelle(canal), tentes: partis + echoues, echoues });
        }
      }

      return bilans;
    },

    /**
     * L'argent arrivé qui n'a rien prolongé.
     *
     * Le filtre porte sur `regleLe` et non sur `creeLe` : ce qu'on cherche,
     * c'est un paiement **arrivé** récemment et resté sans effet. Un versement
     * créé il y a un mois et réglé ce matin est exactement le cas qui doit
     * remonter, et `creeLe` le manquerait.
     */
    async paiementsNonComptes(depuis: Date): Promise<number> {
      return client.versement.count({
        where: {
          abonnement: { projetId },
          etat: "REUSSI",
          compteLe: null,
          regleLe: { gte: depuis },
        },
      });
    },

    async signaturesRefusees(depuis: Date): Promise<number> {
      return client.webhookRecu.count({
        where: { projetId, signatureValide: false, recuLe: { gte: depuis } },
      });
    },

    /**
     * Les injoignables, tels que le dernier passage les a comptés.
     *
     * On les reprend de la trace plutôt que de refaire la requête : le moteur
     * vient de parcourir exactement les abonnements concernés, en appliquant sa
     * propre définition de « à relancer ». Une seconde requête, écrite ici,
     * finirait par répondre autre chose le jour où l'échelle change.
     */
    async injoignables(): Promise<number> {
      const trace: Trace | null = await battements.dernier();

      return trace?.injoignables ?? 0;
    },
  };
}

/** Le nom du canal tel qu'on le dit dans une phrase. */
function libelle(canal: string): string {
  switch (canal) {
    case "COURRIEL":
      return "courriel";
    case "SMS":
      return "SMS";
    case "PUSH":
      return "push";
    default:
      return canal.toLowerCase();
  }
}
