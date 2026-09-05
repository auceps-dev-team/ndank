import { randomUUID } from "node:crypto";

import { joignable, type Remise, type TransporteurSms } from "../envoi/port";
import type { Sms } from "../envoi/redaction";
import type { FileSms } from "./port";

/**
 * Ndank — le transporteur qui n'appelle personne.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL DÉPOSE, ET C'EST TOUT
 *
 * Les autres transporteurs joignent une passerelle et attendent sa réponse.
 * Celui-ci écrit dans une file et rend la main. C'est l'appareil du marchand
 * qui viendra chercher — voir `file/port.ts` pour pourquoi le sens compte.
 *
 * Conséquence heureuse : le passage quotidien ne dépend plus de la
 * disponibilité d'une passerelle. Il ne peut plus être ralenti par un
 * téléphone lent, ni interrompu par un réseau coupé.
 */

export interface ReglagesFile {
  file: FileSms;

  /**
   * Combien de temps un message garde son sens, en secondes.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * PLUS COURT QUE L'ÉCART ENTRE DEUX PALIERS
   *
   * Six heures par défaut. Ce n'est pas une durée technique, c'est une durée
   * éditoriale : au-delà, le message dit quelque chose de faux.
   *
   * Un rappel « accès coupé dans 7 jours » qui sort d'une file deux jours plus
   * tard annonce une échéance dépassée. Et si le palier suivant est déjà
   * parti, l'abonné reçoit les deux dans le désordre.
   *
   * Six heures laissent le temps à un téléphone rallumé le matin d'écouler la
   * nuit, et pas celui de mentir.
   */
  valableSecondes?: number;

  /** L'horloge. Injectable pour les tests. */
  maintenant?: () => Date;
  /** Comment fabriquer un identifiant. Injectable pour les tests. */
  identifiant?: () => string;
}

/**
 * Un transporteur SMS qui dépose dans une file.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * `parti: true` VEUT DIRE « DÉPOSÉ », ET IL FAUT LE SAVOIR
 *
 * C'est le même arbitrage que `Pending` chez la passerelle Android, et que
 * l'acceptation chez Resend : le port `Envoi` rend un booléen tout de suite, et
 * le moteur doit décider séance tenante s'il essaie le barreau suivant.
 *
 * Rendre `false` au dépôt serait pire : le moteur ne noterait pas la relance,
 * la redéposerait le lendemain, et l'abonné recevrait deux fois le même rappel
 * dès que l'appareil se rallume.
 *
 * Ce qui rattrape ici, et qui n'existait nulle part ailleurs : **la file se
 * mesure**. Un message qui n'est jamais pris se voit dans `enAttente`, tout de
 * suite, sans attendre le passage suivant.
 */
export function versLaFile(reglages: ReglagesFile): TransporteurSms {
  const horloge = reglages.maintenant ?? (() => new Date());
  const idDe = reglages.identifiant ?? randomUUID;
  const valable = (reglages.valableSecondes ?? 6 * 3600) * 1000;

  return {
    nom: "file",
    canal: "sms",

    disponible(ou) {
      return joignable("sms", ou);
    },

    async envoyer(ou, contenu: Sms): Promise<Remise> {
      if (ou.telephone === null) return { parti: false, reference: null };

      const maintenant = horloge();
      const id = idDe();

      await reglages.file.deposer({
        id,
        telephone: ou.telephone,
        texte: contenu.texte,
        // La clé de relance vit dans le message, pas dans le contenu rédigé.
        // L'hôte qui veut la retrouver la pose lui-même ; ici on ne l'invente
        // pas, parce qu'un identifiant faux vaut moins que pas d'identifiant.
        cle: null,
        expireLe: new Date(maintenant.getTime() + valable),
        deposeLe: maintenant,
      });

      return { parti: true, reference: id };
    },
  };
}
