import { createHmac, timingSafeEqual } from "node:crypto";

import { normaliserIdentifiant } from "./identite";

/**
 * Ndank — le code à six chiffres qu'on envoie par SMS.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QUE CE FICHIER FAIT, ET CE QU'IL NE FAIT PAS
 *
 * Il ne fait pas d'authentification. Il n'y a ici ni session, ni cookie, ni
 * compte, ni écran de connexion — tout cela appartient à Ndank App, qui a une
 * base et des utilisateurs, alors que Ndank est une bibliothèque qu'on installe
 * chez un marchand.
 *
 * Ce qu'il fait, c'est la seule partie qu'on ne peut pas se permettre de
 * réécrire de travers : engendrer un code, le vérifier, et **refuser de le
 * faire sans compteur de tentatives**.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * SANS STOCKAGE, PARCE QUE LE STOCKER NE SERT À RIEN
 *
 * On dérive le code de `HMAC(secret, identifiant + fenêtre)` plutôt que de le
 * tirer au sort et de le ranger quelque part. Le même calcul, refait à la
 * vérification, redonne le même code — il n'y a donc pas de table à écrire, pas
 * de purge à programmer, et pas de code oublié en base six mois plus tard.
 *
 * C'est la construction de RFC 4226, avec une fenêtre de temps à la place du
 * compteur.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * SIX CHIFFRES, DONC UN MILLION — CE QUI N'EST RIEN
 *
 * Il faut le dire nettement, parce que c'est ce qui détermine tout le reste :
 * un million de codes se parcourent en quelques secondes. **Le code ne protège
 * rien par lui-même.** Ce qui protège, c'est le nombre d'essais.
 *
 * D'où `Tentatives`, qui n'est pas optionnel : `verificateur()` refuse de se
 * construire sans lui. Un port qu'on peut omettre finit par être omis, et l'on
 * découvre le jour de l'incident que la fonction qu'on croyait sûre ne l'était
 * que dans les exemples.
 */

/** Cinq minutes. */
const FENETRE = 300;

/**
 * Combien d'essais avant de fermer la porte.
 *
 * Cinq : assez pour qui se trompe en recopiant depuis ses messages, assez peu
 * pour qu'un million de codes reste hors d'atteinte.
 */
export const ESSAIS_MAX = 5;

/**
 * Le compteur d'essais. **Obligatoire.**
 *
 * L'hôte le branche sur ce qu'il a — Redis, une table, la mémoire d'un
 * processus unique. Ndank ne le fournit pas : un compteur en mémoire dans une
 * bibliothèque marcherait en développement et se remettrait à zéro à chaque
 * requête derrière un répartiteur de charge, ce qui est précisément la panne
 * qu'on ne voit pas venir.
 */
export interface Tentatives {
  /** Combien d'essais ratés pour cette clé, dans la fenêtre courante. */
  compter(cle: string): Promise<number>;
  /** Un essai raté de plus. Doit expirer tout seul, au bout d'une heure. */
  echec(cle: string): Promise<void>;
  /** Remet à zéro : le code était bon. */
  reussite(cle: string): Promise<void>;
}

/** La fenêtre de temps où l'on se trouve. */
function fenetreDe(maintenant: Date): number {
  return Math.floor(maintenant.getTime() / 1000 / FENETRE);
}

function calculer(secret: string, identifiant: string, fenetre: number): string {
  const somme = createHmac("sha256", secret)
    .update(`${normaliserIdentifiant(identifiant)}:${fenetre}`, "utf8")
    .digest();

  // Troncature dynamique de la RFC 4226 : prendre les quatre premiers octets
  // biaiserait le résultat vers les valeurs basses, parce que le modulo d'un
  // entier de 32 bits par un million n'est pas uniforme sur toute la plage.
  const decalage = somme[somme.length - 1]! & 0x0f;
  const binaire =
    ((somme[decalage]! & 0x7f) << 24) |
    ((somme[decalage + 1]! & 0xff) << 16) |
    ((somme[decalage + 2]! & 0xff) << 8) |
    (somme[decalage + 3]! & 0xff);

  return (binaire % 1_000_000).toString().padStart(6, "0");
}

/**
 * Le code à envoyer.
 *
 * Il vaut jusqu'à la fin de la fenêtre courante, et la vérification accepte
 * aussi la précédente — donc entre cinq et dix minutes selon le moment où il
 * part. C'est délibéré : un code émis à la seconde 299 d'une fenêtre serait
 * mort avant que le SMS n'arrive.
 */
export function engendrer(
  secret: string,
  identifiant: string,
  maintenant: Date = new Date(),
): string {
  return calculer(secret, identifiant, fenetreDe(maintenant));
}

/** Ce qu'une vérification peut répondre. */
export type Verdict =
  /** Le code est bon. */
  | { issue: "OUVERT" }
  /** Le code est faux. `restants` dit combien d'essais il reste. */
  | { issue: "REFUSE"; restants: number }
  /** Trop d'essais. On ne regarde même pas le code. */
  | { issue: "BLOQUE" };

/**
 * Construit le vérificateur.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI CE N'EST PAS UNE SIMPLE FONCTION
 *
 * Une fonction `verifier(secret, identifiant, code)` serait plus commode, et
 * c'est exactement le problème : elle serait appelable sans compteur, et
 * l'appelant n'aurait aucune raison de se demander ce qui manque. En passant
 * par une construction, l'oubli devient impossible plutôt qu'improbable.
 */
export function verificateur(reglages: {
  secret: string;
  tentatives: Tentatives;
  essaisMax?: number;
}): (
  identifiant: string,
  code: string,
  maintenant?: Date,
) => Promise<Verdict> {
  if (reglages.tentatives == null) {
    throw new Error(
      "Ndank : un vérificateur de code sans compteur de tentatives ne protège " +
        "rien — six chiffres se parcourent en quelques secondes.",
    );
  }

  const essaisMax = reglages.essaisMax ?? ESSAIS_MAX;

  return async (identifiant, code, maintenant = new Date()) => {
    const cle = normaliserIdentifiant(identifiant);

    // Le compteur d'abord, et le code ensuite. L'inverse laisserait mesurer le
    // temps de la comparaison même une fois la porte fermée.
    const faits = await reglages.tentatives.compter(cle);
    if (faits >= essaisMax) return { issue: "BLOQUE" };

    const fenetre = fenetreDe(maintenant);
    const attendus = [
      calculer(reglages.secret, identifiant, fenetre),
      calculer(reglages.secret, identifiant, fenetre - 1),
    ];

    // Les deux fenêtres sont toujours comparées, même quand la première
    // répond : sortir plus tôt ferait de la durée de l'appel un indice sur la
    // fraîcheur du code.
    const bon = attendus.reduce(
      (acquis, attendu) => egales(code, attendu) || acquis,
      false,
    );

    if (!bon) {
      await reglages.tentatives.echec(cle);
      return { issue: "REFUSE", restants: Math.max(0, essaisMax - faits - 1) };
    }

    await reglages.tentatives.reussite(cle);
    return { issue: "OUVERT" };
  };
}

/**
 * Comparaison à durée constante.
 *
 * Sur six chiffres, la différence est de l'ordre de la nanoseconde et personne
 * ne la mesurera à travers un réseau. On la fait quand même, parce que la
 * fonction qui compare un secret ne devrait jamais être celle où l'on décide
 * que la précaution ne valait pas la peine.
 */
function egales(a: string, b: string): boolean {
  const ta = Buffer.from(a, "utf8");
  const tb = Buffer.from(b, "utf8");

  if (ta.length !== tb.length) return false;

  return timingSafeEqual(ta, tb);
}
