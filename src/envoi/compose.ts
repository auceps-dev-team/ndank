import type { Canal, Coordonnees, Envoi, Message } from "../ports";
import {
  joignable,
  type FaitEnvoi,
  type JournalEnvoi,
  type Remise,
  type TransporteurCourriel,
  type TransporteurPush,
  type TransporteurSms,
} from "./port";
import {
  redigerCourriel,
  redigerPush,
  redigerSms,
  SEGMENTS_MAX,
  type Courriel,
  type Push,
  type Sms,
} from "./redaction";

/**
 * Ndank — de trois passerelles à un port `Envoi`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * C'EST TOUT CE QU'IL RESTE À CÂBLER
 *
 * Le cœur veut un `Envoi`. Ce fichier en fabrique un à partir de ce que l'hôte
 * a réellement : un compte Resend, un compte Twilio, peut-être rien pour le
 * push. Il rédige, il essaie, il raconte.
 *
 *     const envoi = envoiCompose({
 *       courriel: resend({ cleApi, expediteur: "Baobart <no-reply@baobart.ci>" }),
 *       sms: twilio({ sid, jeton, expediteur: "+225...", indicatifParDefaut: "225" }),
 *     });
 *
 * Le push n'est pas branché : `disponible("push", …)` rendra `false`, le moteur
 * passera au canal suivant du palier, et rien ne cassera. C'est la propriété
 * qui permet de démarrer avec un seul canal.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UN CANAL SANS PASSERELLE N'EST PAS DISPONIBLE
 *
 * Et il faut le dire, parce que la nuance décide de vraies coupures d'accès.
 *
 * Le moteur essaie les canaux du palier dans l'ordre et s'arrête au premier qui
 * part. Si `disponible` rendait `true` pour un canal qu'aucune passerelle ne
 * dessert, l'envoi échouerait, le moteur passerait au suivant — jusqu'ici, tout
 * va bien. Mais au dernier palier, il n'y a pas de suivant : l'échelle sort le
 * SMS parce que l'accès va tomber, et l'abonné serait coupé sans avoir jamais
 * été prévenu.
 *
 * On répond donc `false` avant de dépenser l'appel, et l'hôte voit un
 * `injoignable` dans le bilan du passage — un chiffre qui monte, plutôt qu'une
 * panne silencieuse.
 */

/** Ce que l'hôte a sous la main. Tout est facultatif. */
export interface Transporteurs {
  courriel?: TransporteurCourriel;
  sms?: TransporteurSms;
  push?: TransporteurPush;
}

/**
 * De quoi remplacer la rédaction fournie.
 *
 * `redaction.ts` écrit en français, et son en-tête dit pourquoi. L'hôte qui a
 * besoin d'une autre langue, d'un autre ton, ou d'une mention légale n'écrit
 * pas un gabarit : il fournit ceci et garde tout le reste — les paliers, les
 * clés, la reprise, le budget de segments.
 */
export interface Redacteur {
  courriel(message: Message): Courriel;
  sms(message: Message, segmentsMax?: number): Sms;
  push(message: Message): Push;
}

export const REDACTEUR_PAR_DEFAUT: Redacteur = {
  courriel: redigerCourriel,
  sms: redigerSms,
  push: redigerPush,
};

export interface ReglagesEnvoi {
  /** Où raconter ce qui est parti, et ce qui a levé. */
  journal?: JournalEnvoi;
  /** Le budget d'un SMS de relance. Un segment par défaut. */
  segmentsMax?: number;
  redacteur?: Redacteur;
}

/**
 * Recolle les passerelles et la rédaction en un port `Envoi`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL NE LAISSE JAMAIS REMONTER UNE EXCEPTION
 *
 * C'est sa deuxième raison d'être, et elle vaut d'être dite.
 *
 * Le moteur rattrape les exceptions, mais au niveau de l'abonnement entier :
 * une passerelle SMS en délai d'attente ferait de cet abonné un incident, et
 * les canaux suivants du palier ne seraient jamais essayés. Le push, gratuit et
 * disponible, ne partirait pas parce que le SMS était lent.
 *
 * En rendant `false`, on laisse le moteur descendre l'échelle du palier. Et
 * comme aucun canal n'a abouti, il ne notera pas la relance — donc il
 * réessaiera demain, ce qui est exactement ce qu'on veut d'une panne passagère.
 */
export function envoiCompose(
  transporteurs: Transporteurs,
  reglages: ReglagesEnvoi = {},
): Envoi {
  const redacteur = reglages.redacteur ?? REDACTEUR_PAR_DEFAUT;
  const segmentsMax = reglages.segmentsMax ?? SEGMENTS_MAX;
  const journal = reglages.journal;

  function raconter(fait: FaitEnvoi): void {
    // Un journal qui lève ne doit pas empêcher l'envoi suivant : il observe, il
    // ne participe pas.
    try {
      journal?.(fait);
    } catch {
      /* rien */
    }
  }

  return {
    disponible(canal: Canal, ou: Coordonnees): boolean {
      const transporteur = transporteurs[canal];
      if (transporteur === undefined) return false;

      return transporteur.disponible?.(ou) ?? joignable(canal, ou);
    },

    async envoyer(
      canal: Canal,
      ou: Coordonnees,
      message: Message,
    ): Promise<boolean> {
      const transporteur = transporteurs[canal];

      if (transporteur === undefined) {
        raconter({
          canal,
          transporteur: null,
          cle: message.cle,
          parti: false,
          reference: null,
        });
        return false;
      }

      try {
        // Le `switch` n'est pas une redite du `transporteurs[canal]` ci-dessus :
        // c'est lui qui apparie le canal et le type de contenu. Sans lui, rien
        // n'empêcherait de passer un `Sms` à un transporteur de courriel.
        let remise: Remise;

        switch (canal) {
          case "courriel":
            remise = await transporteurs.courriel!.envoyer(
              ou,
              redacteur.courriel(message),
            );
            break;

          case "sms":
            remise = await transporteurs.sms!.envoyer(
              ou,
              redacteur.sms(message, segmentsMax),
            );
            break;

          case "push":
            remise = await transporteurs.push!.envoyer(
              ou,
              redacteur.push(message),
            );
            break;
        }

        raconter({
          canal,
          transporteur: transporteur.nom,
          cle: message.cle,
          parti: remise.parti,
          reference: remise.reference,
        });

        return remise.parti;
      } catch (cause) {
        raconter({
          canal,
          transporteur: transporteur.nom,
          cle: message.cle,
          parti: false,
          reference: null,
          cause,
        });

        return false;
      }
    },
  };
}

/** Ce qu'un envoi muet a retenu. */
export interface EnvoiRetenu {
  canal: Canal;
  ou: Coordonnees;
  contenu: Courriel | Sms | Push;
  message: Message;
}

/**
 * Un `Envoi` qui rédige tout et n'expédie rien.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL SERT AILLEURS QU'EN TEST
 *
 * En développement, d'abord : on veut voir les relances d'un jeu de données
 * réel sans écrire à de vrais abonnés. C'est le moment où l'on découvre qu'un
 * libellé d'offre fait déborder le SMS.
 *
 * À la mise en service, ensuite. Un premier passage en muet sur la base de
 * production dit combien de messages seraient partis, sur quels canaux, et à
 * qui. Le découvrir après coup, c'est le découvrir sur les réponses des
 * abonnés.
 *
 * Il rédige vraiment — c'est tout l'intérêt. Un faux qui se contenterait de
 * compter ne dirait rien du contenu, et c'est le contenu qui surprend.
 */
export function envoiMuet(reglages: ReglagesEnvoi = {}): {
  envoi: Envoi;
  retenus: EnvoiRetenu[];
} {
  const retenus: EnvoiRetenu[] = [];
  const redacteur = reglages.redacteur ?? REDACTEUR_PAR_DEFAUT;
  const segmentsMax = reglages.segmentsMax ?? SEGMENTS_MAX;

  const envoi: Envoi = {
    // Toutes les coordonnées présentes sont jugées joignables : le muet n'a pas
    // de passerelle, donc rien qui puisse refuser. C'est ce qui fait qu'un
    // passage à blanc montre TOUS les messages qui seraient partis.
    disponible: (canal, ou) => joignable(canal, ou),

    async envoyer(canal, ou, message) {
      const contenu: Courriel | Sms | Push =
        canal === "courriel"
          ? redacteur.courriel(message)
          : canal === "sms"
            ? redacteur.sms(message, segmentsMax)
            : redacteur.push(message);

      retenus.push({ canal, ou, contenu, message });
      return true;
    },
  };

  return { envoi, retenus };
}
