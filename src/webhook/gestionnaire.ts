import {
  SignatureInvalide,
  type Encaissement,
  type Issue,
} from "../encaissement/port";
import { lireReference } from "../encaissement/reconciliation";
import type { AbonnementLu } from "../ports";
import type { DossierAbonnement, SurIssue } from "../dossier";
import type { ReponseWeb, RequeteWeb } from "../web";

/**
 * Ndank — recevoir ce que le fournisseur envoie.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * C'EST LE SEUL ENDROIT OÙ QUELQU'UN D'AUTRE NOUS PARLE
 *
 * Tout le reste part de chez nous : on appelle un fournisseur, on lit sa
 * réponse. Ici, c'est l'inverse — n'importe qui sur Internet peut poster sur
 * cette adresse, et ce que le corps raconte, c'est qu'un abonnement vient
 * d'être payé.
 *
 * D'où la vérification de signature, qui n'est pas une option et qui vit dans
 * l'adaptateur du fournisseur, sur le corps **brut**.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE CODE DE RÉPONSE EST UNE INSTRUCTION, PAS UN COMPTE RENDU
 *
 * C'est la chose à comprendre avant de toucher à ce fichier. Les fournisseurs
 * rejouent : Paystack toutes les trois minutes puis chaque heure pendant
 * soixante-douze heures, Flutterwave trois fois à trente minutes d'intervalle.
 * Ce qui déclenche le rejeu, c'est le code qu'on rend.
 *
 *   — **200** : « c'est réglé, n'y revenez pas. » On le rend aussi bien pour un
 *     paiement traité que pour un événement qui ne nous concerne pas ;
 *   — **500** : « réessayez. » Réservé aux pannes de notre côté — la base est
 *     tombée, le crochet a levé. C'est le seul cas où le rejeu nous sauve, et
 *     s'en priver perdrait le paiement ;
 *   — **401** : « ce n'est pas vous. » Signature invalide. Le vrai fournisseur
 *     ne verra jamais ce code, donc il n'a rien à rejouer.
 *
 * Rendre 200 sur une panne perd le paiement pour de bon. Rendre 500 sur un
 * événement qu'on ignore fait rejouer le fournisseur pendant trois jours, puis
 * le fait désactiver le point de terminaison.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * LE CORPS DOIT ÊTRE BRUT, ET C'EST LE PIÈGE LE PLUS COURANT
 *
 * La signature porte sur les octets envoyés. `JSON.parse` puis `JSON.stringify`
 * rend un texte différent — ordre des clés, espaces, notation des nombres — et
 * la signature ne correspond plus.
 *
 * La plupart des cadres applicatifs relisent le corps avant que le code de
 * l'hôte ne le voie. Avec Express, il faut
 * `express.raw({ type: "*∕*" })` sur cette route **et pas** `express.json()`.
 * Les adaptateurs de `montage.ts` passent le corps brut ; c'est le montage
 * maison qu'il faut surveiller.
 */

/** Ce que le gestionnaire raconte à l'hôte. */
export interface FaitWebhook {
  quoi:
    | "RECU"
    | "IGNORE"
    | "SIGNATURE"
    | "ETRANGER"
    | "INTROUVABLE"
    | "TRAITE"
    | "ERREUR";
  fournisseur: string;
  reference: string | null;
  abonnementId: string | null;
  detail?: string;
  cause?: unknown;

  /**
   * Le corps brut, sur le fait **terminal** d'une requête.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * IL EST LÀ POUR QU'ON PUISSE LE CONSERVER
   *
   * Le schéma porte une table `WebhookRecu` depuis la 0.4.0 : corps, signature
   * valide ou non, référence, issue. Elle n'a jamais été écrite une seule fois,
   * parce que rien ne faisait sortir le corps du gestionnaire.
   *
   * C'est pourtant la seule chose qui permette de comprendre après coup. Le
   * jour où un opérateur change un code sans prévenir, `Issue.brut` ne suffit
   * pas : il faut ce que la requête disait, avant qu'on ne l'interprète.
   *
   * Absent sur `RECU`, qui est émis **avant** qu'on sache si la signature vaut
   * quelque chose — et `WebhookRecu.signatureValide` n'accepte pas de doute.
   */
  corps?: string;

  /** Ce qu'on a conclu de la signature. Absent sur `RECU`, pour la même raison. */
  signatureValide?: boolean;
}

export interface ReglagesWebhook {
  /** Les adaptateurs, par le nom qui apparaît dans le chemin. */
  fournisseurs: Readonly<Record<string, Encaissement>>;

  dossier: DossierAbonnement;

  /**
   * Ce que l'hôte fait d'un paiement constaté.
   *
   * Le même crochet que celui de la page, et ce n'est pas un hasard : les deux
   * chemins concluent, souvent pour le même paiement. `Creances.dejaCompte`
   * est ce qui rend le doublon inoffensif.
   *
   * S'il lève, on rend 500 — donc le fournisseur rejouera. C'est voulu : une
   * base momentanément indisponible ne doit pas faire disparaître un paiement.
   */
  surIssue?: SurIssue;

  journal?: (fait: FaitWebhook) => void;
}

function reponse(statut: number, message: string): ReponseWeb {
  return {
    statut,
    entetes: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    corps: JSON.stringify({ message }),
  };
}

/**
 * Fabrique le gestionnaire.
 *
 * Le chemin porte le nom du fournisseur : `/flutterwave`, `/paystack`. Un seul
 * point de montage sert donc tous les fournisseurs, et l'hôte n'a qu'une route
 * à déclarer — ce qui compte, parce que chaque fournisseur veut son adresse et
 * qu'on les configure une fois pour toutes dans son tableau de bord.
 */
export function gestionnaireWebhook(
  reglages: ReglagesWebhook,
): (requete: RequeteWeb) => Promise<ReponseWeb> {
  const raconter = (fait: FaitWebhook): void => {
    try {
      reglages.journal?.(fait);
    } catch {
      /* le journal observe, il ne participe pas */
    }
  };

  return async function recevoir(requete: RequeteWeb): Promise<ReponseWeb> {
    const nom = requete.chemin.split("/").filter((m) => m !== "")[0] ?? "";
    const fournisseur = reglages.fournisseurs[nom];

    if (fournisseur === undefined) {
      // 404 et non 500 : ce n'est pas une panne, et il n'y a rien à rejouer.
      return reponse(404, "Fournisseur inconnu.");
    }

    if (requete.methode.toUpperCase() !== "POST") {
      return reponse(405, "Méthode non autorisée.");
    }

    raconter({ quoi: "RECU", fournisseur: nom, reference: null, abonnementId: null });

    let issue: Issue | null;

    try {
      issue = fournisseur.lireWebhook(requete.corps, requete.entetes);
    } catch (cause) {
      if (cause instanceof SignatureInvalide) {
        raconter({
          quoi: "SIGNATURE",
          fournisseur: nom,
          reference: null,
          abonnementId: null,
          corps: requete.corps,
          signatureValide: false,
          cause,
        });

        // Le vrai fournisseur ne verra jamais ce code : sa signature est bonne.
        // Celui qui le voit n'a rien à rejouer.
        return reponse(401, "Signature invalide.");
      }

      // Un corps illisible n'est pas une panne de notre côté. Le rejeu ne
      // changerait rien, et trois jours de rejeu finiraient par faire
      // désactiver le point de terminaison.
      raconter({
        quoi: "ERREUR",
        fournisseur: nom,
        reference: null,
        abonnementId: null,
        detail: "corps illisible",
        corps: requete.corps,
        signatureValide: true,
        cause,
      });

      return reponse(200, "Événement illisible, ignoré.");
    }

    // Les fournisseurs émettent bien d'autres événements que des paiements —
    // remboursements, virements, changements d'abonnement. Les ignorer poliment
    // vaut mieux que de lever.
    if (issue === null) {
      raconter({
        quoi: "IGNORE",
        fournisseur: nom,
        reference: null,
        abonnementId: null,
        corps: requete.corps,
        signatureValide: true,
      });

      return reponse(200, "Événement sans objet ici.");
    }

    const lue = lireReference(issue.reference);

    if (lue === null) {
      // Une référence qui n'a pas notre forme : un autre système poste sur la
      // même adresse, ou le marchand encaisse aussi en dehors de Ndank. On
      // n'invente rien, et on ne fait pas rejouer.
      raconter({
        quoi: "ETRANGER",
        fournisseur: nom,
        reference: issue.reference,
        abonnementId: null,
        corps: requete.corps,
        signatureValide: true,
      });

      return reponse(200, "Référence étrangère, ignorée.");
    }

    let abonnement: AbonnementLu | null;

    try {
      abonnement = await reglages.dossier.abonnement(lue.abonnement);
    } catch (cause) {
      // Là, en revanche, c'est notre panne. On veut le rejeu.
      raconter({
        quoi: "ERREUR",
        fournisseur: nom,
        reference: issue.reference,
        abonnementId: lue.abonnement,
        detail: "lecture impossible",
        corps: requete.corps,
        signatureValide: true,
        cause,
      });

      return reponse(500, "Lecture impossible, réessayez.");
    }

    if (abonnement === null) {
      // L'abonnement a disparu. Rejouer n'y changera rien, mais c'est un
      // paiement réel sur un dossier qu'on ne retrouve pas : cela mérite le
      // journal, et l'attention de quelqu'un.
      raconter({
        quoi: "INTROUVABLE",
        fournisseur: nom,
        reference: issue.reference,
        abonnementId: lue.abonnement,
        corps: requete.corps,
        signatureValide: true,
      });

      return reponse(200, "Abonnement introuvable.");
    }

    try {
      await reglages.surIssue?.(issue, abonnement);
    } catch (cause) {
      raconter({
        quoi: "ERREUR",
        fournisseur: nom,
        reference: issue.reference,
        abonnementId: abonnement.id,
        detail: "surIssue a levé",
        corps: requete.corps,
        signatureValide: true,
        cause,
      });

      // Le seul cas où le rejeu nous sauve. S'en priver perdrait le paiement.
      return reponse(500, "Traitement impossible, réessayez.");
    }

    raconter({
      quoi: "TRAITE",
      fournisseur: nom,
      reference: issue.reference,
      abonnementId: abonnement.id,
      corps: requete.corps,
      signatureValide: true,
      detail: issue.etat,
    });

    return reponse(200, "Reçu.");
  };
}
