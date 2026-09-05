import type {
  Accuse,
  FileSms,
  MessageEnAttente,
  Statistiques,
} from "./port";

/**
 * Ndank — une file en mémoire, qui montre comment on en écrit une.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ELLE N'EST PAS FAITE POUR LA PRODUCTION, ET IL FAUT LE DIRE ICI
 *
 * Elle vit dans un processus. Deux instances derrière un répartiteur de charge
 * ont deux files ; un redémarrage vide la sienne, et les relances qui y
 * attendaient sont perdues sans trace.
 *
 * Elle sert à deux choses, et ce sont de bonnes choses :
 *
 *   — **éprouver le chemin complet** — dépôt, prise, bail, accusé — sans base
 *     de données ni téléphone. C'est ce que font les tests de ce dossier ;
 *   — **montrer les règles du port**, en particulier le bail, dont la
 *     documentation seule ne suffit pas à faire comprendre l'importance.
 *
 * Un hôte du niveau 2 la remplace par une table. Le port ne change pas.
 */

export interface ReglagesMemoire {
  /**
   * Combien de temps un message pris reste réservé, en secondes.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * C'EST LE BAIL, ET C'EST TOUTE LA DIFFICULTÉ DU PORT
   *
   * Un appareil qui prend dix messages puis meurt — batterie, réseau coupé,
   * processus tué — n'émettra rien et n'acquittera rien. Sans bail, ces dix
   * messages seraient perdus en silence.
   *
   * Au bout de ce délai, ils redeviennent disponibles. La remise est donc « au
   * moins une fois » : un abonné peut recevoir un rappel en double si
   * l'appareil est mort **entre** l'émission et l'accusé. Pour une relance,
   * c'est le bon sens — mieux vaut un doublon qu'un abonné jamais prévenu.
   *
   * Deux minutes : bien plus que le temps d'émettre un lot, bien moins que
   * l'écart entre deux paliers.
   */
  bailSecondes?: number;
}

interface Ligne {
  message: MessageEnAttente;
  /** Quand il a été pris, ou `null` s'il attend. */
  prisLe: Date | null;
}

export function fileEnMemoire(reglages: ReglagesMemoire = {}): FileSms & {
  /** Tout ce qu'elle contient. Pour les tests. */
  contenu(): readonly MessageEnAttente[];
} {
  const bail = (reglages.bailSecondes ?? 120) * 1000;
  const lignes = new Map<string, Ligne>();

  const disponible = (l: Ligne, maintenant: Date): boolean => {
    if (l.message.expireLe.getTime() <= maintenant.getTime()) return false;
    if (l.prisLe === null) return true;

    return maintenant.getTime() - l.prisLe.getTime() >= bail;
  };

  return {
    contenu() {
      return [...lignes.values()].map((l) => l.message);
    },

    async deposer(message: MessageEnAttente): Promise<void> {
      lignes.set(message.id, { message, prisLe: null });
    },

    async prendre(
      combien: number,
      maintenant: Date,
    ): Promise<readonly MessageEnAttente[]> {
      // Le ménage d'abord : un message expiré n'a plus à occuper la file, et
      // le laisser fausserait `enAttente`, qui sert d'alerte.
      for (const [id, l] of lignes) {
        if (l.message.expireLe.getTime() <= maintenant.getTime()) lignes.delete(id);
      }

      const pris = [...lignes.values()]
        .filter((l) => disponible(l, maintenant))
        // Les plus anciens d'abord : un message qui attend depuis une heure est
        // plus près d'expirer, et sa relance plus près d'être fausse.
        .sort((a, b) => a.message.deposeLe.getTime() - b.message.deposeLe.getTime())
        .slice(0, combien);

      for (const l of pris) l.prisLe = maintenant;

      return pris.map((l) => l.message);
    },

    async acquitter(accuses: readonly Accuse[], maintenant: Date): Promise<void> {
      for (const a of accuses) {
        const l = lignes.get(a.id);
        if (!l) continue;

        if (a.parti) {
          lignes.delete(a.id);
          continue;
        }

        // Rendu à la file, et non supprimé : l'appareil dit qu'il n'a pas pu,
        // pas que le message n'a plus lieu d'être. Il repartira, jusqu'à
        // `expireLe` qui, lui, tranche.
        l.prisLe = null;
        void maintenant;
      }
    },

    async statistiques(maintenant: Date): Promise<Statistiques> {
      let enAttente = 0;
      let enCours = 0;
      let plusAncien: number | null = null;

      for (const l of lignes.values()) {
        if (l.message.expireLe.getTime() <= maintenant.getTime()) continue;

        if (l.prisLe === null || maintenant.getTime() - l.prisLe.getTime() >= bail) {
          enAttente += 1;
          const age = maintenant.getTime() - l.message.deposeLe.getTime();
          if (plusAncien === null || age > plusAncien) plusAncien = age;
        } else {
          enCours += 1;
        }
      }

      return {
        enAttente,
        enCours,
        attenteMax: plusAncien === null ? null : Math.round(plusAncien / 1000),
      };
    },
  };
}
