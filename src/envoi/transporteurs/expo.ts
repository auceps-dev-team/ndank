import { httpParDefaut, type Http } from "../../http";
import type { Remise, TransporteurPush } from "../port";
import { appelJson, chaine, objet } from "./appel";

/**
 * Expo — la notification, sans compte Google ni signature de jeton.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI EXPO ET PAS FIREBASE
 *
 * Firebase Cloud Messaging est le service que tout le monde finit par utiliser,
 * y compris Expo qui s'appuie dessus. Mais son API v1 demande de signer un JWT
 * RS256 avec la clé privée d'un compte de service, de l'échanger contre un
 * jeton OAuth, et de renouveler le tout toutes les heures.
 *
 * Expo demande un `POST`. C'est la différence entre « le push marche ce soir »
 * et « le push marchera quand j'aurai compris les comptes de service », et pour
 * une bibliothèque qui promet dix minutes, elle est décisive.
 *
 * Firebase reste une fondation — voir `fondations.ts` — parce qu'un hôte qui a
 * déjà une application Android native n'utilise pas Expo.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UN ABONNÉ, PLUSIEURS APPAREILS, UN SEUL APPEL
 *
 * `Coordonnees.appareils` est une liste : quelqu'un installe l'application sur
 * son téléphone ET sur celui de son commerce. Expo accepte un tableau de
 * messages dans une seule requête, ce qui évite d'en faire trois.
 *
 * La relance est considérée comme partie dès qu'**un** appareil l'a reçue. Un
 * téléphone remplacé l'an dernier ne doit pas faire échouer une notification
 * qui est bien arrivée sur celui d'aujourd'hui.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LES REFUS ARRIVENT DANS UN 200
 *
 * C'est le piège de cette API, et il coûte cher. Expo répond `200` avec un
 * tableau où chaque entrée porte son propre `status`. Une application
 * désinstallée donne `"status": "error"` et `"details": { "error":
 * "DeviceNotRegistered" }` — dans une réponse que tout code naïf compte comme
 * un succès.
 *
 * Sans lecture de ce détail, la relance serait notée comme partie et l'abonné
 * ne serait jamais prévenu, jusqu'à la coupure. Les jetons morts remontent donc
 * dans `Remise.aRetirer`, et le journal les porte jusqu'à l'hôte.
 */

const URL_ENVOI = "https://exp.host/--/api/v2/push/send";

export interface ConfigExpo {
  /**
   * Le jeton d'accès Expo, quand le projet exige l'authentification des envois.
   *
   * Facultatif : sans lui, l'API accepte les envois de n'importe qui vers un
   * jeton d'appareil connu. C'est pratique pour démarrer et discutable en
   * production — Expo recommande de l'activer.
   */
  jetonAcces?: string;
  /**
   * La priorité de remise.
   *
   * `high` réveille l'appareil ; `normal` peut attendre. Une relance qui
   * annonce une coupure d'accès justifie `high`, et c'est le défaut.
   */
  priorite?: "default" | "normal" | "high";
  http?: Http;
}

export const CHAMPS_EXPO: readonly string[] = [];

export function expo(config: ConfigExpo = {}): TransporteurPush {
  const http = config.http ?? httpParDefaut;

  return {
    nom: "expo",
    canal: "push",

    async envoyer(ou, contenu): Promise<Remise> {
      if (ou.appareils.length === 0) return { parti: false, reference: null };

      const messages = ou.appareils.map((jeton) => ({
        to: jeton,
        title: contenu.titre,
        body: contenu.corps,
        priority: config.priorite ?? "high",
        // `data` traverse jusqu'à l'application : c'est par là qu'un clic mène
        // à la page de règlement plutôt qu'à l'écran d'accueil.
        data: { lien: contenu.lien, cle: contenu.identifiant },
        // Deux paliers ne se remplacent pas ; deux remises du même palier, si.
        collapseId: contenu.identifiant,
      }));

      const reponse = objet(
        await appelJson("expo", http, {
          methode: "POST",
          url: URL_ENVOI,
          entetes: {
            "Content-Type": "application/json",
            accept: "application/json",
            ...(config.jetonAcces
              ? { Authorization: `Bearer ${config.jetonAcces}` }
              : {}),
          },
          corps: JSON.stringify(messages),
        }),
      );

      const tickets = Array.isArray(reponse["data"]) ? reponse["data"] : [];

      let reference: string | null = null;
      const aRetirer: string[] = [];

      tickets.forEach((brut, i) => {
        const ticket = objet(brut);
        const jeton = ou.appareils[i];

        if (chaine(ticket["status"]) === "ok") {
          reference ??= chaine(ticket["id"]);
          return;
        }

        // Le seul refus dont on puisse conclure quelque chose : l'application
        // n'est plus là. Les autres — quota, panne — sont passagers, et retirer
        // le jeton reviendrait à perdre l'abonné pour de bon.
        const details = objet(ticket["details"]);
        if (chaine(details["error"]) === "DeviceNotRegistered" && jeton) {
          aRetirer.push(jeton);
        }
      });

      return {
        // Un seul appareil joint suffit : un téléphone remplacé l'an dernier ne
        // doit pas faire échouer la notification arrivée sur celui d'aujourd'hui.
        parti: reference !== null,
        reference,
        aRetirer,
      };
    },
  };
}
