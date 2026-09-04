/**
 * Ndank — échapper ce qui vient du dehors.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UN SEUL EXEMPLAIRE, ET C'EST TOUT L'INTÉRÊT DE CE FICHIER
 *
 * Deux endroits produisent du HTML : la rédaction d'un courriel et la page de
 * validation. Chacun pourrait avoir son échappement de cinq lignes — et c'est
 * précisément comme cela qu'on se retrouve avec deux, dont un qui a oublié
 * l'apostrophe.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QUI TRAVERSE N'EST PAS DU TEXTE DE CONFIANCE
 *
 * Le libellé d'une offre et le nom d'un abonné viennent de la base de l'hôte,
 * où quelqu'un les a saisis. Une apostrophe dans « L'Atelier » suffit à casser
 * un attribut ; le reste suffit à y placer du script.
 *
 * Les cinq caractères sont échappés, y compris dans les attributs — une URL qui
 * contient un guillemet refermerait le `href` et laisserait le reste de la
 * chaîne devenir des attributs.
 */

export function echapper(texte: string): string {
  return texte
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
