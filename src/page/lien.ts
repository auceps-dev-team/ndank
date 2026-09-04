import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Ndank — le lien qu'on met dans une relance.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI IL NE PEUT PAS ÊTRE `/valider/ab-1`
 *
 * C'est ce que le README montrait, et il avait tort.
 *
 * Un lien qui contient l'identifiant de l'abonnement en clair est **énumérable**.
 * Quiconque en reçoit un — un abonné, quelqu'un à qui il l'a transféré, un
 * opérateur qui voit passer le SMS — peut changer un chiffre et lire la page
 * d'un autre : son offre, son montant, son retard de paiement, et bientôt son
 * nom. Il n'y a rien à deviner, il suffit de compter.
 *
 * Et l'inverse est vrai aussi : sans signature, on peut fabriquer un lien vers
 * n'importe quel abonnement, y compris un qui n'a rien demandé.
 *
 * Un jeton signé règle les deux : on ne peut ni le forger, ni en déduire le
 * suivant.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL EXPIRE, PARCE QU'IL SURVIT À SON MESSAGE
 *
 * Un lien de relance part par SMS et par courriel. Il est transféré, capturé en
 * image, sauvegardé dans un fil de discussion, indexé par une application de
 * messagerie. Il continue d'exister longtemps après le cycle qu'il concernait.
 *
 * L'expiration est donc dans le jeton et non dans une table : elle vaut même
 * pour un hôte qui n'a pas de table, et elle vaut même si l'abonnement a été
 * supprimé entre-temps.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * IL TIENT DANS UN SMS, ET C'EST UNE CONTRAINTE DE CONCEPTION
 *
 * L'alphabet retenu est celui de base64url — `A-Z a-z 0-9 - _`. Deux raisons,
 * et les deux comptent :
 *
 *   — **il passe en GSM-7 sans repli.** Les soixante-quatre caractères de
 *     base64url sont tous dans l'alphabet par défaut de la norme, donc le lien
 *     ne fait pas basculer le message en UCS-2. Le base64 ordinaire y passerait
 *     aussi, mais son `+` et son `/` devraient être encodés dans une URL, ce
 *     qui rallongerait le jeton d'un tiers ;
 *
 *   — **il ne se coupe pas.** `redigerSms` garantit déjà que le lien survit
 *     entier, mais il le fait en rognant le nom de l'offre. Chaque caractère
 *     économisé ici est un caractère d'offre rendu à l'abonné.
 *
 * D'où le sceau tronqué à douze octets — voir plus bas.
 */

/** Ce que le jeton transporte. */
export interface Contenu {
  /** L'abonnement concerné. */
  abonnementId: string;
  /**
   * Le dernier jour où le lien vaut, en jours depuis l'époque Unix.
   *
   * Un jour civil et non un horodatage : c'est l'unité de tout le reste du
   * module — `jour()`, `joursEntre()` — et cela économise cinq caractères
   * qu'aucun abonné ne verra jamais, mais que le SMS paie.
   */
  jourLimite: number;
}

/**
 * La taille du sceau, en octets.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * DOUZE, ET NON TRENTE-DEUX
 *
 * Un HMAC-SHA256 complet fait trente-deux octets, soit quarante-trois
 * caractères en base64url. Tronqué à douze, il en fait seize : vingt-sept
 * caractères de SMS rendus au nom de l'offre, sur chaque relance.
 *
 * Douze octets font quatre-vingt-seize bits. Forger un jeton demanderait de
 * trouver une collision sur ce sceau **sans connaître le secret**, c'est-à-dire
 * en moyenne deux puissance quatre-vingt-quinze essais — dont chacun est une
 * requête HTTP vers l'hôte. La troncature d'un HMAC est prévue par la norme
 * (RFC 2104, section 5) et pratiquée à quatre-vingt-seize bits par HOTP.
 *
 * Ce qu'on protège, par ailleurs, est une page qui affiche un montant dû et
 * ouvre un paiement au bénéfice du marchand. Ce n'est pas une session.
 */
const OCTETS_DE_SCEAU = 12;

/** Encode en base64url, sans remplissage. */
function b64url(donnees: Buffer): string {
  return donnees.toString("base64url");
}

/** Le sceau d'une charge utile. */
function sceller(secret: string, charge: string): string {
  const complet = createHmac("sha256", secret).update(charge, "utf8").digest();
  return b64url(complet.subarray(0, OCTETS_DE_SCEAU));
}

/** Comparaison à temps constant. Deux longueurs différentes valent faux. */
function memeSceau(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");

  // `timingSafeEqual` lève si les longueurs diffèrent. On répond avant, et rien
  // ne fuit : la longueur d'un sceau ne dépend pas du secret.
  if (x.length !== y.length) return false;

  return timingSafeEqual(x, y);
}

/** Le jour civil UTC d'une date, en jours depuis l'époque. */
export function jourDe(date: Date): number {
  return Math.floor(date.getTime() / 86_400_000);
}

/**
 * Combien de jours un lien de relance reste valable.
 *
 * Quinze : plus que la fenêtre complète de l'échelle des relances — sept jours
 * avant l'échéance, sept après, plus une marge — et moins qu'un cycle mensuel.
 *
 * Le rendre plus long ne servirait à rien : passé la reprise, le lien mènerait
 * à un abonnement clos, et la page le dirait. Le rendre plus court ferait
 * expirer le premier lien avant le dernier palier, et l'abonné qui remonte dans
 * ses SMS tomberait sur une page morte au moment où il se décide enfin.
 */
export const JOURS_DE_VALIDITE = 15;

/**
 * Fabrique le lien d'un abonnement.
 *
 * `base` est l'adresse publique de la page, sans barre oblique finale :
 * `https://p.baobart.ci/v`. Ndank ne la devine pas — il ne sait pas où l'hôte
 * l'a montée, ni derrière quel nom de domaine.
 */
export function lienDe(
  base: string,
  secret: string,
  abonnementId: string,
  maintenant: Date = new Date(),
  jours: number = JOURS_DE_VALIDITE,
): string {
  return `${base.replace(/\/+$/, "")}/${signerLien(secret, {
    abonnementId,
    jourLimite: jourDe(maintenant) + jours,
  })}`;
}

/**
 * Signe un contenu, et rend le jeton.
 *
 * La forme est `<charge>.<sceau>`, où la charge est
 * `base64url(abonnementId)` et `jourLimite` en base 36. Le point sépare : il
 * est dans l'alphabet GSM-7, il ne fait pas partie de base64url, et il n'a pas
 * besoin d'être encodé dans une URL.
 *
 * L'identifiant est encodé plutôt que transcrit tel quel parce que Ndank ne le
 * choisit pas : un hôte peut y mettre un UUID, un entier, ou une chaîne avec un
 * point dedans — qui casserait le découpage.
 */
export function signerLien(secret: string, contenu: Contenu): string {
  const charge = `${b64url(Buffer.from(contenu.abonnementId, "utf8"))}.${contenu.jourLimite.toString(36)}`;

  return `${charge}.${sceller(secret, charge)}`;
}

/** Pourquoi un jeton a été refusé. */
export type Refus = "FORME" | "SCEAU" | "EXPIRE";

export type LectureJeton =
  | { valide: true; contenu: Contenu }
  | { valide: false; refus: Refus };

/**
 * Relit un jeton, ou dit pourquoi il ne vaut rien.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * LE SCEAU EST VÉRIFIÉ AVANT L'EXPIRATION, ET L'ORDRE COMPTE
 *
 * Inverser reviendrait à répondre « expiré » à un jeton fabriqué de toutes
 * pièces, ce qui confirme à celui qui l'a fabriqué que sa forme est la bonne et
 * qu'il ne lui reste qu'à trouver le sceau.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * LE MOTIF EST RENDU, MAIS IL N'EST PAS DESTINÉ À L'ABONNÉ
 *
 * « Expiré » mérite une page qui propose un nouveau lien ; « sceau invalide »
 * mérite la même page qu'un jeton inexistant. Distinguer les deux dans le
 * journal aide à comprendre ; les distinguer à l'écran apprendrait à un
 * attaquant à quel moment il chauffe.
 */
export function lireLien(
  secret: string,
  jeton: string,
  maintenant: Date = new Date(),
): LectureJeton {
  const morceaux = jeton.split(".");
  if (morceaux.length !== 3) return { valide: false, refus: "FORME" };

  const [id36, limite36, sceau] = morceaux as [string, string, string];
  const charge = `${id36}.${limite36}`;

  if (!memeSceau(sceau, sceller(secret, charge))) {
    return { valide: false, refus: "SCEAU" };
  }

  const jourLimite = Number.parseInt(limite36, 36);
  if (!Number.isFinite(jourLimite)) return { valide: false, refus: "FORME" };

  const abonnementId = Buffer.from(id36, "base64url").toString("utf8");
  if (abonnementId === "") return { valide: false, refus: "FORME" };

  if (jourDe(maintenant) > jourLimite) {
    return { valide: false, refus: "EXPIRE" };
  }

  return { valide: true, contenu: { abonnementId, jourLimite } };
}
