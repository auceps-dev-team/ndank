import { httpParDefaut, type Http } from "../http";
import type { Coordonnees } from "../ports";
import type { TransporteurSms } from "../envoi/port";
import type { Accuse } from "./port";

/**
 * Ndank — celui qui vient chercher.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL N'A PAS BESOIN D'ÊTRE UNE APPLICATION ANDROID
 *
 * C'était le dernier morceau annoncé comme « pas du TypeScript », et c'était
 * une erreur de cadrage. Le problème n'a jamais été d'écrire une application
 * mobile : il était que la passerelle et le serveur ne peuvent pas se joindre.
 *
 * Cet agent tourne chez le marchand — un Raspberry Pi, un vieux portable, la
 * machine du bureau — et se place **entre les deux** :
 *
 *     serveur du marchand  ←── long-poll sortant ──  agent  ──→  téléphone
 *        (Vercel, VPS)                            (au bureau)     (sur le LAN)
 *
 * Vers le serveur, il appelle : le NAT est traversé. Vers le téléphone, il est
 * sur le même réseau : l'adresse privée est joignable. Les deux moitiés du
 * problème se résolvent parce que quelqu'un se tient au milieu.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL NE SAIT PAS ENVOYER UN SMS, ET C'EST VOULU
 *
 * Il reçoit un `TransporteurSms` et le lui confie. Le même agent sert donc une
 * passerelle Android, un modem USB, ou Twilio en dépannage — sans qu'une ligne
 * de cette boucle ne change.
 *
 * C'est le motif du dépôt : une boucle sur des ports, et rien de plus.
 */

export interface ReglagesAgent {
  /** L'adresse où la file est montée, sans barre finale. */
  base: string;

  /** Le jeton de la file. Le même que celui de `routeurFile`. */
  jeton: string;

  /** Ce qui émet réellement. Passerelle Android, modem, ou autre. */
  transporteur: TransporteurSms;

  http?: Http;

  /** Combien de messages demander par tour. Dix par défaut. */
  parLot?: number;

  /**
   * Combien de temps souffler après une erreur réseau, en millisecondes.
   *
   * Cinq secondes. Sans pause, un serveur inaccessible ferait tourner la boucle
   * à pleine vitesse — et l'agent, censé attendre patiemment, deviendrait la
   * charge qu'il est supposé alléger.
   */
  pauseErreur?: number;

  /** Ce que l'agent fait, pour qui veut le suivre. */
  journal?: (fait: FaitAgent) => void;

  attendre?: (millisecondes: number) => Promise<void>;
  maintenant?: () => Date;
}

export type FaitAgent =
  | { quoi: "LOT"; recus: number; partis: number; expires: number }
  | { quoi: "VIDE" }
  | { quoi: "ERREUR"; ou: "FILE" | "ENVOI"; cause: string }
  /** Le jeton ne passe plus. L'agent s'arrête : réessayer n'y changerait rien. */
  | { quoi: "REFUSE"; statut: number };

const dormir = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** Ce que la file rend à l'agent. */
interface Attente {
  id: string;
  telephone: string;
  texte: string;
  expireLe: string;
}

/**
 * Construit l'agent. Il ne tourne qu'une fois `demarrer()` appelé.
 *
 * ```ts
 * const agent = agentSms({
 *   base: "https://mon-app.ci/sms",
 *   jeton: process.env.NDANK_FILE_JETON,
 *   transporteur: passerelleAndroid({ base: "http://192.168.1.42:8080", ... }),
 * });
 *
 * await agent.demarrer();
 * ```
 */
export function agentSms(reglages: ReglagesAgent): {
  demarrer(): Promise<void>;
  arreter(): void;
} {
  const http = reglages.http ?? httpParDefaut;
  const base = reglages.base.replace(/\/+$/, "");
  const parLot = reglages.parLot ?? 10;
  const pauseErreur = reglages.pauseErreur ?? 5000;
  const patienter = reglages.attendre ?? dormir;
  const horloge = reglages.maintenant ?? (() => new Date());

  let tourne = false;

  const raconter = (fait: FaitAgent): void => {
    try {
      reglages.journal?.(fait);
    } catch {
      /* un journal qui lève ne doit pas arrêter l'agent */
    }
  };

  const entetes = { Authorization: `Bearer ${reglages.jeton}` };

  async function unTour(): Promise<"CONTINUE" | "ARRETE"> {
    let lot: Attente[];

    try {
      const reponse = await http({
        methode: "GET",
        url: `${base}/attente?max=${parLot}`,
        entetes,
      });

      // 401 et 403 ne se réessaient pas : le jeton est faux ou révoqué, et
      // boucler dessus n'ajouterait que du bruit dans les journaux du serveur.
      if (reponse.statut === 401 || reponse.statut === 403) {
        raconter({ quoi: "REFUSE", statut: reponse.statut });
        return "ARRETE";
      }

      if (reponse.statut === 204) {
        raconter({ quoi: "VIDE" });
        return "CONTINUE";
      }

      if (reponse.statut !== 200) {
        throw new Error(`la file a répondu ${reponse.statut}`);
      }

      lot = JSON.parse(reponse.corps) as Attente[];
    } catch (cause) {
      raconter({ quoi: "ERREUR", ou: "FILE", cause: String(cause).slice(0, 200) });
      await patienter(pauseErreur);
      return "CONTINUE";
    }

    if (lot.length === 0) return "CONTINUE";

    const accuses: Accuse[] = [];
    let partis = 0;
    let expires = 0;

    for (const m of lot) {
      /**
       * La péremption se revérifie **ici**, et non seulement à la prise.
       *
       * ═══════════════════════════════════════════════════════════════════
       * UN LOT MET DU TEMPS À S'ÉCOULER
       *
       * Avec un espacement de six secondes, dix messages prennent une minute.
       * Le dixième peut donc avoir expiré pendant qu'on envoyait les neuf
       * premiers — et un rappel qui arrive après sa date dit le contraire de
       * ce qu'il devait dire.
       *
       * On l'acquitte comme parti pour qu'il quitte la file : il n'a plus lieu
       * d'être envoyé, et le rendre le ferait réessayer indéfiniment jusqu'à
       * ce que la file le purge d'elle-même.
       */
      if (new Date(m.expireLe).getTime() <= horloge().getTime()) {
        expires += 1;
        accuses.push({ id: m.id, parti: true, reference: null });
        continue;
      }

      const ou: Coordonnees = {
        nom: null,
        courriel: null,
        telephone: m.telephone,
        appareils: [],
      };

      try {
        const remise = await reglages.transporteur.envoyer(ou, {
          texte: m.texte,
          segments: 1,
          perdus: [],
          tronque: false,
        });

        if (remise.parti) partis += 1;
        accuses.push({
          id: m.id,
          parti: remise.parti,
          reference: remise.reference,
        });
      } catch (cause) {
        // Une passerelle qui lève ne doit pas emporter le reste du lot : les
        // neuf autres messages n'y sont pour rien.
        raconter({
          quoi: "ERREUR",
          ou: "ENVOI",
          cause: String(cause).slice(0, 200),
        });
        accuses.push({
          id: m.id,
          parti: false,
          cause: String(cause).slice(0, 200),
        });
      }
    }

    /**
     * On acquitte toujours, y compris les échecs.
     *
     * Se taire laisserait les messages sous bail jusqu'à son expiration —
     * plusieurs minutes pendant lesquelles personne ne peut les reprendre,
     * alors qu'on sait déjà qu'ils ont échoué et qu'il faut réessayer.
     */
    try {
      await http({
        methode: "POST",
        url: `${base}/accuses`,
        entetes: { ...entetes, "Content-Type": "application/json" },
        corps: JSON.stringify(accuses),
      });
    } catch (cause) {
      raconter({ quoi: "ERREUR", ou: "FILE", cause: String(cause).slice(0, 200) });
      await patienter(pauseErreur);
    }

    raconter({ quoi: "LOT", recus: lot.length, partis, expires });

    return "CONTINUE";
  }

  return {
    async demarrer(): Promise<void> {
      tourne = true;

      while (tourne) {
        if ((await unTour()) === "ARRETE") break;
      }

      tourne = false;
    },

    arreter(): void {
      tourne = false;
    },
  };
}
