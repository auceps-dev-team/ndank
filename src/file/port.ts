/**
 * Ndank — la file d'attente des SMS, et pourquoi le sens de la connexion change tout.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE PROBLÈME QUE CECI RÉSOUT
 *
 * Une passerelle SMS locale — un téléphone Android, un modem USB — coûte une
 * fraction d'un envoi international et rend un vrai accusé de réception. Mais
 * elle vit derrière une box, sur une adresse privée, et le serveur du marchand
 * vit chez Vercel, Render ou dans un datacenter européen.
 *
 *     serveur → téléphone     bloqué par le NAT, partout, toujours
 *
 * On ne perce pas un NAT depuis l'extérieur sans VPN ni port ouvert, et
 * demander cela à un marchand revient à ne pas proposer la fonction.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ON INVERSE, ET LE PROBLÈME DISPARAÎT
 *
 *     téléphone → serveur     sortant, donc traversant partout
 *
 * Le passage quotidien n'appelle plus personne : il **dépose** ses messages
 * ici. L'appareil du marchand vient les chercher, les émet par sa SIM, et
 * rapporte ce qu'il en advient.
 *
 * Ce qu'on gagne, au-delà de la joignabilité :
 *
 *   — **aucun tiers.** Ni relais, ni service à opérer. Le message ne quitte
 *     l'infrastructure du marchand qu'au moment où la radio l'émet ;
 *   — **l'hébergement redevient libre.** Serverless, conteneur, VPS à
 *     Francfort : l'appareil appelle, donc peu importe où l'on appelle ;
 *   — **le réessai devient rapide.** Aujourd'hui, une passerelle injoignable à
 *     3 h du matin fait attendre la relance jusqu'au lendemain. Déposée dans
 *     une file, elle part dès que l'appareil revient — quelques minutes plus
 *     tard.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ET LA PROFONDEUR DE LA FILE DIT CE QU'AUCUN AUTRE SIGNAL NE DISAIT
 *
 * La panne du téléphone était jusqu'ici invisible jusqu'au passage suivant :
 * il fallait qu'un lot entier échoue pour que `bilan()` s'en aperçoive, soit
 * vingt-quatre heures plus tard.
 *
 * Une file qui grossit se voit **tout de suite**, et sans attendre le moindre
 * échec : personne ne vient chercher. Voir `Statistiques.enAttente`.
 */

/** Un SMS qui attend son tour. */
export interface MessageEnAttente {
  /** L'identifiant de la file. C'est lui que l'appareil renvoie à l'accusé. */
  id: string;

  /** Le destinataire, en E.164. */
  telephone: string;

  /** Le texte, déjà rédigé et déjà replié en GSM-7. */
  texte: string;

  /**
   * La clé de relance, quand le message en vient.
   *
   * Elle sert à retrouver ce qu'un message représentait, une fois qu'il est
   * parti. `null` pour ce qui ne vient pas de l'échelle — un code de connexion,
   * par exemple.
   */
  cle: string | null;

  /**
   * Au-delà de cette date, ne plus émettre.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * UN RAPPEL EN RETARD DIT LE CONTRAIRE DE CE QU'IL DEVAIT DIRE
   *
   * C'est la raison d'être de ce champ, et elle n'est pas cosmétique. Un
   * téléphone rallumé après trois jours viderait sa file d'un coup : l'abonné
   * recevrait « accès coupé dans 7 jours » le jour où son accès est déjà
   * coupé, et « dernier rappel » après avoir payé.
   *
   * Mieux vaut qu'un message meure que d'arriver faux.
   */
  expireLe: Date;

  /** Quand il a été déposé. Pour l'ordre, et pour mesurer l'attente. */
  deposeLe: Date;
}

/** Ce qu'un appareil rapporte d'un message qu'il a pris. */
export interface Accuse {
  id: string;
  /** L'appareil a-t-il réussi à l'émettre ? */
  parti: boolean;
  /** L'identifiant de l'opérateur, quand l'appareil en obtient un. */
  reference?: string | null;
  /** Pourquoi cela a échoué. Repris tel quel dans le journal. */
  cause?: string;
}

/** Ce que la file sait d'elle-même. Sert à la santé. */
export interface Statistiques {
  /** Combien attendent d'être pris. */
  enAttente: number;
  /** Combien sont pris mais pas encore acquittés. */
  enCours: number;
  /** L'âge du plus ancien message en attente, en secondes. `null` si vide. */
  attenteMax: number | null;
}

/**
 * Ce que l'hôte doit savoir faire pour que la file existe.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * `prendre` DOIT POSER UN BAIL, ET NON SUPPRIMER
 *
 * C'est la seule exigence subtile de ce port, et s'en écarter perd des
 * messages en silence.
 *
 * Un appareil qui prend dix messages puis meurt — batterie, réseau, processus
 * tué — ne les émettra jamais et n'acquittera rien. S'ils avaient été
 * supprimés à la prise, ils seraient perdus sans que personne ne le sache.
 *
 * `prendre` marque donc les messages **pris à telle heure**, et une
 * implémentation correcte les rend à nouveau disponibles au bout d'un délai
 * — quelques minutes suffisent. C'est ce qui rend la remise « au moins une
 * fois » plutôt que « au plus une fois », et pour une relance c'est le bon
 * sens : mieux vaut un rappel en double qu'un abonné jamais prévenu.
 *
 * `expireLe` borne l'autre bout : un message qui n'a pas trouvé preneur à
 * temps ne repart pas indéfiniment.
 */
export interface FileSms {
  /** Met un message en attente. */
  deposer(message: MessageEnAttente): Promise<void>;

  /**
   * Réserve jusqu'à `combien` messages non expirés, les plus anciens d'abord.
   *
   * Pose un bail : voir plus haut. Ne rend jamais un message déjà pris dont le
   * bail court encore, sinon deux appareils enverraient le même SMS.
   */
  prendre(combien: number, maintenant: Date): Promise<readonly MessageEnAttente[]>;

  /** Clôt un message pris. Un `parti: false` doit le rendre à la file. */
  acquitter(accuses: readonly Accuse[], maintenant: Date): Promise<void>;

  /** De quoi alimenter `bilan()`. Facultatif. */
  statistiques?(maintenant: Date): Promise<Statistiques>;
}
