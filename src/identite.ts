import { createHmac } from "node:crypto";

/**
 * Ndank — comment un abonné se désigne d'un hôte à l'autre.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE SEUL ENDROIT OÙ CETTE RÈGLE EST ÉCRITE
 *
 * Deux modules en dépendent : la projection, qui pousse une carte vers Ndank
 * App, et le code SMS, par lequel l'abonné se connecte pour la lire. Si les
 * deux ne normalisaient pas exactement pareil, l'abonné recevrait un code
 * calculé sur une écriture de son numéro et verrait des cartes rangées sous une
 * autre. La règle vit donc ici, et nulle part ailleurs.
 */

/**
 * Réduit un identifiant à la forme sous laquelle il traverse les hôtes.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ELLE LÈVE SUR UN NUMÉRO QUI N'EST PAS EN E.164, ET C'EST VOULU
 *
 * On pourrait se contenter de retirer ce qui n'est pas un chiffre. Ce serait
 * commode, et ce serait la panne qu'on ne voit jamais : un hôte qui range
 * « 0700000000 » et un autre « +2250700000000 » donneraient deux identités pour
 * la même personne, et la vue multi-sites — dont c'est toute la raison d'être —
 * n'afficherait qu'une carte sur deux. Sans erreur, sans trace, sans que
 * personne ne sache quoi chercher.
 *
 * Et l'on ne peut pas deviner l'indicatif manquant : `+225` est une hypothèse
 * qui a l'air raisonnable jusqu'au premier abonné sénégalais. Ndank App, qui
 * recolle des hôtes de plusieurs pays, ne peut en supposer aucun.
 *
 * L'hôte, lui, sait le sien. Il a `enE164` et son `indicatifParDefaut` — c'est
 * à lui de convertir, une fois, à l'entrée. On lève donc plutôt que de laisser
 * passer, parce qu'une exception au premier appel se corrige en une minute là
 * où une identité coupée en deux se découvre six mois plus tard.
 */
export function normaliserIdentifiant(identifiant: string): string {
  const brut = identifiant.trim();

  if (brut.includes("@")) return brut.toLowerCase();

  if (!brut.startsWith("+")) {
    throw new Error(
      `Ndank : « ${brut} » n'est pas un numéro au format E.164. Un identifiant ` +
        "d'abonné doit commencer par « + » et porter son indicatif, sinon deux " +
        "hôtes désigneront la même personne de deux façons et la vue " +
        "multi-sites ne recollera rien. Passez-le par `enE164` avant.",
    );
  }

  const chiffres = brut.replace(/[^\d]/g, "");
  if (chiffres.length < 8) {
    throw new Error(
      `Ndank : « ${brut} » est trop court pour un numéro international.`,
    );
  }

  return `+${chiffres}`;
}

/**
 * L'identité d'un abonné, telle qu'elle traverse les hôtes.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QUE CETTE EMPREINTE FAIT, ET CE QU'ELLE NE FAIT PAS
 *
 * Il faut le dire sans détour, parce que le contraire se croit facilement.
 *
 * **Ce n'est pas de l'anonymisation.** Un numéro de téléphone vit dans un
 * espace minuscule — quelques milliards de valeurs — et quiconque tient le
 * poivre peut en dresser la table complète en quelques heures. Une empreinte de
 * numéro se retrouve, toujours.
 *
 * **Ce qu'elle fait quand même**, et qui n'est pas rien : une copie de la base
 * de Ndank App, prise sans le poivre, ne livre pas un annuaire. C'est la
 * différence entre une fuite qui donne des numéros et une fuite qui donne des
 * empreintes qu'il faut encore vouloir casser.
 *
 * Le poivre est **partagé** entre Ndank App et tous les hôtes — il le faut,
 * puisque l'hôte doit calculer l'empreinte pour la pousser, et Ndank App doit
 * la recalculer quand l'abonné se connecte. Il fuit donc avec n'importe lequel
 * d'entre eux.
 *
 * La conclusion honnête : Ndank App **détient des données personnelles** pour
 * le compte de plusieurs marchands, et l'empreinte ne l'en dispense pas. Elle
 * réduit l'exposition accidentelle, pas l'attaque décidée.
 */
export function empreinte(identifiant: string, poivre: string): string {
  return createHmac("sha256", poivre)
    .update(normaliserIdentifiant(identifiant), "utf8")
    .digest("base64url");
}
