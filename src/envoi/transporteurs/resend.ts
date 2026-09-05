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

      /**
       * Un 2xx sans identifiant n'est pas un succès qu'on sache attester : on
       * le dit plutôt que de compter une relance qui n'est peut-être pas partie.
       *
       * ═══════════════════════════════════════════════════════════════════
       * « PARTI » VEUT DIRE « ACCEPTÉ », PAS « REÇU »
       *
       * Éprouvé avec de vraies clés le 5 septembre 2026 :
       *
       *   — clé invalide          → 401, on lève ;
       *   — domaine non vérifié   → 403, on lève, et le message le nomme ;
       *   — adresse qui rebondit  → **202, identifiant rendu, `parti: true`**.
       *
       * Le troisième cas est le piège. Resend accepte le message, et le rebond
       * n'arrive que plus tard, par webhook. Un abonné dont l'adresse est morte
       * comptera donc comme joignable, et l'échelle de relance croira l'avoir
       * prévenu — alors qu'il ne saura rien de son échéance.
       *
       * Ndank ne le rattrape pas, et ne le peut pas : le port `Envoi` rend un
       * booléen au moment de l'envoi, pas un accusé de réception différé. Un
       * hôte qui veut la vérité doit brancher les webhooks de Resend et retirer
       * lui-même les adresses qui rebondissent.
       */
      const reference = chaine(reponse["id"]);

      return { parti: reference !== null, reference };
    },
  };
}
