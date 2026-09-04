import type { Http, Requete } from "../../http";
import { ErreurPasserelle } from "../port";

/**
 * Ce que tous les transporteurs font pareil : appeler, et se plaindre juste.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI CE N'EST PAS DANS CHAQUE ADAPTATEUR
 *
 * Parce que les quatre auraient répété les mêmes douze lignes, et que la
 * douzième — celle qui distingue « la passerelle a refusé » de « la passerelle
 * a répondu autre chose que du JSON » — est celle qu'on oublie.
 *
 * Une passerelle qui rend une page d'erreur HTML sur un 502 ferait lever
 * `JSON.parse` avec « Unexpected token < », un message qui ne nomme ni la
 * passerelle ni le statut. On perd alors une demi-heure à chercher un défaut de
 * code là où il n'y avait qu'un service momentanément indisponible.
 */

/** Appelle, et lève `ErreurPasserelle` si la passerelle a refusé. */
export async function appelJson(
  passerelle: string,
  http: Http,
  requete: Requete,
): Promise<unknown> {
  const reponse = await http(requete);

  if (reponse.statut < 200 || reponse.statut >= 300) {
    throw new ErreurPasserelle(passerelle, reponse.statut, reponse.corps);
  }

  // Un corps vide est une réponse valable : certaines passerelles répondent
  // 202 sans rien dire. `JSON.parse("")` lèverait, et l'envoi serait compté en
  // échec alors qu'il est parti.
  if (reponse.corps.trim() === "") return {};

  try {
    return JSON.parse(reponse.corps) as unknown;
  } catch {
    throw new ErreurPasserelle(
      passerelle,
      reponse.statut,
      reponse.corps,
      `${passerelle} a répondu ${reponse.statut} avec autre chose que du JSON`,
    );
  }
}

/** Un objet, ou un objet vide. Évite un `as` dans chaque adaptateur. */
export function objet(valeur: unknown): Record<string, unknown> {
  return valeur !== null && typeof valeur === "object"
    ? (valeur as Record<string, unknown>)
    : {};
}

/** Une chaîne, ou `null`. */
export function chaine(valeur: unknown): string | null {
  return typeof valeur === "string" && valeur !== "" ? valeur : null;
}

/**
 * L'en-tête d'authentification HTTP Basic.
 *
 * `Buffer` plutôt que `btoa` : `btoa` ne prend que du latin-1 et lève sur un
 * secret qui sortirait de l'ASCII. Aucun fournisseur n'en émet, mais un hôte
 * peut coller un caractère invisible en recopiant sa clé — et l'erreur parlerait
 * alors d'encodage, pas de configuration.
 */
export function basique(utilisateur: string, secret: string): string {
  return `Basic ${Buffer.from(`${utilisateur}:${secret}`, "utf8").toString("base64")}`;
}
