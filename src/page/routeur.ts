import { ErreurFournisseur, type Issue } from "../encaissement/port";
import {
  referenceDeVersement,
  referencePour,
} from "../encaissement/reconciliation";
import type { AbonnementLu, Coordonnees } from "../ports";
import type {
  ChoixFournisseur,
  ReglagesPage,
  RequeteWeb,
  ReponseWeb,
} from "./port";
import {
  pageAReger,
  pageAttente,
  pageIssue,
  pageMessage,
} from "./rendu";
import { montantAccepte, vueDe, type Vue } from "./vue";

/**
 * Ndank — la page de validation, sans cadre applicatif.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * TROIS ROUTES, ET RIEN D'AUTRE
 *
 *   `GET  /<jeton>`        ce qu'on doit, et par quoi payer ;
 *   `POST /<jeton>`        le choix — puis une redirection ou une attente ;
 *   `GET  /<jeton>/etat`   on redemande au fournisseur où il en est.
 *
 * Le routeur est une fonction d'une requête vers une réponse. Il ne connaît ni
 * Express, ni Next, ni Node : `montage.ts` fournit les adaptateurs, et
 * `dependencies` reste vide.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QUI SORT DE CETTE PAGE NE DOIT PAS EMPORTER LE JETON
 *
 * Le jeton est dans l'URL. Sans `Referrer-Policy: no-referrer`, le navigateur
 * l'enverrait au fournisseur dans l'en-tête `Referer` au moment de la
 * redirection — et le jeton se retrouverait dans les journaux d'accès d'un
 * tiers, d'où il ouvre la page d'un abonné pendant quinze jours.
 *
 * C'est la raison pour laquelle cet en-tête est là, et il ne faut pas le
 * retirer en croyant simplifier.
 */

/**
 * Combien de fois la page se recharge seule avant de s'arrêter.
 *
 * Vingt-quatre, à cinq secondes : deux minutes, ce qui laisse largement le
 * temps de saisir un code sur un téléphone. Au-delà, l'abonné a raccroché, et
 * un onglet oublié interrogerait le fournisseur jusqu'à la fin de la batterie —
 * des appels qui sont comptés, et parfois facturés.
 */
export const VERIFICATIONS_MAX = 24;

const ENTETES_HTML: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  // Elle affiche un montant dû, nommément. Elle ne doit être ni gardée ni
  // partagée par un mandataire.
  "Cache-Control": "no-store, private",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow",
  // Cohérent avec le rendu, qui ne charge rien : ce qui n'est pas dans la
  // réponse ne doit pas pouvoir s'y ajouter.
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
};

function html(statut: number, corps: string): ReponseWeb {
  return { statut, entetes: { ...ENTETES_HTML }, corps };
}

/**
 * Une redirection en 303, et non en 302.
 *
 * Après le `POST` du formulaire, un 302 laisse certains clients rejouer la
 * méthode. Le 303 impose un `GET` — c'est ce qui fait qu'un rechargement de la
 * page suivante ne redemande pas un second paiement.
 */
function versLa(url: string): ReponseWeb {
  return {
    statut: 303,
    entetes: {
      Location: url,
      "Cache-Control": "no-store, private",
      "Referrer-Policy": "no-referrer",
    },
    corps: "",
  };
}

/** Ce que la page raconte à l'hôte. Facultatif, et jamais montré à l'abonné. */
export interface FaitPage {
  quoi: "OUVERTE" | "INVITEE" | "CONSTATEE" | "REFUSEE" | "ERREUR";
  abonnementId: string | null;
  fournisseur: string | null;
  reference: string | null;
  detail?: string;
  cause?: unknown;
}

export interface ReglagesRouteur extends ReglagesPage {
  /**
   * Où raconter ce qui se passe sur la page.
   *
   * C'est la moitié de la raison d'héberger cette page plutôt que de renvoyer
   * chez le fournisseur : savoir combien de gens l'ouvrent et ne vont pas au
   * bout. Un lien qui part chez l'agrégateur ne le dit jamais.
   */
  journal?: (fait: FaitPage) => void;
}

/** Les pages communes aux trois routes, quand il n'y a rien à régler. */
function selonVue(vue: Vue, reglages: ReglagesPage): ReponseWeb | null {
  if (vue.quoi === "INVALIDE") {
    // « Expiré » mérite une page qui dit quoi faire. Un jeton forgé mérite la
    // même page qu'un jeton inexistant : distinguer les deux apprendrait à
    // celui qui essaie quand il chauffe.
    if (vue.refus === "EXPIRE") {
      return html(
        410,
        pageMessage(
          reglages,
          "Ce lien a expiré",
          "Les liens de renouvellement ne sont valables que quelques jours. " +
            "Le prochain rappel vous en apportera un nouveau — ou connectez-vous " +
            "à votre compte pour régler directement.",
        ),
      );
    }

    return html(
      404,
      pageMessage(
        reglages,
        "Ce lien ne mène nulle part",
        "Vérifiez que vous l'avez copié en entier. Le prochain rappel vous en " +
          "apportera un nouveau.",
      ),
    );
  }

  if (vue.quoi === "INTROUVABLE") {
    return html(
      404,
      pageMessage(
        reglages,
        "Cet abonnement n'existe plus",
        "Il a peut-être été supprimé. Si vous pensez qu'il s'agit d'une " +
          "erreur, contactez le service.",
      ),
    );
  }

  if (vue.quoi === "CLOS") {
    const resilie = vue.etat === "RESILIEE";

    return html(
      410,
      pageMessage(
        reglages,
        resilie ? "Cet abonnement a été résilié" : "Cet abonnement a expiré",
        resilie
          ? "Il n'y a rien à régler ici. Pour reprendre, souscrivez de nouveau " +
              "depuis votre compte."
          : "Le délai de reprise est passé. Se réabonner repart de zéro, depuis " +
              "votre compte.",
      ),
    );
  }

  if (vue.quoi === "A_JOUR") {
    // Le cas qui évite le double paiement : le lien vient d'une relance, donc
    // s'il mène à un abonnement à jour, c'est presque toujours que l'abonné
    // vient de payer et que la relance a croisé son règlement.
    return html(
      200,
      pageMessage(
        reglages,
        "Votre abonnement est à jour",
        vue.joursRestants > 0
          ? `Rien à régler pour l'instant : la prochaine échéance est dans ${vue.joursRestants} jours.`
          : "Rien à régler pour l'instant.",
      ),
    );
  }

  return null;
}

/** Le fournisseur demandé, ou le seul proposé s'il n'y en a qu'un. */
function fournisseurDe(
  reglages: ReglagesPage,
  nom: string | undefined,
): ChoixFournisseur | null {
  if (nom === undefined || nom === "") {
    return reglages.fournisseurs.length === 1
      ? (reglages.fournisseurs[0] ?? null)
      : null;
  }

  return reglages.fournisseurs.find((f) => f.nom === nom) ?? null;
}

/** Les coordonnées connues, quand l'hôte sait les donner. */
async function coordonneesDe(
  reglages: ReglagesPage,
  abonnement: AbonnementLu,
): Promise<Coordonnees | null> {
  if (!reglages.dossier.coordonnees) return null;

  try {
    return await reglages.dossier.coordonnees(abonnement.abonneId);
  } catch {
    // Elles ne servent qu'à embellir la demande. Faire échouer un paiement
    // parce qu'on n'a pas su lire un nom serait absurde.
    return null;
  }
}

/**
 * Fabrique le routeur.
 *
 * `chemin` est relatif au point de montage : `/abc.def.ghi` ou
 * `/abc.def.ghi/etat`.
 */
export function routeurPage(
  reglages: ReglagesRouteur,
): (requete: RequeteWeb) => Promise<ReponseWeb> {
  const base = reglages.base.replace(/\/+$/, "");
  const raconter = (fait: FaitPage): void => {
    try {
      reglages.journal?.(fait);
    } catch {
      /* le journal observe, il ne participe pas */
    }
  };

  return async function router(requete: RequeteWeb): Promise<ReponseWeb> {
    const morceaux = requete.chemin.split("/").filter((m) => m !== "");
    const jeton = morceaux[0];
    const sous = morceaux[1];

    if (jeton === undefined || morceaux.length > 2) {
      return html(
        404,
        pageMessage(
          reglages,
          "Page introuvable",
          "Ce lien ne correspond à rien.",
        ),
      );
    }

    const vue = await vueDe(reglages, jeton);
    const autre = selonVue(vue, reglages);

    // Le jeton est mauvais, ou il n'y a rien à régler. Vrai pour les trois
    // routes : on ne constate pas un paiement sur un lien qu'on refuse
    // d'afficher.
    if (autre !== null) {
      raconter({
        quoi: "REFUSEE",
        abonnementId: vue.quoi === "INVALIDE" || vue.quoi === "INTROUVABLE" ? null : vue.abonnement.id,
        fournisseur: null,
        reference: null,
        detail: vue.quoi,
      });
      return autre;
    }

    // `selonVue` a rendu `null`, donc la vue est forcément « à régler ».
    const aRegler = vue as Extract<Vue, { quoi: "A_REGLER" }>;
    const lienJeton = `${base}/${jeton}`;

    if (sous === "etat") {
      return constater(requete, aRegler, lienJeton);
    }

    if (sous !== undefined) {
      return html(
        404,
        pageMessage(reglages, "Page introuvable", "Ce lien ne correspond à rien."),
      );
    }

    if (requete.methode.toUpperCase() === "POST") {
      return inviter(requete, aRegler, jeton, lienJeton);
    }

    raconter({
      quoi: "OUVERTE",
      abonnementId: aRegler.abonnement.id,
      fournisseur: null,
      reference: null,
    });

    return html(200, pageAReger(aRegler, reglages, lienJeton));
  };

  // ────────────────────────────────────────────────────────────── inviter ──

  async function inviter(
    requete: RequeteWeb,
    vue: Extract<Vue, { quoi: "A_REGLER" }>,
    jeton: string,
    lienJeton: string,
  ): Promise<ReponseWeb> {
    const champs = new URLSearchParams(requete.corps);
    const choix = fournisseurDe(reglages, champs.get("fournisseur") ?? undefined);

    if (choix === null) {
      return html(
        400,
        pageMessage(
          reglages,
          "Moyen de paiement inconnu",
          "Revenez en arrière et choisissez un moyen dans la liste.",
        ),
      );
    }

    // Le serveur revérifie ce que le formulaire bornait déjà. Un attribut HTML
    // n'est pas un contrôle : il évite la faute de frappe, il n'empêche rien.
    const montant = montantAccepte(
      Number.parseInt(champs.get("montant") ?? "", 10),
      vue.reste,
    );

    if (montant === null) {
      return html(
        400,
        pageMessage(
          reglages,
          "Montant refusé",
          `Le montant doit être compris entre 1 et ${vue.reste}. ` +
            "Revenez en arrière pour le corriger.",
        ),
      );
    }

    const telephone = (champs.get("telephone") ?? "").trim() || null;

    if (choix.telephone === true && telephone === null) {
      return html(
        400,
        pageMessage(
          reglages,
          "Numéro manquant",
          "Ce moyen de paiement a besoin de votre numéro mobile money.",
        ),
      );
    }

    const reference = referenceDeVersement(
      vue.abonnement.id,
      vue.abonnement.cycle.echeance,
      vue.versements,
    );

    const connues = await coordonneesDe(reglages, vue.abonnement);

    const retour = `${lienJeton}/etat?ref=${encodeURIComponent(reference)}&f=${encodeURIComponent(choix.nom)}`;

    try {
      const invitation = await choix.encaissement.inviter({
        reference,
        montant,
        devise: vue.abonnement.devise,
        libelle: vue.abonnement.libelle,
        abonne: {
          nom: connues?.nom ?? null,
          courriel: connues?.courriel ?? null,
          // Le numéro saisi l'emporte sur celui de la base : c'est celui du
          // téléphone que l'abonné a en main, maintenant.
          telephone: telephone ?? connues?.telephone ?? null,
        },
        retour,
      });

      raconter({
        quoi: "INVITEE",
        abonnementId: vue.abonnement.id,
        fournisseur: choix.nom,
        reference,
      });

      // Le fournisseur a une page : on y envoie l'abonné, et il reviendra sur
      // `retour`. Sinon, il a poussé la demande sur le téléphone, et c'est nous
      // qui attendons.
      if (invitation.url !== null) return versLa(invitation.url);

      return html(
        200,
        pageAttente(reglages, `${retour}&n=1`, invitation.instruction, true),
      );
    } catch (cause) {
      // Le message du fournisseur peut contenir un identifiant de compte ou une
      // partie de clé. Il va au journal, jamais à l'écran.
      raconter({
        quoi: "ERREUR",
        abonnementId: vue.abonnement.id,
        fournisseur: choix.nom,
        reference,
        detail:
          cause instanceof ErreurFournisseur
            ? `${cause.statut} ${cause.reponse.slice(0, 200)}`
            : undefined,
        cause,
      });

      return html(
        502,
        pageIssue(
          reglages,
          false,
          "Le paiement n'a pas pu être ouvert. Ce n'est pas de votre fait — " +
            "réessayez dans un instant.",
          lienJeton,
        ),
      );
    }
  }

  // ───────────────────────────────────────────────────────────── constater ──

  async function constater(
    requete: RequeteWeb,
    vue: Extract<Vue, { quoi: "A_REGLER" }>,
    lienJeton: string,
  ): Promise<ReponseWeb> {
    const reference = requete.parametres["ref"] ?? "";
    const choix = fournisseurDe(reglages, requete.parametres["f"]);

    // Le garde-fou qui rend cette route sûre. Sans lui, il suffirait de changer
    // `ref` pour faire constater — et compter — le paiement de quelqu'un
    // d'autre sur son propre abonnement.
    if (!referencePour(reference, vue.abonnement.id)) {
      raconter({
        quoi: "REFUSEE",
        abonnementId: vue.abonnement.id,
        fournisseur: choix?.nom ?? null,
        reference,
        detail: "référence étrangère",
      });

      return html(
        400,
        pageMessage(
          reglages,
          "Paiement introuvable",
          "Ce paiement ne correspond pas à cet abonnement.",
        ),
      );
    }

    if (choix === null) {
      return html(
        400,
        pageMessage(
          reglages,
          "Moyen de paiement inconnu",
          "Reprenez depuis le lien de votre rappel.",
        ),
      );
    }

    let issue: Issue;

    try {
      issue = await choix.encaissement.constater(reference);
    } catch (cause) {
      raconter({
        quoi: "ERREUR",
        abonnementId: vue.abonnement.id,
        fournisseur: choix.nom,
        reference,
        cause,
      });

      // On ne conclut pas à un échec : le fournisseur est injoignable, pas
      // l'abonné insolvable. La page continue d'attendre.
      return attendre(requete, lienJeton, reference, choix.nom, null);
    }

    raconter({
      quoi: "CONSTATEE",
      abonnementId: vue.abonnement.id,
      fournisseur: choix.nom,
      reference,
      detail: issue.etat,
    });

    if (issue.etat === "REUSSI") {
      // Ndank n'écrit pas : il appelle l'hôte, qui ouvre sa transaction. Le
      // crochet doit être idempotent — le webhook l'appellera aussi, pour le
      // même paiement.
      try {
        await reglages.surIssue?.(issue, vue.abonnement);
      } catch (cause) {
        raconter({
          quoi: "ERREUR",
          abonnementId: vue.abonnement.id,
          fournisseur: choix.nom,
          reference,
          detail: "surIssue a levé",
          cause,
        });
      }

      return html(
        200,
        pageIssue(
          reglages,
          true,
          "Votre paiement est arrivé. Votre accès est prolongé — si ce n'est " +
            "pas encore visible, laissez-lui une minute.",
          null,
        ),
      );
    }

    if (issue.etat === "ECHOUE" || issue.etat === "EXPIRE") {
      return html(
        200,
        pageIssue(
          reglages,
          false,
          issue.etat === "EXPIRE"
            ? "La demande a expiré avant que vous ne la validiez. Vous pouvez " +
                "en relancer une."
            : "Votre opérateur a refusé le paiement. Vérifiez votre solde, puis " +
                "réessayez.",
          lienJeton,
        ),
      );
    }

    // EN_ATTENTE, ou INCONNU. On ne conclut surtout pas à un échec sur un état
    // qu'on ne sait pas lire : cela couperait l'accès de quelqu'un qui a payé.
    return attendre(requete, lienJeton, reference, choix.nom, null);
  }

  function attendre(
    requete: RequeteWeb,
    lienJeton: string,
    reference: string,
    fournisseur: string,
    instruction: string | null,
  ): ReponseWeb {
    const n = Number.parseInt(requete.parametres["n"] ?? "1", 10);
    const tour = Number.isFinite(n) && n > 0 ? n : 1;

    const suivant =
      `${lienJeton}/etat?ref=${encodeURIComponent(reference)}` +
      `&f=${encodeURIComponent(fournisseur)}&n=${tour + 1}`;

    return html(
      200,
      pageAttente(reglages, suivant, instruction, tour < VERIFICATIONS_MAX),
    );
  }
}
