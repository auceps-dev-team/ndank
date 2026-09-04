import { echapper } from "../html";
import type { ReglagesPage } from "./port";
import type { Vue } from "./vue";

/**
 * Ndank — la page, en HTML et rien d'autre.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * AUCUNE RESSOURCE EXTÉRIEURE, ET CE N'EST PAS DU PURISME
 *
 * Pas de feuille de style distante, pas de police téléchargée, pas de
 * bibliothèque, pas d'image. Tout tient dans la réponse.
 *
 * Trois raisons, et la première suffirait :
 *
 *   — **le réseau.** Cette page s'ouvre depuis un SMS, sur un téléphone
 *     d'entrée de gamme, en 3G, parfois en itinérance. Chaque requête
 *     supplémentaire est une occasion d'attendre, et chaque attente est un
 *     abandon. La page complète pèse moins qu'un logo ;
 *
 *   — **les serveurs mandataires des opérateurs**, qui bloquent, réécrivent ou
 *     mettent en cache les ressources tierces de façon imprévisible ;
 *
 *   — **la politique de sécurité du contenu** de l'hôte, qu'on n'a pas à
 *     obliger à ouvrir des domaines pour afficher un bouton.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ELLE FONCTIONNE SANS JAVASCRIPT
 *
 * Le choix se fait par un formulaire, l'attente par un rafraîchissement
 * automatique. Il n'y a pas une ligne de script.
 *
 * Ce n'est pas une position de principe : c'est que la page est le dernier
 * écran avant qu'un abonné ne perde son accès, et qu'un navigateur d'entrée de
 * gamme, un mode économie de données ou un lecteur d'écran ne doivent pas
 * pouvoir la rendre inutilisable.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ELLE NE DOIT PAS ÊTRE INDEXÉE
 *
 * Elle affiche le montant que quelqu'un doit, et le nom de ce à quoi il est
 * abonné. Un lien collé dans un fil public suffirait à la faire visiter par un
 * robot. `noindex, nofollow, noarchive` — et le routeur y ajoute
 * `Cache-Control: no-store`, parce qu'une balise ne dit rien aux mandataires.
 */

/** Le nom affiché quand l'hôte n'en donne pas. */
const MARQUE_PAR_DEFAUT = "Renouvellement";

const STYLE = `
:root{color-scheme:light dark;--fond:#fbfaf8;--carte:#fff;--encre:#181614;--doux:#6b6560;--trait:#e4dfd8;--vif:#0b7a4b;--vif-encre:#fff;--alerte:#a3341f}
@media(prefers-color-scheme:dark){:root{--fond:#141311;--carte:#1d1b19;--encre:#f2efea;--doux:#a49d95;--trait:#312e2a;--vif:#2ea36c;--vif-encre:#08130d;--alerte:#e0745c}}
*{box-sizing:border-box}
body{margin:0;padding:24px 16px;background:var(--fond);color:var(--encre);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:29rem;margin:0 auto}
.marque{font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:var(--doux);margin:0 0 18px}
.carte{background:var(--carte);border:1px solid var(--trait);border-radius:14px;padding:22px}
h1{font-size:1.3rem;line-height:1.3;margin:0 0 6px}
p{margin:0 0 14px}
.doux{color:var(--doux);font-size:.92rem}
.somme{font-size:2rem;font-weight:650;letter-spacing:-.02em;margin:14px 0 2px}
.rature{color:var(--doux);font-size:.92rem;margin:0 0 14px}
fieldset{border:0;padding:0;margin:0 0 18px}
legend{font-weight:600;margin-bottom:10px;padding:0}
label.moyen{display:flex;align-items:center;gap:12px;border:1px solid var(--trait);border-radius:10px;padding:14px;margin-bottom:8px;cursor:pointer}
label.moyen:has(input:checked){border-color:var(--vif);box-shadow:inset 0 0 0 1px var(--vif)}
input[type=radio]{width:20px;height:20px;accent-color:var(--vif);margin:0}
.champ{display:block;margin-bottom:18px}
.champ span{display:block;font-weight:600;margin-bottom:6px}
input[type=tel],input[type=text]{width:100%;padding:13px;font-size:1rem;border:1px solid var(--trait);border-radius:10px;background:var(--fond);color:var(--encre)}
button{width:100%;padding:15px;font-size:1.05rem;font-weight:600;border:0;border-radius:10px;background:var(--vif);color:var(--vif-encre);cursor:pointer}
.lien{display:inline-block;margin-top:6px;color:var(--vif)}
.alerte{color:var(--alerte)}
.pastille{width:10px;height:10px;border-radius:50%;background:var(--vif);display:inline-block;margin-right:8px}
ol{padding-left:1.2rem;margin:0 0 14px}
li{margin-bottom:6px}
`.trim();

/** Le squelette commun. `enTete` reçoit les balises propres à chaque page. */
function coquille(
  titre: string,
  contenu: string,
  reglages: ReglagesPage,
  enTete = "",
): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>${echapper(titre)}</title>
<style>${STYLE}</style>
${enTete}</head>
<body>
<main>
<p class="marque">${echapper(reglages.marque ?? MARQUE_PAR_DEFAUT)}</p>
<div class="carte">
${contenu}
</div>
</main>
</body>
</html>`;
}

/** Le lien de retour vers le produit de l'hôte, s'il en a donné un. */
function retour(reglages: ReglagesPage): string {
  if (!reglages.retour) return "";
  return `<p><a class="lien" href="${echapper(reglages.retour)}">Retourner sur ${echapper(reglages.marque ?? "le site")}</a></p>`;
}

/**
 * L'échéance dite à l'abonné.
 *
 * Elle reprend les mots de la relance qu'il vient de lire — « dans 3 jours »,
 * « demain » — parce que voir deux formulations différentes du même délai fait
 * douter de la première.
 */
function delai(joursRestants: number): string {
  if (joursRestants > 1) return `dans ${joursRestants} jours`;
  if (joursRestants === 1) return "demain";
  if (joursRestants === 0) return "aujourd'hui";
  if (joursRestants === -1) return "depuis hier";
  return `depuis ${-joursRestants} jours`;
}

/**
 * La page de choix : ce qu'on doit, et par quoi payer.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * LE MONTANT EST MODIFIABLE, ET BORNÉ PAR LE FORMULAIRE
 *
 * `max` et `min` sur le champ arrêtent la faute de frappe avant l'envoi, sur le
 * téléphone, là où elle se commet. Le serveur revérifie — un attribut HTML
 * n'est pas un contrôle — mais l'abonné, lui, voit son erreur tout de suite au
 * lieu d'arriver sur un écran de refus.
 */
export function pageAReger(
  vue: Extract<Vue, { quoi: "A_REGLER" }>,
  reglages: ReglagesPage,
  action: string,
): string {
  const { abonnement } = vue;
  const devise = abonnement.devise;

  const moyens = reglages.fournisseurs
    .map(
      (f, i) => `<label class="moyen">
<input type="radio" name="fournisseur" value="${echapper(f.nom)}"${i === 0 ? " checked" : ""} required>
<span>${echapper(f.libelle)}</span>
</label>`,
    )
    .join("\n");

  // Le champ n'apparaît que si l'un des moyens en a besoin. Demander un numéro
  // que la page hébergée du fournisseur redemandera est le genre de détail qui
  // fait abandonner un paiement.
  const demandeTelephone = reglages.fournisseurs.some((f) => f.telephone);

  const champTelephone = demandeTelephone
    ? `<label class="champ">
<span>Numéro mobile money</span>
<input type="tel" name="telephone" inputmode="tel" autocomplete="tel" placeholder="07 00 00 00 00" required>
</label>`
    : "";

  const dejaVerse =
    vue.verse > 0
      ? `<p class="rature">Déjà versé : ${echapper(reglages.montant(vue.verse, devise))} sur ${echapper(reglages.montant(vue.du, devise))}.</p>`
      : "";

  const situation =
    vue.joursRestants < 0
      ? `<p>Votre accès est suspendu ${delai(vue.joursRestants)}. Il reprend dès le règlement, sans repartir de zéro.</p>`
      : `<p>Votre accès s'arrête ${delai(vue.joursRestants)}.</p>`;

  return coquille(
    `Renouveler ${abonnement.libelle}`,
    `<h1>${echapper(abonnement.libelle)}</h1>
${situation}
<p class="somme">${echapper(reglages.montant(vue.reste, devise))}</p>
${dejaVerse}
<form method="post" action="${echapper(action)}">
<fieldset>
<legend>Payer avec</legend>
${moyens}
</fieldset>
${champTelephone}
<label class="champ">
<span>Montant à régler</span>
<input type="text" name="montant" inputmode="numeric" value="${vue.reste}" required>
</label>
<button type="submit">Régler ${echapper(reglages.montant(vue.reste, devise))}</button>
</form>
<p class="doux" style="margin-top:16px">Le paiement se fait chez votre opérateur. ${echapper(reglages.marque ?? "Ce service")} ne conserve aucune donnée bancaire.</p>`,
    reglages,
  );
}

/**
 * La page d'attente : le fournisseur a poussé la demande, l'abonné valide.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * LE RAFRAÎCHISSEMENT EST BORNÉ, ET L'ABONNÉ GARDE LA MAIN
 *
 * Sans borne, un onglet laissé ouvert interrogerait le fournisseur toutes les
 * cinq secondes jusqu'à ce que le téléphone s'éteigne — et ces appels-là sont
 * comptés, parfois facturés.
 *
 * Passé la limite, la page cesse de se recharger seule et propose un bouton.
 * C'est aussi ce qu'il faut pour quelqu'un qui a raté la demande sur son
 * téléphone : il la refait, puis il vérifie.
 */
export function pageAttente(
  reglages: ReglagesPage,
  suivant: string,
  instruction: string | null,
  encore: boolean,
): string {
  const enTete = encore
    ? `<meta http-equiv="refresh" content="5;url=${echapper(suivant)}">\n`
    : "";

  const consigne =
    instruction ??
    "Une demande de paiement vient d'être envoyée sur votre téléphone. " +
      "Ouvrez-la et saisissez votre code secret.";

  const suite = encore
    ? `<p class="doux"><span class="pastille"></span>Nous vérifions toutes les cinq secondes. Vous pouvez laisser cette page ouverte.</p>`
    : `<p class="doux">Nous avons arrêté de vérifier automatiquement.</p>`;

  return coquille(
    "En attente de votre validation",
    `<h1>En attente de votre validation</h1>
<p>${echapper(consigne)}</p>
<ol class="doux">
<li>Regardez l'écran de votre téléphone.</li>
<li>Saisissez votre code secret mobile money.</li>
<li>Revenez ici — cette page se met à jour toute seule.</li>
</ol>
${suite}
<p><a class="lien" href="${echapper(suivant)}">Vérifier maintenant</a></p>`,
    reglages,
    enTete,
  );
}

/** La page de fin, dans les deux sens. */
export function pageIssue(
  reglages: ReglagesPage,
  reussi: boolean,
  message: string,
  reprendre: string | null,
): string {
  const titre = reussi ? "Paiement reçu" : "Le paiement n'a pas abouti";

  const action =
    reussi || reprendre === null
      ? ""
      : `<p><a class="lien" href="${echapper(reprendre)}">Réessayer</a></p>`;

  return coquille(
    titre,
    `<h1${reussi ? "" : ' class="alerte"'}>${echapper(titre)}</h1>
<p>${echapper(message)}</p>
${action}
${retour(reglages)}`,
    reglages,
  );
}

/**
 * Les pages qui ne mènent nulle part.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * UN JETON FORGÉ ET UN JETON INEXISTANT DISENT LA MÊME CHOSE
 *
 * Distinguer les deux à l'écran apprendrait à celui qui essaie quand il chauffe.
 * L'expiration, elle, se distingue : c'est le seul cas où l'abonné n'a rien
 * fait de mal et où lui dire quoi faire a un sens.
 */
export function pageMessage(
  reglages: ReglagesPage,
  titre: string,
  corps: string,
): string {
  return coquille(
    titre,
    `<h1>${echapper(titre)}</h1>
<p>${echapper(corps)}</p>
${retour(reglages)}`,
    reglages,
  );
}
