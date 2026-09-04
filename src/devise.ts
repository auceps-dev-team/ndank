/**
 * Ndank — combien de décimales une devise a, et ce que les fournisseurs en font.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE FICHIER EXISTE À CAUSE D'UNE ERREUR D'UN FACTEUR CENT
 *
 * Jusqu'à la 0.9.0, Ndank affirmait partout que le franc CFA n'a pas de
 * subdivision, donc que deux mille francs s'écrivent `2000` et se transmettent
 * tels quels. La première moitié est vraie — l'ISO 4217 donne bien zéro
 * décimale au XOF et au XAF. La seconde était fausse.
 *
 * Relevé dans le tableau de bord Paystack, en bac à sable :
 *
 *     envoyé « amount: 2000 »    → affiché « XOF 20.00 »
 *     envoyé « amount: 200000 »  → affiché « XOF 2,000.00 »
 *
 * **Paystack compte en centièmes, quelle que soit la devise.** Un abonnement à
 * 2 000 F facturé par Ndank prélevait donc vingt francs. Personne ne s'en
 * serait plaint — c'est une erreur qui va dans le sens de l'abonné — et le
 * marchand l'aurait découverte sur son relevé, un mois plus tard.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * NDANK COMPTE EN UNITÉS MINEURES ISO, ET CHAQUE ADAPTATEUR CONVERTIT
 *
 * L'unité interne reste celle de la norme : `2000` en XOF vaut deux mille
 * francs, `2000` en GHS vaut vingt cedis. C'est ce que les gens de la zone ont
 * en tête, c'est ce que le schéma stocke, et c'est ce que la grille tarifaire
 * demande d'écrire.
 *
 * La divergence est une affaire de fournisseur, donc elle vit chez le
 * fournisseur — exactement comme la traduction des statuts. Un adaptateur qui
 * se trompe ne contamine pas les autres, et la règle se lit à l'endroit où
 * elle s'applique.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LA DEVISE N'EST PAS UN CHOIX DE L'HÔTE
 *
 * Second enseignement de la même séance : un compte marchand n'active que les
 * devises de son marché. Sur un compte XOF, `NGN`, `GHS`, `KES`, `ZAR` et `USD`
 * reviennent tous en `403 Currency not supported by merchant`.
 *
 * La devise d'une offre n'est donc pas librement décidée dans la grille : elle
 * est **imposée par le compte du fournisseur**. Écrire `GHS` dans sa grille
 * quand on a un compte sénégalais ne produit pas une conversion, cela produit
 * un refus — au premier abonné qui clique, pas au démarrage.
 */

/**
 * Les devises sans décimale, telles que l'ISO 4217 les définit.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * UNE LISTE ET NON UNE RÈGLE, PARCE QU'IL N'Y A PAS DE RÈGLE
 *
 * Rien dans un code de trois lettres ne dit combien de décimales il porte. La
 * norme le fixe devise par devise, et la seule façon de le savoir est de le
 * savoir.
 *
 * Celles qui comptent pour Ndank sont en tête : le franc CFA des deux zones,
 * puis les autres monnaies africaines sans subdivision en circulation. Les
 * trois dernières ne servent à rien ici et sont là pour que la table soit juste
 * plutôt que régionale — une table à moitié vraie invite à s'y fier.
 */
export const SANS_DECIMALE: readonly string[] = [
  "XOF", // franc CFA — UEMOA : Bénin, Burkina, Côte d'Ivoire, Guinée-Bissau,
  //        Mali, Niger, Sénégal, Togo
  "XAF", // franc CFA — CEMAC : Cameroun, Centrafrique, Congo, Gabon, Guinée
  //        équatoriale, Tchad
  "GNF", // franc guinéen
  "RWF", // franc rwandais
  "BIF", // franc burundais
  "DJF", // franc de Djibouti
  "KMF", // franc comorien
  "UGX", // shilling ougandais
  "MRU", // ouguiya mauritanien — cinquièmes, pas centièmes ; la norme le compte
  //        à une décimale, mais aucun fournisseur ne sait faire, et zéro est
  //        le repli sûr : on facture au chiffre entier
  "JPY",
  "KRW",
  "VND",
];

const SANS = new Set(SANS_DECIMALE);

/**
 * Combien de décimales cette devise porte, selon l'ISO 4217.
 *
 * Deux par défaut, parce que c'est le cas de la très grande majorité des
 * devises — et parce que se tromper dans ce sens **sous-facture**. L'erreur
 * inverse débiterait cent fois trop, sur le téléphone d'une vraie personne, et
 * Ndank ne rembourse pas : il n'a jamais touché l'argent.
 */
export function exposant(devise: string): number {
  return SANS.has(devise.toUpperCase()) ? 0 : 2;
}

/**
 * Convertit un montant Ndank vers l'unité qu'attend un fournisseur.
 *
 * `decimalesFournisseur` est le nombre de décimales que le fournisseur emploie,
 * **indépendamment de la norme** : deux pour Paystack, quoi qu'il arrive ; zéro
 * pour un fournisseur qui compte en unités majeures.
 *
 * Le calcul reste entier dans les deux sens. Passer par un flottant
 * introduirait, sur des sommes qui sont de l'argent réel, la seule catégorie
 * d'erreur qu'on ne rattrape jamais.
 */
export function versFournisseur(
  mineures: number,
  devise: string,
  decimalesFournisseur: number,
): number {
  const ecart = decimalesFournisseur - exposant(devise);

  if (ecart === 0) return mineures;
  if (ecart > 0) return mineures * 10 ** ecart;

  // Le fournisseur compte plus gros que nous : on divise. Un reste non nul
  // voudrait dire qu'on lui demande une précision qu'il ne sait pas porter —
  // mieux vaut arrondir au supérieur que de facturer moins que le prix affiché.
  return Math.ceil(mineures / 10 ** -ecart);
}

/** Le chemin inverse : ce que le fournisseur rapporte, ramené aux unités Ndank. */
export function depuisFournisseur(
  montant: number,
  devise: string,
  decimalesFournisseur: number,
): number {
  const ecart = decimalesFournisseur - exposant(devise);

  if (ecart === 0) return montant;
  if (ecart > 0) return Math.round(montant / 10 ** ecart);

  return montant * 10 ** -ecart;
}

/**
 * Le montant écrit pour un humain.
 *
 * Fourni parce que chaque couche en avait besoin et que chacune l'aurait écrit
 * à sa façon : la page de validation, la rédaction des relances, le tableau de
 * bord. Trois formatages du même nombre finissent par en afficher trois.
 *
 * `Intl` sait déjà combien de décimales une devise porte — mais il ne connaît
 * pas la nôtre : on lui impose la table ci-dessus, pour que l'affichage et le
 * calcul ne puissent pas diverger.
 *
 * L'hôte reste libre de ne pas s'en servir : `Redaction.montant` et
 * `ReglagesPage.montant` sont des fonctions qu'il fournit.
 */
export function formater(
  mineures: number,
  devise: string,
  locale = "fr-FR",
): string {
  const decimales = exposant(devise);
  const majeur = mineures / 10 ** decimales;

  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: devise,
      minimumFractionDigits: decimales,
      maximumFractionDigits: decimales,
    }).format(majeur);
  } catch {
    // Une devise qu'`Intl` ne connaît pas ne doit pas faire tomber une page de
    // paiement. On rend quelque chose de lisible plutôt que rien.
    return `${majeur.toFixed(decimales)} ${devise.toUpperCase()}`;
  }
}
