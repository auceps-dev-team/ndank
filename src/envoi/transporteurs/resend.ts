import { httpParDefaut, type Http } from "../../http";
import type { Remise, TransporteurCourriel } from "../port";
import { appelJson, chaine, objet } from "./appel";

/**
 * Resend — la passerelle de courriel la plus courte à câbler.
 *
 * Un `POST`, une clé en Bearer, et une réponse qui tient en un identifiant.
 * C'est tout, et c'est pour cela qu'elle est la première : un hôte doit pouvoir
 * envoyer sa première relance en cinq minutes.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * L'EXPÉDITEUR N'EST PAS UN RÉGLAGE, C'EST UN DOMAINE VÉRIFIÉ
 *
 * Une clé d'API valide ne suffit pas : tant que le domaine de `expediteur` n'a
 * pas été vérifié chez Resend, l'envoi est refusé. C'est la première erreur que
 * rencontre un hôte, et le message parle de domaine — donc il est clair, à
 * condition qu'il remonte. `ErreurPasserelle` le porte mot pour mot.
 */

const URL_ENVOI = "https://api.resend.com/emails";

export interface ConfigResend {
  /** Clé `re_...`. */
  cleApi: string;
  /**
   * Ce qui apparaîtra dans « De ».
   *
   * `Baobart <no-reply@baobart.ci>` ou `no-reply@baobart.ci`. Le domaine doit
   * être vérifié chez Resend.
   */
  expediteur: string;
  /** Où atterrissent les réponses, quand elle diffère de l'expéditeur. */
  repondreA?: string;
  http?: Http;
}

export const CHAMPS_RESEND = ["cleApi", "expediteur"] as const;

export function resend(config: ConfigResend): TransporteurCourriel {
  const http = config.http ?? httpParDefaut;

  return {
    nom: "resend",
    canal: "courriel",

    async envoyer(ou, contenu): Promise<Remise> {
      // `disponible` a déjà filtré, mais un hôte peut appeler le transporteur
      // directement. Rendre `false` vaut mieux que d'envoyer à `null`.
      if (ou.courriel === null) return { parti: false, reference: null };

      const reponse = objet(
        await appelJson("resend", http, {
          methode: "POST",
          url: URL_ENVOI,
          entetes: {
            Authorization: `Bearer ${config.cleApi}`,
            "Content-Type": "application/json",
          },
          corps: JSON.stringify({
            from: config.expediteur,
            to: [ou.courriel],
            subject: contenu.sujet,
            text: contenu.texte,
            html: contenu.html,
            ...(config.repondreA ? { reply_to: config.repondreA } : {}),
          }),
        }),
      );

      // Un 2xx sans identifiant n'est pas un succès qu'on sache attester : on le
      // dit plutôt que de compter une relance qui n'est peut-être pas partie.
      const reference = chaine(reponse["id"]);

      return { parti: reference !== null, reference };
    },
  };
}
