import { appelJson, basique, chaine, objet } from "./appel";
import { httpParDefaut, type Http } from "../../http";
import { joignable, type Remise, type TransporteurSms } from "../port";
import type { Sms } from "../redaction";

/**
 * Ndank — un téléphone Android comme passerelle SMS.
 *
 * Pour [android-sms-gateway](https://github.com/capcom6/android-sms-gateway),
 * sous licence Apache 2.0.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI CE TRANSPORTEUR EXISTE : LE SMS EST LE SEUL CANAL QUI COÛTE
 *
 * L'échelle de relance a trois barreaux, et deux sont gratuits. Le courriel ne
 * coûte rien, le push non plus. Le SMS, lui, se paie à l'unité — et c'est
 * précisément celui qui arrive, chez des abonnés qui ne lisent pas leurs
 * courriels et n'ont pas installé d'application.
 *
 * Chez une passerelle internationale, un SMS vers la Côte d'Ivoire se paie
 * autour de cinq centimes d'euro. Depuis une carte SIM locale avec un forfait,
 * le même message coûte une fraction de cela. Sur cinq cents abonnés relancés
 * trois fois par mois, l'écart n'est pas un détail de facture : c'est la
 * différence entre une échelle qu'on déroule et une échelle qu'on rogne.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL DONNE CE QU'AUCUNE PASSERELLE PAYANTE NE DONNE : `Delivered`
 *
 * C'est l'argument technique, et il pèse plus que le prix.
 *
 * Resend accepte un courriel et le rebond arrive plus tard : « parti » y veut
 * dire « accepté », jamais « reçu ». Twilio a la même limite au moment de
 * l'appel. Ndank ne peut donc pas savoir si un abonné a été prévenu — il sait
 * seulement qu'on a essayé.
 *
 * Cette passerelle-ci porte cinq états, dont `Delivered` : **l'appareil du
 * destinataire a confirmé la réception**. C'est un accusé réel, pas une
 * promesse d'acheminement. Voir `etatDuMessage`, qui permet de le relire.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * DEUX MODES, ET LE LOCAL N'EST PAS QU'UNE ÉCONOMIE
 *
 * En mode local, l'hôte parle au téléphone sur son propre réseau :
 * `http://192.168.1.42:8080`. Aucun tiers ne voit passer les messages — or un
 * SMS de relance porte un nom, un montant et un lien signé.
 *
 * En mode nuage (`https://api.sms-gate.app`), le même contenu transite par un
 * serveur qu'on ne tient pas. C'est plus commode et ce n'est pas neutre.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QU'IL FAUT SAVOIR AVANT DE S'EN SERVIR
 *
 * Trois choses qu'aucun code ne rattrapera, et qu'il vaut mieux lire ici que
 * découvrir un mardi matin.
 *
 * **L'opérateur peut suspendre la SIM.** Une carte grand public qui émet des
 * centaines de messages identiques ressemble, vue du réseau, à ce que les
 * opérateurs combattent activement dans la zone. Le risque croît avec le
 * volume : quelques dizaines de rappels par mois vers ses propres clients ne
 * ressemble pas à la même chose que dix mille. C'est une décision de l'hôte,
 * pas une que Ndank puisse prendre pour lui.
 *
 * **Le téléphone est un point de panne unique.** Batterie vide, réseau perdu,
 * redémarrage après mise à jour : l'échelle s'arrête sans bruit. `bilan()` le
 * verra — un canal dont tous les envois échouent donne une `ALERTE` — mais
 * seulement au passage suivant.
 *
 * **Le débit est celui d'un téléphone.** Android limite l'émission, et
 * l'opérateur aussi. Cinq cents abonnés passent ; cinquante mille non.
 */

/** Le chemin de l'API tierce, commun au mode local et au mode nuage. */
const CHEMIN = "/3rdparty/v1/messages";

export interface ConfigPasserelleAndroid {
  /**
   * L'adresse de la passerelle, sans barre finale.
   *
   * `http://192.168.1.42:8080` pour le téléphone sur le réseau local,
   * `https://api.sms-gate.app` pour le mode nuage.
   */
  base: string;
  /** L'identifiant affiché par l'application, dans ses réglages. */
  utilisateur: string;
  motDePasse: string;
  /** Quel appareil, quand plusieurs téléphones sont enrôlés. */
  appareil?: string;
  /** Quelle SIM, sur un téléphone qui en porte plusieurs. De 1 à 3. */
  sim?: 1 | 2 | 3;
  /**
   * Au bout de combien de secondes abandonner un message non remis.
   *
   * Une relance a une date d'échéance : un rappel qui part trois jours en
   * retard, parce que le téléphone était éteint, arrive après le message
   * suivant et dit le contraire. Vingt-quatre heures par défaut.
   */
  expireApres?: number;
  http?: Http;
}

/** Les champs que l'hôte doit remplir. Sert à la validation du registre. */
export const CHAMPS_PASSERELLE_ANDROID = [
  "base",
  "utilisateur",
  "motDePasse",
] as const;

/**
 * Les états rendus par la passerelle, et ce qu'on en conclut.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * `Pending` COMPTE COMME PARTI, ET C'EST DISCUTABLE
 *
 * `Pending` veut dire « accepté par la passerelle, pas encore remis à
 * l'appareil ». Si le téléphone est éteint, le message y reste.
 *
 * On le compte quand même comme parti, pour la même raison qui vaut chez
 * Resend : le port `Envoi` rend un booléen au moment de l'envoi, et rendre
 * `false` ferait réessayer le canal suivant — donc envoyer deux fois quand le
 * téléphone se rallume une minute plus tard.
 *
 * La différence avec Resend, c'est qu'ici on peut aller voir. `etatDuMessage`
 * relit l'état plus tard, et `Delivered` est une vraie confirmation.
 */
const ECHOUES = new Set(["Failed", "Cancelled"]);

export function passerelleAndroid(
  config: ConfigPasserelleAndroid,
): TransporteurSms {
  const http = config.http ?? httpParDefaut;
  const base = config.base.replace(/\/+$/, "");

  return {
    nom: "passerelle-android",
    canal: "sms",

    disponible(ou) {
      return joignable("sms", ou);
    },

    async envoyer(ou, contenu: Sms): Promise<Remise> {
      if (ou.telephone === null) return { parti: false, reference: null };

      const reponse = objet(
        await appelJson("passerelle-android", http, {
          methode: "POST",
          url: `${base}${CHEMIN}`,
          entetes: {
            Authorization: basique(config.utilisateur, config.motDePasse),
            "Content-Type": "application/json",
          },
          corps: JSON.stringify({
            textMessage: { text: contenu.texte },
            // Le numéro part tel qu'on le tient, en E.164 : la passerelle
            // compose depuis une SIM locale, mais un abonné peut être ailleurs.
            phoneNumbers: [ou.telephone],
            ...(config.appareil ? { deviceId: config.appareil } : {}),
            ...(config.sim ? { simNumber: config.sim } : {}),
            ttl: config.expireApres ?? 86_400,
          }),
        }),
      );

      const reference = chaine(reponse["id"]);
      const etat = chaine(reponse["state"]) ?? "";

      // Un identifiant sans état est un succès qu'on ne sait pas attester ; un
      // état d'échec rendu dès l'envoi ne doit pas noter la relance, sans quoi
      // le moteur ne réessaierait jamais.
      return {
        parti: reference !== null && !ECHOUES.has(etat),
        reference,
      };
    },
  };
}

/** Ce que la passerelle sait d'un message, après coup. */
export interface EtatMessage {
  id: string;
  /** `Pending`, `Processed`, `Sent`, `Delivered`, `Failed`, `Cancelled`. */
  etat: string;
  /** Pourquoi il a échoué, quand la passerelle le dit. */
  raison: string | null;
  /** Vrai seulement sur `Delivered` : l'appareil du destinataire a confirmé. */
  remis: boolean;
}

/**
 * Relit l'état d'un message déjà envoyé.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE N'EST PAS DANS LE PORT `Envoi`, ET C'EST VOULU
 *
 * `Envoi.envoyer` rend un booléen tout de suite : le moteur doit décider
 * séance tenante s'il essaie le barreau suivant, et il ne peut pas attendre un
 * accusé qui met des minutes à venir.
 *
 * Cette fonction vit donc à côté. Un hôte qui veut savoir ce que ses relances
 * sont devenues garde la référence rendue par `Remise`, et la relit plus tard
 * — au passage suivant, ou depuis son tableau de bord.
 *
 * C'est le seul canal de Ndank où cette question a une réponse.
 */
export async function etatDuMessage(
  config: ConfigPasserelleAndroid,
  id: string,
): Promise<EtatMessage> {
  const http = config.http ?? httpParDefaut;
  const base = config.base.replace(/\/+$/, "");

  const reponse = objet(
    await appelJson("passerelle-android", http, {
      methode: "GET",
      url: `${base}${CHEMIN}/${encodeURIComponent(id)}`,
      entetes: {
        Authorization: basique(config.utilisateur, config.motDePasse),
      },
    }),
  );

  const etat = chaine(reponse["state"]) ?? "";

  return {
    id: chaine(reponse["id"]) ?? id,
    etat,
    raison: chaine(reponse["reason"]),
    remis: etat === "Delivered",
  };
}
