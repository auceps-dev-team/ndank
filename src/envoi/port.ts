import type { Canal, Coordonnees } from "../ports";
import type { Courriel, Push, Sms } from "./redaction";

/**
 * Ndank — ce qu'est un transporteur, et ce qu'il n'a pas à savoir.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI UN PORT DE PLUS, ALORS QU'`Envoi` EXISTE DÉJÀ
 *
 * `Envoi` est le port du cœur : deux méthodes, trois canaux, et un `Message`
 * fait de faits bruts. Un hôte qui l'implémente doit donc, pour chaque canal,
 * choisir sa passerelle **et** rédiger le message — dont un SMS, dans une
 * contrainte de segments qu'il découvrira à la première facture.
 *
 * Un `Transporteur` ne fait que la première moitié : il reçoit un contenu déjà
 * rédigé et l'expédie. C'est la seule partie qui dépende vraiment du
 * fournisseur, et c'est la seule qu'on lui demande.
 *
 * `envoiCompose` recolle les deux — voir `compose.ts`.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UN TRANSPORTEUR NE DÉCIDE JAMAIS S'IL FAUT ENVOYER
 *
 * Il ne voit ni l'échéance, ni le palier, ni les relances déjà parties. Il
 * reçoit « ceci, à cette personne » et répond « parti » ou « pas parti ».
 *
 * C'est la même séparation que partout : la règle vit dans `etats.ts`, les
 * ports exécutent. Un transporteur qui se mettrait à filtrer déplacerait une
 * décision hors de l'endroit où elle est testée.
 */

/** Ce qu'un transporteur rend quand il a essayé. */
export interface Remise {
  /** Vrai si la passerelle a accepté le message. */
  parti: boolean;
  /**
   * L'identifiant chez la passerelle, quand elle en donne un.
   *
   * Il ne sert à rien tout de suite, et c'est voulu : c'est par lui qu'un
   * tableau de bord pourra un jour relier « la relance est partie » à « le
   * message a été remis ». L'ajouter après coup aurait changé la signature de
   * tous les transporteurs.
   */
  reference: string | null;

  /**
   * Les poignées d'appareil que la passerelle déclare mortes.
   *
   * ─────────────────────────────────────────────────────────────────────
   * SANS ELLES, UN ABONNÉ INJOIGNABLE PASSE POUR JOIGNABLE
   *
   * Une application désinstallée laisse son jeton dans la base. Le service de
   * push répond alors `DeviceNotRegistered` — un refus par appareil, dans une
   * réponse dont le statut HTTP reste 200.
   *
   * Deux conséquences, et la seconde est grave. On dépense un appel par
   * relance et pour toujours ; surtout, `joignable("push", …)` continue de
   * rendre `true` parce que la liste d'appareils n'est pas vide. Un abonné
   * dont le seul appareil est mort semble donc joignable, et le palier se
   * consomme sur un canal qui ne mène nulle part.
   *
   * Ndank ne touche pas à la base de l'hôte : il rapporte, et l'hôte retire.
   * Le journal porte l'information jusqu'à lui.
   */
  aRetirer?: readonly string[];
}

/**
 * Une passerelle, quel que soit le canal.
 *
 * Le paramètre `Contenu` est ce que la rédaction produit pour ce canal-là :
 * `Courriel`, `Sms` ou `Push`. Un transporteur SMS reçoit donc un texte déjà
 * replié en GSM-7 et son compte de segments — il n'a ni à replier, ni à
 * compter, ni à savoir que cela existe.
 */
export interface Transporteur<Contenu> {
  /** Le nom de la passerelle. Sert aux journaux et aux erreurs. */
  readonly nom: string;

  readonly canal: Canal;

  /**
   * Peut-il joindre quelqu'un avec ces coordonnées ?
   *
   * Facultatif : sans lui, `joignable` décide, et c'est presque toujours ce
   * qu'il faut. Un transporteur le fournit quand il a une exigence de plus —
   * Twilio, par exemple, refuse un numéro qui n'est pas au format
   * international, et mieux vaut le savoir avant de dépenser l'appel.
   */
  disponible?(ou: Coordonnees): boolean;

  /**
   * Expédie, et dit si c'est parti.
   *
   * ─────────────────────────────────────────────────────────────────────
   * IL PEUT LEVER, ET C'EST `envoiCompose` QUI RATTRAPE
   *
   * Un transporteur n'a pas à envelopper ses propres pannes : une passerelle
   * en délai d'attente est une exception, et l'écrire autrement obligerait
   * chaque adaptateur à répéter le même `try`.
   *
   * `envoiCompose` la rattrape, la journalise, et rend `false` — ce qui laisse
   * le moteur essayer le canal suivant du palier. Lever jusqu'au moteur ferait
   * de l'abonnement entier un incident, et le push ne partirait pas parce que
   * la passerelle SMS était lente.
   */
  envoyer(ou: Coordonnees, contenu: Contenu): Promise<Remise>;
}

export type TransporteurCourriel = Transporteur<Courriel>;
export type TransporteurSms = Transporteur<Sms>;
export type TransporteurPush = Transporteur<Push>;

/**
 * Le test de disponibilité par défaut : a-t-on de quoi joindre cette personne ?
 *
 * Le courriel exige une arobase, et pas seulement une chaîne non vide. Un champ
 * rempli avec « aucun » ou « - » — ce qui arrive dans toute base qui a vécu —
 * passerait sinon pour une adresse, la passerelle refuserait, et le moteur
 * compterait un échec au lieu de passer au canal suivant.
 */
export function joignable(canal: Canal, ou: Coordonnees): boolean {
  if (canal === "courriel") {
    return typeof ou.courriel === "string" && /.@./.test(ou.courriel);
  }

  if (canal === "sms") {
    return typeof ou.telephone === "string" && ou.telephone.trim() !== "";
  }

  return ou.appareils.length > 0;
}

/**
 * Un numéro ramené au format international, autant que faire se peut.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE ZÉRO DE TÊTE NE SE RETIRE PAS, ET C'EST LE POINT IMPORTANT
 *
 * La première version de cette fonction le retirait, par analogie avec la
 * France où le `0` de « 06 12 … » est un préfixe national qui ne se compose pas
 * depuis l'étranger. C'est faux dans la zone que Ndank sert, et le test l'a dit
 * tout de suite.
 *
 * La Côte d'Ivoire est passée à dix chiffres en 2021 : le `0` de
 * « 07 00 00 00 00 » fait **partie du numéro**. Le retirer donne
 * `+225700000000`, un numéro à douze chiffres qui n'existe pas — c'est-à-dire
 * un SMS refusé par la passerelle, sur le marché prioritaire, au dernier palier
 * de l'échelle. Le Bénin a fait le même changement en 2022.
 *
 * Ailleurs dans la zone, la question ne se pose pas : le Sénégal
 * (`+221 77 …`), le Mali, le Burkina, le Cameroun n'ont pas de préfixe national
 * du tout — on compose le numéro entier.
 *
 * Le défaut est donc de **tout garder**. `retirerZeroDeTete` existe pour l'hôte
 * dont le plan de numérotation en a un, et il doit le demander explicitement :
 * une supposition qui efface un chiffre est plus coûteuse qu'une option à
 * cocher.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QU'IL NE FAIT PAS
 *
 * Il ne valide rien : ni la longueur attendue par pays, ni les plages
 * attribuées aux opérateurs. Prétendre le contraire ferait rejeter des numéros
 * valides, ce qui est pire que d'en laisser passer un faux — la passerelle,
 * elle, sait vraiment.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI IL EXISTE QUAND MÊME
 *
 * Parce qu'une base d'abonnés de la zone franc contient « 07 00 00 00 00 » bien
 * plus souvent que « +2250700000000 » — c'est ce que les gens tapent. Twilio
 * refuse le premier avec une erreur qui parle de format, pas de pays, et l'hôte
 * découvre le problème sur la relance qui devait éviter une coupure.
 */
export function enE164(
  telephone: string,
  indicatifParDefaut?: string,
  options: { retirerZeroDeTete?: boolean } = {},
): string | null {
  const nu = telephone.replace(/[^\d+]/g, "");
  if (nu === "") return null;

  if (nu.startsWith("+")) return nu.length > 5 ? nu : null;
  if (nu.startsWith("00")) return `+${nu.slice(2)}`;

  if (indicatifParDefaut === undefined) return null;

  const indicatif = indicatifParDefaut.replace(/[^\d]/g, "");

  const local =
    options.retirerZeroDeTete === true && nu.startsWith("0") ? nu.slice(1) : nu;

  return local === "" ? null : `+${indicatif}${local}`;
}

// ────────────────────────────────────────────────────────────────── journal ──

/** Ce qui s'est passé sur une tentative d'envoi. */
export interface FaitEnvoi {
  canal: Canal;
  /** Le nom de la passerelle, ou `null` si aucune n'était branchée. */
  transporteur: string | null;
  /** La clé de relance, qui relie ce fait à un cycle et à un palier. */
  cle: string;
  parti: boolean;
  reference: string | null;
  /** Les poignées d'appareil à retirer de la base. Voir `Remise.aRetirer`. */
  aRetirer?: readonly string[];
  /** Ce qui a levé, quand quelque chose a levé. */
  cause?: unknown;
}

/**
 * Où raconter ce qui est parti, et ce qui ne l'est pas.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * SANS LUI, UN ÉCHEC D'ENVOI EST MUET
 *
 * Le port `Envoi` rend un booléen, et le moteur en tire un compteur
 * d'`injoignables`. C'est juste, mais cela ne dit pas *pourquoi* : une clé
 * d'API expirée et un abonné sans téléphone donnent le même chiffre, et le
 * premier se répare en une minute quand on le sait.
 *
 * Facultatif, et synchrone à dessein : il est appelé dans la boucle d'envoi du
 * passage quotidien, et une écriture lente y ralentirait tout le lot. Un hôte
 * qui veut persister ces faits met en file, il n'attend pas.
 */
export type JournalEnvoi = (fait: FaitEnvoi) => void;

/** Ce qu'une passerelle a refusé de faire. */
export class ErreurPasserelle extends Error {
  constructor(
    readonly passerelle: string,
    readonly statut: number,
    readonly reponse: string,
    message?: string,
  ) {
    super(
      message ?? `${passerelle} a répondu ${statut} : ${reponse.slice(0, 300)}`,
    );
    this.name = "ErreurPasserelle";
  }
}
