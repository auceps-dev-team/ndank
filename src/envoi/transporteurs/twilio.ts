import { httpParDefaut, type Http } from "../../http";
import { enE164, type Remise, type TransporteurSms } from "../port";
import { appelJson, basique, chaine, objet } from "./appel";

/**
 * Twilio — le SMS, c'est-à-dire le seul canal du dernier palier.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QU'IL FAUT SAVOIR AVANT DE LE CHOISIR
 *
 * Twilio livre partout, sa documentation est la meilleure du marché, et son
 * API tient en une requête. C'est ce qui en fait le premier transporteur SMS
 * fourni.
 *
 * Ce n'est pas nécessairement le moins cher dans la zone franc : un agrégateur
 * local facture souvent l'unité moins que le tarif international, et négocie
 * un identifiant d'expéditeur alphanumérique auprès des opérateurs. Un hôte qui
 * envoie beaucoup a intérêt à comparer.
 *
 * Ndank ne l'enferme pas : `TransporteurSms` fait trois champs et une méthode.
 * Brancher un agrégateur local est un fichier d'une trentaine de lignes, et le
 * reste — les paliers, les clés de relance, le repli GSM-7, le budget de
 * segments — ne bouge pas.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE FORMULAIRE, ET NON DU JSON
 *
 * Twilio est l'une des dernières grandes API à attendre
 * `application/x-www-form-urlencoded`. Lui envoyer du JSON donne un 400 dont le
 * message parle d'un paramètre `To` manquant — alors qu'il est là, dans un corps
 * que la passerelle n'a pas lu.
 */

const BASE = "https://api.twilio.com/2010-04-01";

export interface ConfigTwilio {
  /** Identifiant de compte, `AC...`. */
  sid: string;
  /** Jeton d'authentification. */
  jeton: string;
  /**
   * Le numéro d'expédition, au format international.
   *
   * Alternative : `serviceMessagerie`, qui laisse Twilio choisir le numéro dans
   * un ensemble. L'un des deux est requis, et fournir les deux est une erreur
   * côté Twilio.
   */
  expediteur?: string;
  /** `MG...`, quand l'hôte passe par un Messaging Service. */
  serviceMessagerie?: string;
  /**
   * L'indicatif à préfixer aux numéros stockés en local.
   *
   * `"225"` pour la Côte d'Ivoire. Voir `enE164` : le zéro de tête n'est pas
   * retiré, parce qu'en Côte d'Ivoire il fait partie du numéro.
   */
  indicatifParDefaut?: string;
  /** Vrai pour les plans de numérotation où le zéro de tête est un préfixe. */
  retirerZeroDeTete?: boolean;
  http?: Http;
}

export const CHAMPS_TWILIO = ["sid", "jeton"] as const;

/** Les statuts que Twilio rend à la création, et qui ne sont pas des refus. */
const ACCEPTES = new Set(["queued", "accepted", "sending", "sent", "scheduled"]);

export function twilio(config: ConfigTwilio): TransporteurSms {
  const http = config.http ?? httpParDefaut;

  if (!config.expediteur && !config.serviceMessagerie) {
    // Refuser à la construction, et non au premier envoi. Le premier envoi est
    // une relance de dernier palier : la découvrir là, c'est la découvrir sur
    // un abonné qu'on allait couper.
    throw new Error(
      "twilio : il faut « expediteur » (un numéro) ou « serviceMessagerie » (MG...).",
    );
  }

  const numeroDe = (telephone: string): string | null =>
    enE164(telephone, config.indicatifParDefaut, {
      retirerZeroDeTete: config.retirerZeroDeTete === true,
    });

  return {
    nom: "twilio",
    canal: "sms",

    /**
     * Twilio refuse tout ce qui n'est pas au format international.
     *
     * On le vérifie ici plutôt que de dépenser l'appel : le refus reviendrait en
     * `ErreurPasserelle`, donc en `injoignable` dans le bilan, sans dire que le
     * problème est un format de numéro et non un abonné introuvable.
     */
    disponible(ou) {
      return ou.telephone !== null && numeroDe(ou.telephone) !== null;
    },

    async envoyer(ou, contenu): Promise<Remise> {
      if (ou.telephone === null) return { parti: false, reference: null };

      const destination = numeroDe(ou.telephone);
      if (destination === null) return { parti: false, reference: null };

      const champs = new URLSearchParams({
        To: destination,
        Body: contenu.texte,
        ...(config.serviceMessagerie
          ? { MessagingServiceSid: config.serviceMessagerie }
          : { From: config.expediteur! }),
      });

      const reponse = objet(
        await appelJson("twilio", http, {
          methode: "POST",
          url: `${BASE}/Accounts/${config.sid}/Messages.json`,
          entetes: {
            Authorization: basique(config.sid, config.jeton),
            "Content-Type": "application/x-www-form-urlencoded",
          },
          corps: champs.toString(),
        }),
      );

      const reference = chaine(reponse["sid"]);
      const statut = chaine(reponse["status"]) ?? "";

      // `failed` et `undelivered` peuvent revenir dès la création. Les compter
      // comme partis noterait la relance, et le moteur ne réessaierait jamais.
      return {
        parti: reference !== null && ACCEPTES.has(statut),
        reference,
      };
    },
  };
}
