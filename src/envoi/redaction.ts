import { replierAvecPertes, segments } from "../gsm7";
import type { Message } from "../ports";

/**
 * Ndank — un fait, trois formes.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * POURQUOI LA RÉDACTION EST UN MODULE, ET PAS UN GABARIT
 *
 * `Message` porte des faits : une offre, un montant déjà formaté, un lien, un
 * nombre de jours. Il ne porte pas de phrase, et c'est délibéré — un SMS se
 * paie au caractère, un courriel peut s'étendre, une notification tient en une
 * ligne et doit pouvoir porter un bouton.
 *
 * Restait à écrire les phrases quelque part. Les laisser à l'hôte revenait à
 * lui demander de réécrire trois fois le même message, dont un dans une
 * contrainte qu'il découvrirait à la première facture d'opérateur.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * TOUT EST PUR, DONC TOUT EST VÉRIFIABLE
 *
 * Aucun appel réseau, aucune date, aucun aléa. On donne un `Message`, on obtient
 * trois textes — c'est ce qui permet d'éprouver « le lien n'est jamais coupé »
 * ou « un nom absent ne devient pas le nom de l'offre » sans rien monter.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LA LANGUE EST LE FRANÇAIS, ET CE N'EST PAS UN OUBLI
 *
 * Ndank sert la zone franc. Traduire suppose de savoir dans quelle langue écrire
 * à cet abonné-là, ce que le cœur ne sait pas et n'a pas à savoir : ce serait un
 * champ de plus dans `Coordonnees`, qu'il faudrait remplir partout.
 *
 * L'hôte qui a besoin d'une autre langue n'écrit pas un gabarit : il remplace ce
 * module par le sien, et garde tout le reste. C'est la même liberté que pour les
 * ports — voir `Transporteurs` dans `compose.ts`, qui accepte n'importe quelle
 * rédaction.
 */

// ────────────────────────────────────────────────────────────── les formes ──

export interface Courriel {
  sujet: string;
  /** Le corps en texte brut. Suffisant à lui seul : l'hôte peut ignorer `html`. */
  texte: string;
  html: string;
}

export interface Sms {
  /** Déjà replié en GSM-7 : c'est ce que l'opérateur enverra, caractère pour caractère. */
  texte: string;
  /** Segments facturés. Un, sauf si le lien à lui seul déborde. */
  segments: number;
  /** Ce que le repli n'a pas su rendre. Vide, presque toujours. */
  perdus: string[];
  /** Vrai si le nom de l'offre a dû être raccourci pour tenir. */
  tronque: boolean;
}

export interface Push {
  titre: string;
  corps: string;
  /** Où le clic mène. */
  lien: string;
  /**
   * De quoi remplacer une notification par la suivante plutôt que de les empiler.
   *
   * C'est la clé de relance, donc elle change à chaque palier — deux paliers
   * différents ne se remplacent pas. Mais un appareil resté éteint trois jours
   * peut recevoir d'un coup ce qui a été poussé entre-temps, et l'abonné n'a
   * pas à voir trois fois la même chose au réveil.
   */
  identifiant: string;
}

/** Ce qu'une notification peut afficher avant que le système ne coupe. */
export const LIMITE_TITRE = 40;
export const LIMITE_CORPS = 120;

/**
 * Combien de segments un SMS de relance a le droit de coûter.
 *
 * Un. Sur mille abonnés mensuels relancés deux fois, passer à deux segments
 * double la facture d'opérateur pour une phrase plus jolie.
 */
export const SEGMENTS_MAX = 1;

// ─────────────────────────────────────────────────────────────── le fond ──

/**
 * L'échéance dite en français, à partir du seul nombre de jours.
 *
 * `court` pour le SMS, où « dans 5 j » économise quatre septets sur « dans 5
 * jours » — c'est-à-dire quatre caractères de nom d'offre qu'on n'aura pas à
 * couper.
 */
export function delai(joursRestants: number, court = false): string {
  if (joursRestants > 1) {
    return court ? `dans ${joursRestants} j` : `dans ${joursRestants} jours`;
  }
  if (joursRestants === 1) return "demain";
  if (joursRestants === 0) return "aujourd'hui";
  if (joursRestants === -1) return "depuis hier";

  const passes = -joursRestants;
  return court ? `depuis ${passes} j` : `depuis ${passes} jours`;
}

/**
 * La phrase qu'on ne peut pas ne pas écrire.
 *
 * Un paiement mobile money se confirme par webhook, et le webhook arrive quand
 * il arrive — parfois quelques minutes après. Le passage quotidien, lui, part à
 * heure fixe. Un abonné qui a réglé la veille au soir recevra donc parfois la
 * relance du matin.
 *
 * Sans cette ligne, il conclut qu'on ne l'a pas vu payer, et il repaie. C'est
 * un incident de support, un remboursement à faire, et un abonné qui se
 * méfiera la fois suivante — pour trois lignes de code qui n'ont pas su
 * s'accorder sur une horloge.
 */
const CROISEMENT =
  "Si vous venez de régler, ce message a pu croiser votre paiement — " +
  "dans ce cas, il n'y a rien à faire.";

// ──────────────────────────────────────────────────────────────── courriel ──

/** Les cinq caractères qui, non échappés, cassent un corps HTML. */
function echapper(texte: string): string {
  return texte
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Le courriel.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * DU HTML NU, ET AUCUNE IMAGE
 *
 * Pas de tableau de mise en page, pas de feuille de style externe, pas de logo.
 * Trois raisons, dans l'ordre d'importance :
 *
 *   — un courriel transactionnel sobre passe les filtres que les courriels de
 *     campagne ne passent pas, et celui-ci annonce une coupure de service ;
 *   — Ndank ne connaît ni la charte ni le logo de l'hôte, et en inventer un
 *     ferait envoyer un message qui ne ressemble pas à lui ;
 *   — le texte brut suffit. `html` est un confort, pas le message.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * TOUT CE QUI VIENT DU DEHORS EST ÉCHAPPÉ
 *
 * Le libellé de l'offre et le nom de l'abonné viennent de la base de l'hôte, et
 * un nom avec une apostrophe suffit à casser le rendu. Le lien aussi est
 * échappé, y compris dans le `href` : une URL avec un `"` y refermerait
 * l'attribut.
 */
export function redigerCourriel(message: Message): Courriel {
  const coupe = message.joursRestants < 0;
  const quand = delai(message.joursRestants);

  const sujet = coupe
    ? `Votre accès à ${message.offre} est suspendu`
    : message.dernier
      ? `Dernier rappel : votre accès à ${message.offre} s'arrête ${quand}`
      : `Votre abonnement ${message.offre} est à renouveler`;

  // « Bonjour, » et non « Bonjour Pass Créateur, » : quand on ignore le nom, on
  // ne le remplace par rien. Voir `Message.destinataire`.
  const salutation = message.destinataire
    ? `Bonjour ${message.destinataire},`
    : "Bonjour,";

  const situation = coupe
    ? `Votre accès à ${message.offre} est suspendu ${quand}. ` +
      `Il peut reprendre dès le règlement, sans repartir de zéro.`
    : `Votre abonnement ${message.offre} arrive à échéance : ` +
      `l'accès s'arrête ${quand}.`;

  const action = coupe ? "Reprendre mon abonnement" : "Renouveler maintenant";

  const texte = [
    salutation,
    "",
    situation,
    "",
    `Montant : ${message.montant}`,
    `${action} : ${message.lien}`,
    "",
    CROISEMENT,
  ].join("\n");

  const lien = echapper(message.lien);

  const html = [
    `<p>${echapper(salutation)}</p>`,
    `<p>${echapper(situation)}</p>`,
    `<p><strong>Montant : ${echapper(message.montant)}</strong></p>`,
    `<p><a href="${lien}">${echapper(action)}</a></p>`,
    `<p>${echapper(CROISEMENT)}</p>`,
  ].join("\n");

  return { sujet, texte, html };
}

// ───────────────────────────────────────────────────────────────────── sms ──


/** Le nom de l'offre, ramené à `k` caractères. Vide si `k` vaut zéro. */
function abreger(offre: string, k: number): string {
  if (k <= 0) return "";

  const coupe = offre.slice(0, k).trimEnd();
  if (coupe === "") return "";

  // Un point plutôt qu'une ellipse : « … » n'existe pas en GSM-7, `replier` le
  // supprimerait, et la coupure ne se verrait plus du tout.
  return `${coupe}.`;
}

/**
 * Le SMS, tenu dans son budget.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE LIEN NE SE COUPE JAMAIS
 *
 * C'est la seule règle absolue de cette fonction. Un SMS trop long coûte un
 * segment de plus ; un lien tronqué ne mène nulle part, donc la relance la plus
 * chère de l'échelle — celle qu'on n'envoie qu'au moment où l'accès va tomber —
 * ne sert à rien du tout.
 *
 * Ce qui cède, c'est le nom de l'offre. C'est aussi la seule partie variable
 * dont on puisse se passer : l'abonné sait à quoi il est abonné.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ON MESURE APRÈS LE REPLI, ET PAR DICHOTOMIE
 *
 * Le repli n'est pas neutre en longueur : « œ » devient « oe », donc un
 * caractère en devient deux. Mesurer avant le repli sous-estimerait le coût, et
 * le message tiendrait sur le papier en débordant sur la facture.
 *
 * La recherche passe par `segments()` plutôt que par un compte de septets écrit
 * ici. Les tables de l'alphabet ne sont pas exportées, et les recopier ferait
 * exactement ce que ce dépôt reproche partout ailleurs : deux vérités pour un
 * seul fait, qui finiraient par diverger. Six itérations suffisent pour un nom
 * d'offre de soixante caractères.
 */
export function redigerSms(message: Message, segmentsMax = SEGMENTS_MAX): Sms {
  const coupe = message.joursRestants < 0;

  const composer = (offre: string): string => {
    const tete = offre === "" ? "" : `${offre} : `;

    const corps = coupe
      ? `accès suspendu, ${message.montant} pour reprendre`
      : `${message.montant} à régler, accès coupé ${delai(message.joursRestants, true)}`;

    // Rien à normaliser ici : `replier` s'occupe des espaces typographiques que
    // `Intl.NumberFormat` glisse dans un montant. Une seconde table de replis à
    // cet étage aurait fini par diverger de la première.
    return `${tete}${corps}. ${message.lien}`;
  };

  const complet = replierAvecPertes(composer(message.offre));

  if (segments(complet.texte) <= segmentsMax) {
    return {
      texte: complet.texte,
      segments: segments(complet.texte),
      perdus: complet.perdus,
      tronque: false,
    };
  }

  // Le plus long nom d'offre qui tienne encore. `abreger` est croissant en `k`,
  // donc la dichotomie est licite.
  let bas = 0;
  let haut = message.offre.length;
  let meilleur = 0;

  while (bas <= haut) {
    const milieu = (bas + haut) >> 1;
    const essai = replierAvecPertes(composer(abreger(message.offre, milieu)));

    if (segments(essai.texte) <= segmentsMax) {
      meilleur = milieu;
      bas = milieu + 1;
    } else {
      haut = milieu - 1;
    }
  }

  // `meilleur` vaut zéro quand même le lien seul déborde. On envoie alors le
  // message le plus court possible et on paie le second segment : c'est le prix
  // d'un lien qui fonctionne, et l'hôte le voit dans `segments`.
  const retenu = replierAvecPertes(composer(abreger(message.offre, meilleur)));

  return {
    texte: retenu.texte,
    segments: segments(retenu.texte),
    perdus: retenu.perdus,
    tronque: true,
  };
}

// ──────────────────────────────────────────────────────────────────── push ──

/** Coupe au dernier mot entier qui tienne, et le dit avec une ellipse. */
function ecourter(texte: string, max: number): string {
  if (texte.length <= max) return texte;

  const brut = texte.slice(0, max - 1);
  const espace = brut.lastIndexOf(" ");

  // Pas d'espace du tout : un seul mot très long, qu'on coupe net.
  return `${(espace > max / 2 ? brut.slice(0, espace) : brut).trimEnd()}…`;
}

/**
 * La notification.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * C'EST LE NOM DE L'OFFRE QUI CÈDE, ENCORE
 *
 * Un titre trop long est coupé par le système, sans prévenir et sans ellipse.
 * Le raccourcir ici en partant de la fin effacerait « — dernier rappel », qui
 * est précisément ce qui distingue cette notification de la précédente.
 *
 * On réserve donc la place du suffixe, et c'est le nom de l'offre qu'on abrège
 * — comme dans le SMS, et pour la même raison : l'abonné sait à quoi il est
 * abonné, il ne sait pas qu'on va lui couper l'accès.
 */
export function redigerPush(message: Message): Push {
  const coupe = message.joursRestants < 0;

  const suffixe = coupe
    ? " — accès suspendu"
    : message.dernier
      ? " — dernier rappel"
      : " — à renouveler";

  // Huit caractères d'offre au minimum : en dessous, le titre ne désigne plus
  // rien et autant n'afficher que le suffixe.
  const place = Math.max(8, LIMITE_TITRE - suffixe.length);

  const corps = coupe
    ? `${message.montant} pour reprendre. Touchez pour régler.`
    : `${message.montant} · accès coupé ${delai(message.joursRestants)}. Touchez pour régler.`;

  return {
    titre: ecourter(message.offre, place) + suffixe,
    corps: ecourter(corps, LIMITE_CORPS),
    lien: message.lien,
    identifiant: message.cle,
  };
}
