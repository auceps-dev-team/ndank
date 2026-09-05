import type { Http } from "../http";
import type { Canal } from "../ports";
import type {
  Transporteur,
  TransporteurCourriel,
  TransporteurPush,
  TransporteurSms,
} from "./port";
import { CHAMPS_BREVO, brevo } from "./transporteurs/brevo";
import { CHAMPS_EXPO, expo } from "./transporteurs/expo";
import {
  PAR_NOM_ENVOI,
  fondationEnvoi,
  type FondationEnvoi,
} from "./transporteurs/fondations";
import { CHAMPS_RESEND, resend } from "./transporteurs/resend";
import { CHAMPS_TWILIO, twilio } from "./transporteurs/twilio";
import {
  CHAMPS_PASSERELLE_ANDROID,
  passerelleAndroid,
} from "./transporteurs/passerelle-android";

/**
 * Le registre des passerelles.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * REMPLIR DES CHAMPS, ET RIEN D'AUTRE
 *
 * C'est la promesse de la couche, et c'est la même que pour l'encaissement :
 * l'hôte pose ses clés dans sa configuration, nomme une passerelle, et obtient
 * un transporteur. Il n'écrit ni requête, ni en-tête d'authentification, ni
 * traduction de statut.
 *
 *     const envoi = envoiCompose({
 *       courriel: transporteurCourriel("resend", process.env),
 *       sms: transporteurSms("twilio", process.env),
 *     });
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UNE CONFIGURATION INCOMPLÈTE ÉCHOUE ICI, PAS À TROIS HEURES DU MATIN
 *
 * C'est le vrai travail de ce fichier, et il vaut plus ici que pour les
 * paiements. Une clé de paiement absente se découvre au premier abonné qui
 * clique — il réessaie, il écrit au support, on répare.
 *
 * Une clé d'envoi absente ne se découvre pas du tout. Le passage quotidien
 * tourne, `envoiCompose` rattrape l'erreur de la passerelle, le bilan compte un
 * `injoignable` de plus, et personne ne regarde ce chiffre. Trois jours plus
 * tard, l'accès est coupé pour quelqu'un qu'on n'a jamais prévenu.
 *
 * D'où `verifierEnvoi()`, à appeler au démarrage : elle refuse de laisser
 * partir une application dont les passerelles ne sont pas configurées.
 */

export type NomCourriel = "resend" | "brevo";
export type NomSms =
  | "twilio"
  /** Un téléphone Android, via android-sms-gateway. Voir l'adaptateur. */
  | "passerelle-android"
  | "orange-sms"
  | "africastalking";
export type NomPush = "expo" | "fcm" | "webpush";
export type NomPasserelle = NomCourriel | NomSms | NomPush;

/** Ce qu'un hôte pose dans sa configuration, tel quel. */
export type Identifiants = Readonly<
  Record<string, string | boolean | undefined>
>;

/** Les champs requis par passerelle, pour la validation et pour l'affichage. */
export const CHAMPS_PASSERELLE: Readonly<
  Record<NomPasserelle, readonly string[]>
> = {
  resend: CHAMPS_RESEND,
  brevo: CHAMPS_BREVO,
  twilio: CHAMPS_TWILIO,
  "passerelle-android": CHAMPS_PASSERELLE_ANDROID,
  expo: CHAMPS_EXPO,
  "orange-sms": PAR_NOM_ENVOI["orange-sms"]!.champs,
  africastalking: PAR_NOM_ENVOI["africastalking"]!.champs,
  fcm: PAR_NOM_ENVOI["fcm"]!.champs,
  webpush: PAR_NOM_ENVOI["webpush"]!.champs,
};

/** Le canal de chaque passerelle. Sert au registre et au tableau de bord. */
export const CANAL_PASSERELLE: Readonly<Record<NomPasserelle, Canal>> = {
  resend: "courriel",
  brevo: "courriel",
  twilio: "sms",
  "passerelle-android": "sms",
  "orange-sms": "sms",
  africastalking: "sms",
  expo: "push",
  fcm: "push",
  webpush: "push",
};

/** Celles qui sont réellement branchées. Les autres sont des fondations. */
const BRANCHEES = new Set<NomPasserelle>([
  "resend",
  "brevo",
  "twilio",
  "passerelle-android",
  "expo",
]);

export class ConfigurationEnvoiIncomplete extends Error {
  constructor(
    readonly passerelle: string,
    readonly manquants: readonly string[],
  ) {
    super(
      `Configuration incomplète pour « ${passerelle} » : ` +
        `${manquants.join(", ")} ${manquants.length > 1 ? "manquent" : "manque"}.\n` +
        `Champs attendus : ` +
        `${(CHAMPS_PASSERELLE[passerelle as NomPasserelle] ?? []).join(", ")}.`,
    );
    this.name = "ConfigurationEnvoiIncomplete";
  }
}

export class PasserelleInconnue extends Error {
  constructor(nom: string) {
    super(
      `Passerelle inconnue : « ${nom} ». ` +
        `Connues : ${Object.keys(CHAMPS_PASSERELLE).join(", ")}.`,
    );
    this.name = "PasserelleInconnue";
  }
}

/**
 * Dit ce qui manque, sans rien construire.
 *
 * Séparé de la construction pour qu'un hôte puisse vérifier toute sa
 * configuration au démarrage — voir `verifierEnvoi`.
 */
export function champsManquants(
  nom: NomPasserelle,
  identifiants: Identifiants,
): readonly string[] {
  const requis = CHAMPS_PASSERELLE[nom];
  if (!requis) throw new PasserelleInconnue(nom);

  return requis.filter((champ) => {
    const valeur = identifiants[champ];
    return typeof valeur !== "string" || valeur.trim() === "";
  });
}

function verifier(nom: NomPasserelle, identifiants: Identifiants): void {
  if (!(nom in CHAMPS_PASSERELLE)) throw new PasserelleInconnue(nom);

  const manquants = champsManquants(nom, identifiants);
  if (manquants.length > 0) {
    throw new ConfigurationEnvoiIncomplete(nom, manquants);
  }
}

const texte = (identifiants: Identifiants, champ: string): string =>
  identifiants[champ] as string;

const optionnel = (
  identifiants: Identifiants,
  champ: string,
): string | undefined =>
  typeof identifiants[champ] === "string" && identifiants[champ] !== ""
    ? (identifiants[champ] as string)
    : undefined;

/** Construit une passerelle de courriel, ou refuse en disant pourquoi. */
export function transporteurCourriel(
  nom: NomCourriel,
  identifiants: Identifiants,
  http?: Http,
): TransporteurCourriel {
  verifier(nom, identifiants);

  switch (nom) {
    case "resend":
      return resend({
        cleApi: texte(identifiants, "cleApi"),
        expediteur: texte(identifiants, "expediteur"),
        repondreA: optionnel(identifiants, "repondreA"),
        http,
      });

    case "brevo":
      return brevo({
        cleApi: texte(identifiants, "cleApi"),
        expediteur: texte(identifiants, "expediteur"),
        nomExpediteur: optionnel(identifiants, "nomExpediteur"),
        http,
      });

    default:
      throw new PasserelleInconnue(nom);
  }
}

/** Construit une passerelle SMS, ou refuse en disant pourquoi. */
export function transporteurSms(
  nom: NomSms,
  identifiants: Identifiants,
  http?: Http,
): TransporteurSms {
  verifier(nom, identifiants);

  if (nom === "twilio") {
    return twilio({
      sid: texte(identifiants, "sid"),
      jeton: texte(identifiants, "jeton"),
      expediteur: optionnel(identifiants, "expediteur"),
      serviceMessagerie: optionnel(identifiants, "serviceMessagerie"),
      indicatifParDefaut: optionnel(identifiants, "indicatifParDefaut"),
      retirerZeroDeTete: identifiants["retirerZeroDeTete"] === true,
      http,
    });
  }

  if (nom === "passerelle-android") {
    return passerelleAndroid({
      base: texte(identifiants, "base"),
      utilisateur: texte(identifiants, "utilisateur"),
      motDePasse: texte(identifiants, "motDePasse"),
      appareil: optionnel(identifiants, "appareil"),
      sim: identifiants["sim"] as 1 | 2 | 3 | undefined,
      expireApres: identifiants["expireApres"] as number | undefined,
      http,
    });
  }

  return fondationEnvoi<never>(PAR_NOM_ENVOI[nom] as FondationEnvoi);
}

/** Construit une passerelle de notification, ou refuse en disant pourquoi. */
export function transporteurPush(
  nom: NomPush,
  identifiants: Identifiants = {},
  http?: Http,
): TransporteurPush {
  verifier(nom, identifiants);

  if (nom === "expo") {
    return expo({
      jetonAcces: optionnel(identifiants, "jetonAcces"),
      http,
    });
  }

  return fondationEnvoi<never>(PAR_NOM_ENVOI[nom] as FondationEnvoi);
}

/**
 * Refuse de laisser démarrer une application dont l'envoi n'est pas configuré.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI CELLE-CI EXISTE, ALORS QUE L'ENCAISSEMENT N'EN A PAS
 *
 * Parce que les deux pannes ne se voient pas de la même façon.
 *
 * Une clé de paiement absente se découvre au premier abonné qui clique. Il
 * réessaie, il écrit au support, on répare dans l'heure.
 *
 * Une clé d'envoi absente ne se découvre pas. Le passage tourne, l'erreur est
 * rattrapée, le bilan compte un `injoignable` de plus — et ce chiffre n'a
 * aucune raison d'alerter quelqu'un un mardi matin. La panne se manifeste
 * seulement au troisième jour, quand l'accès tombe pour un abonné qui n'a rien
 * reçu, et qui, lui, n'a aucun moyen de savoir ce qui s'est passé.
 *
 * Rend la liste des problèmes, vide si tout va bien.
 */
export function verifierEnvoi(
  demande: Partial<Record<Canal, { passerelle: string; identifiants: Identifiants }>>,
): string[] {
  const problemes: string[] = [];

  for (const [canal, choix] of Object.entries(demande)) {
    if (!choix) continue;

    const nom = choix.passerelle as NomPasserelle;

    if (!(nom in CHAMPS_PASSERELLE)) {
      problemes.push(`${canal} : passerelle inconnue « ${nom} ».`);
      continue;
    }

    if (CANAL_PASSERELLE[nom] !== canal) {
      // Le cas est banal et coûteux : une ligne de configuration recopiée d'un
      // canal à l'autre. La passerelle existe, ses champs sont remplis, et elle
      // ne sait pas envoyer ce qu'on lui donnera.
      problemes.push(
        `${canal} : « ${nom} » est une passerelle ${CANAL_PASSERELLE[nom]}.`,
      );
      continue;
    }

    if (!BRANCHEES.has(nom)) {
      problemes.push(
        `${canal} : « ${nom} » n'est pas branchée — c'est une fondation.`,
      );
      continue;
    }

    const manquants = champsManquants(nom, choix.identifiants);
    if (manquants.length > 0) {
      problemes.push(`${canal} : ${nom} — ${manquants.join(", ")} manque(nt).`);
    }
  }

  return problemes;
}

/**
 * Ce qu'un tableau de bord peut afficher pour aider à la configuration.
 *
 * Dérivé du registre plutôt que recopié : ajouter une passerelle ajoute sa
 * ligne à l'écran. Même règle que `catalogue()` du côté des paiements, et que
 * `relancesAnnoncees` dans le cœur — un écran qui décrit le code doit être
 * fabriqué à partir du code.
 */
export function cataloguePasserelles(): {
  nom: NomPasserelle;
  canal: Canal;
  branche: boolean;
  champs: readonly string[];
  aObtenir: string | null;
}[] {
  return (Object.keys(CHAMPS_PASSERELLE) as NomPasserelle[]).map((nom) => ({
    nom,
    canal: CANAL_PASSERELLE[nom],
    branche: BRANCHEES.has(nom),
    champs: CHAMPS_PASSERELLE[nom],
    aObtenir: PAR_NOM_ENVOI[nom]?.aObtenir ?? null,
  }));
}

/** Le type d'un transporteur, quel que soit son canal. Sert au typage d'hôte. */
export type TransporteurQuelconque = Transporteur<unknown>;
