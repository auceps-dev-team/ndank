import { httpParDefaut, type Http } from "../../http";
import type { Remise, TransporteurCourriel } from "../port";
import { appelJson, chaine, objet } from "./appel";

/**
 * Brevo — l'autre passerelle de courriel, et la plus répandue en francophonie.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI DEUX, ALORS QU'UNE SUFFIT TECHNIQUEMENT
 *
 * Pas pour remplir un tableau. Parce que le choix d'une passerelle de courriel
 * se fait rarement sur ses qualités techniques : il se fait sur le compte qu'on
 * a déjà, la facturation qu'on comprend, et la langue du support.
 *
 * Brevo — l'ancien Sendinblue — est facturé en euros, documenté en français, et
 * beaucoup d'entreprises de la zone y ont déjà un compte pour leurs
 * infolettres. Leur demander d'en ouvrir un second pour brancher Ndank serait
 * une friction gratuite, à l'endroit exact où l'on promet dix minutes.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * L'AUTHENTIFICATION N'EST PAS UN BEARER
 *
 * Brevo attend la clé dans un en-tête `api-key`, en clair. Écrire
 * `Authorization: Bearer` — le réflexe après Resend — donne un 401 dont le
 * message ne dit pas que l'en-tête est le mauvais.
 */

const URL_ENVOI = "https://api.brevo.com/v3/smtp/email";

export interface ConfigBrevo {
  /** Clé `xkeysib-...`. */
  cleApi: string;
  /** L'adresse d'expédition. Son domaine doit être authentifié chez Brevo. */
  expediteur: string;
  /** Le nom affiché à côté de l'adresse. */
  nomExpediteur?: string;
  http?: Http;
}

export const CHAMPS_BREVO = ["cleApi", "expediteur"] as const;

export function brevo(config: ConfigBrevo): TransporteurCourriel {
  const http = config.http ?? httpParDefaut;

  return {
    nom: "brevo",
    canal: "courriel",

    async envoyer(ou, contenu): Promise<Remise> {
      if (ou.courriel === null) return { parti: false, reference: null };

      const reponse = objet(
        await appelJson("brevo", http, {
          methode: "POST",
          url: URL_ENVOI,
          entetes: {
            "api-key": config.cleApi,
            "Content-Type": "application/json",
            accept: "application/json",
          },
          corps: JSON.stringify({
            sender: {
              email: config.expediteur,
              ...(config.nomExpediteur ? { name: config.nomExpediteur } : {}),
            },
            // Le nom du destinataire est transmis quand on l'a : il améliore la
            // délivrabilité, et c'est la même information que la salutation.
            to: [{ email: ou.courriel, ...(ou.nom ? { name: ou.nom } : {}) }],
            subject: contenu.sujet,
            textContent: contenu.texte,
            htmlContent: contenu.html,
          }),
        }),
      );

      const reference = chaine(reponse["messageId"]);

      return { parti: reference !== null, reference };
    },
  };
}
