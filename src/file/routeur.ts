import { timingSafeEqual } from "node:crypto";

import type { ReponseWeb, RequeteWeb } from "../web";
import type { Accuse, FileSms, MessageEnAttente } from "./port";

/**
 * Ndank — la route que l'appareil du marchand vient interroger.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * DU VRAI LONG-POLLING, ET NON UNE INTERROGATION TOUTES LES TRENTE SECONDES
 *
 * La différence décide de ce qu'on peut faire avec.
 *
 * Une interrogation périodique — l'appareil demande toutes les trente secondes
 * — suffit pour des relances de nuit. Elle ne suffit pas pour un code de
 * connexion : quelqu'un qui regarde son écran en attendant six chiffres ne
 * comprendra pas trente secondes de silence.
 *
 * Ici, l'appareil ouvre **une** requête que le serveur garde suspendue jusqu'à
 * vingt-cinq secondes, et qu'il libère à l'instant où un message est déposé. La
 * latence tombe à quelques centaines de millisecondes, et le code SMS devient
 * possible sans WebSocket, sans relais, sans rien à opérer.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ON SONDE LA FILE, PLUTÔT QUE D'ÉCOUTER UN ÉVÉNEMENT
 *
 * L'implémentation évidente serait un émetteur d'événements : le dépôt réveille
 * la requête suspendue. Elle serait plus élégante et **fausse dans le cas le
 * plus courant**.
 *
 * Le passage quotidien tourne dans un cron, c'est-à-dire souvent dans un autre
 * processus que le serveur web — parfois sur une autre machine. Un émetteur en
 * mémoire ne franchit pas cette frontière, et la requête resterait suspendue
 * pendant que les messages s'empilent à côté.
 *
 * On interroge donc la file toutes les deux cent cinquante millisecondes. Cela
 * coûte quelques lectures par attente, ce qui est sans commune mesure avec ce
 * que coûterait de se tromper — et cela fonctionne quelle que soit la manière
 * dont l'hôte a réparti ses processus.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QUE CETTE ROUTE COÛTE SELON L'HÉBERGEMENT
 *
 * Tenir une requête ouverte est gratuit sur un serveur persistant — VPS,
 * conteneur, service web Render ou Railway — où elle n'occupe qu'une socket.
 *
 * Sur du serverless facturé à la durée, elle consomme vingt-cinq secondes
 * d'invocation à chaque tour. Réglez alors `attenteMax` bas, ou acceptez une
 * interrogation périodique : `attenteMax: 0` rend la main immédiatement, et la
 * route redevient un simple sondage.
 */

export interface ReglagesRouteurFile {
  file: FileSms;

  /**
   * Le jeton que l'appareil présente. **Obligatoire.**
   *
   * Il ouvre le contenu de tous les SMS en attente — nom de l'offre, montant,
   * numéro, et le lien signé qui mène à la page de paiement. C'est un jeton à
   * part des autres, et il ne doit pas voyager ailleurs que jusqu'à l'appareil.
   */
  jeton: string;

  /** Combien de secondes garder une requête suspendue. Vingt-cinq par défaut. */
  attenteMax?: number;

  /** Combien de messages au plus par requête. Dix par défaut. */
  parLot?: number;

  /** Journal, quand l'hôte en veut un. */
  journal?: (fait: FaitFile) => void;

  /** L'attente. Injectable pour que les tests ne durent pas vingt-cinq secondes. */
  attendre?: (millisecondes: number) => Promise<void>;
  maintenant?: () => Date;
  /** L'intervalle de sondage interne, en millisecondes. */
  sondage?: number;
}

/** Ce qui se passe sur la file, pour qui veut le journaliser. */
export type FaitFile =
  | { quoi: "PRIS"; combien: number }
  | { quoi: "ACQUITTE"; partis: number; echoues: number }
  | { quoi: "REFUS"; raison: "JETON" | "ROUTE" | "CORPS" };

const dormir = (ms: number): Promise<void> =>
  new Promise((resoudre) => setTimeout(resoudre, ms));

/**
 * Monte les deux routes de la file.
 *
 * ```
 * GET  /attente    → les messages à émettre, éventuellement après attente
 * POST /accuses    → ce qu'ils sont devenus
 * ```
 *
 * L'appareil boucle : il demande, il émet, il acquitte, il redemande.
 */
export function routeurFile(
  reglages: ReglagesRouteurFile,
): (requete: RequeteWeb) => Promise<ReponseWeb> {
  if (!reglages.jeton) {
    throw new Error(
      "Ndank : `routeurFile` exige un jeton. Sans lui, la file des SMS — " +
        "numéros, montants, liens signés — serait publique.",
    );
  }

  const attenteMax = (reglages.attenteMax ?? 25) * 1000;
  const parLot = reglages.parLot ?? 10;
  const sondage = reglages.sondage ?? 250;
  const patienter = reglages.attendre ?? dormir;
  const horloge = reglages.maintenant ?? (() => new Date());

  const raconter = (fait: FaitFile): void => {
    try {
      reglages.journal?.(fait);
    } catch {
      /* un journal qui lève ne doit pas arrêter un envoi */
    }
  };

  return async (requete: RequeteWeb): Promise<ReponseWeb> => {
    if (!jetonValide(requete, reglages.jeton)) {
      raconter({ quoi: "REFUS", raison: "JETON" });
      return json(401, { erreur: "Jeton absent ou invalide." });
    }

    const chemin = requete.chemin.replace(/^\/+|\/+$/g, "");

    // ── ce qu'il y a à envoyer ────────────────────────────────────────────
    if (chemin === "attente" && requete.methode === "GET") {
      const demande = Number.parseInt(requete.parametres["max"] ?? "", 10);
      const combien = Number.isFinite(demande)
        ? Math.min(Math.max(demande, 1), parLot)
        : parLot;

      const limite = horloge().getTime() + attenteMax;
      let messages: readonly MessageEnAttente[] = [];

      // Le premier tour est immédiat : quand la file n'est pas vide, l'appareil
      // ne doit pas attendre un intervalle de sondage pour rien.
      for (;;) {
        messages = await reglages.file.prendre(combien, horloge());
        if (messages.length > 0) break;
        if (horloge().getTime() + sondage > limite) break;

        await patienter(sondage);
      }

      if (messages.length === 0) {
        // 204 et non un tableau vide : l'appareil distingue « rien pour toi »
        // de « voici zéro message », et peut redemander sans rien analyser.
        return { statut: 204, entetes: entetes(), corps: "" };
      }

      raconter({ quoi: "PRIS", combien: messages.length });

      return json(
        200,
        messages.map((m) => ({
          id: m.id,
          telephone: m.telephone,
          texte: m.texte,
          expireLe: m.expireLe.toISOString(),
        })),
      );
    }

    // ── ce qu'ils sont devenus ────────────────────────────────────────────
    if (chemin === "accuses" && requete.methode === "POST") {
      let accuses: Accuse[];

      try {
        const lu = JSON.parse(requete.corps ?? "");
        if (!Array.isArray(lu)) throw new Error("pas un tableau");
        accuses = lu.filter(
          (a): a is Accuse =>
            a !== null &&
            typeof a === "object" &&
            typeof a.id === "string" &&
            typeof a.parti === "boolean",
        );
      } catch {
        raconter({ quoi: "REFUS", raison: "CORPS" });
        return json(400, {
          erreur: "Un tableau d'accusés est attendu : [{ id, parti }].",
        });
      }

      await reglages.file.acquitter(accuses, horloge());

      const partis = accuses.filter((a) => a.parti).length;
      raconter({
        quoi: "ACQUITTE",
        partis,
        echoues: accuses.length - partis,
      });

      return json(200, { recus: accuses.length });
    }

    raconter({ quoi: "REFUS", raison: "ROUTE" });
    return json(404, { erreur: "Route inconnue. Voir GET /attente et POST /accuses." });
  };
}

function entetes(): Record<string, string> {
  return {
    "Content-Type": "application/json; charset=utf-8",
    // Les messages portent des numéros et des liens signés : rien de tout cela
    // ne doit finir dans un cache intermédiaire.
    "Cache-Control": "no-store",
  };
}

function json(statut: number, corps: unknown): ReponseWeb {
  return { statut, entetes: entetes(), corps: JSON.stringify(corps) };
}

/**
 * Le jeton présenté, comparé à durée constante.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * L'EN-TÊTE D'ABORD, LE PARAMÈTRE EN DERNIER RECOURS
 *
 * `RequeteWeb` porte les en-têtes, en minuscules — on lit donc
 * `Authorization: Bearer …`, qui est la bonne place pour un secret.
 *
 * Le paramètre d'URL reste accepté parce que certains clients embarqués ne
 * savent poser aucun en-tête. Il est moins bon : un jeton dans une URL finit
 * dans les journaux d'accès du serveur, et souvent dans ceux d'un
 * intermédiaire. À n'employer que si l'appareil ne laisse pas le choix.
 */
function jetonValide(requete: RequeteWeb, attendu: string): boolean {
  const brut = bearer(requete) ?? requete.parametres["jeton"];
  if (!brut) return false;

  const x = Buffer.from(brut, "utf8");
  const y = Buffer.from(attendu, "utf8");
  if (x.length !== y.length) return false;

  return timingSafeEqual(x, y);
}

/** `Authorization: Bearer …`, ou `null`. */
function bearer(requete: RequeteWeb): string | null {
  const ligne = requete.entetes["authorization"];
  if (!ligne) return null;

  const [schema, valeur] = ligne.split(" ");

  return schema?.toLowerCase() === "bearer" && valeur ? valeur : null;
}
