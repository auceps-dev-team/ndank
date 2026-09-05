import { jour } from "../cycle";
import type { Remise, Transporteur } from "./port";

/**
 * Ndank — envoyer moins vite, pour continuer à envoyer.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * CE QU'IL FAUT PROTÉGER N'EST PAS LE MÊME SELON LA PASSERELLE
 *
 * Deux hôtes ont le même besoin pour deux raisons opposées.
 *
 * Celui qui passe par une **SIM** protège sa carte. Cinq cents messages
 * identiques envoyés en trois minutes ressemblent, vue du réseau, à ce que les
 * opérateurs de la zone combattent activement — et une SIM suspendue arrête
 * l'échelle entière, sans préavis et sans recours rapide.
 *
 * Celui qui passe par **Twilio** protège sa facture. Une boucle qui part de
 * travers — un bug de sélection, un passage rejoué — se compte en euros avant
 * que quiconque ne s'en aperçoive.
 *
 * D'où un décorateur, et non une option de l'adaptateur Android : le besoin
 * n'appartient à aucune passerelle en particulier.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ESPACER PLUTÔT QUE REFUSER, ET REFUSER QUAND MÊME AU BOUT
 *
 * Deux mécanismes, et ils ne servent pas à la même chose.
 *
 * **L'espacement** est la vraie protection. Il fait attendre entre deux envois,
 * ce qui ralentit le passage sans rien perdre : cinq cents relances à six
 * secondes d'intervalle prennent cinquante minutes, ce qui est sans importance
 * pour une tâche nocturne et change tout pour la carte SIM.
 *
 * **Le plafond** est un garde-fou, pas un régulateur. Au-delà, on refuse. C'est
 * ce qui empêche une boucle folle de vider un forfait ou de faire suspendre une
 * ligne, et c'est censé ne jamais se déclencher.
 *
 * On aurait pu ne garder que le plafond. Ce serait pire : les cinq cents
 * premiers messages partiraient en rafale, la SIM serait signalée dès le
 * premier soir, et le plafond n'aurait rien empêché du tout.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * UN REFUS N'EST PAS UNE PERTE, ET C'EST CE QUI REND CECI ACCEPTABLE
 *
 * Quand le plafond est atteint, le transporteur rend `parti: false`. Le moteur
 * essaie alors le barreau suivant du palier, et **ne note pas la relance**.
 *
 * Elle repartira donc au passage du lendemain, d'elle-même. Rien n'est perdu :
 * c'est le même chemin qu'un abonné momentanément injoignable, que Ndank sait
 * déjà traiter.
 *
 * Une réserve honnête, tout de même : l'ordre du lot ne change pas d'un jour à
 * l'autre. Si le plafond est atteint tous les jours, ce sont toujours les mêmes
 * abonnés de fin de liste qui ne reçoivent rien. Un plafond qui mord tous les
 * jours n'est donc pas un réglage, c'est un signal qu'il faut une seconde SIM
 * ou une vraie passerelle — et `surRefus` est là pour qu'on l'apprenne.
 */

export interface ReglagesLimite {
  /**
   * Combien de messages par minute, au plus.
   *
   * Dix par défaut, soit six secondes entre deux envois. C'est lent pour une
   * machine et rapide pour quelqu'un qui tape sur un clavier de téléphone —
   * ce qui est exactement l'apparence recherchée.
   */
  parMinute?: number;

  /**
   * Le plafond par jour civil. Aucun par défaut.
   *
   * Il n'y a pas de valeur raisonnable universelle : elle dépend du forfait, de
   * l'opérateur et du pays. En poser une d'office donnerait une fausse
   * sécurité à qui ne l'a pas choisie.
   */
  parJour?: number;

  /**
   * De combien faire varier l'attente, en proportion.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * UNE CADENCE PARFAITE EST ELLE-MÊME UNE SIGNATURE
   *
   * Un message exactement toutes les six secondes ne ressemble à rien
   * d'humain. Le hasard sur l'intervalle coûte zéro et retire ce motif.
   *
   * `0.3` par défaut : entre 4,2 et 7,8 secondes pour un espacement de six.
   */
  hasard?: number;

  /** Appelé quand le plafond refuse un envoi. Pour le journal, ou l'alerte. */
  surRefus?: (fait: { envoyesAujourdhui: number; plafond: number }) => void;

  /** L'horloge. Injectable pour que les tests ne durent pas une minute. */
  maintenant?: () => Date;
  /** L'attente. Injectable pour la même raison. */
  attendre?: (millisecondes: number) => Promise<void>;
}

const dormir = (ms: number): Promise<void> =>
  new Promise((resoudre) => setTimeout(resoudre, ms));

/**
 * Enveloppe un transporteur d'une limite de débit et d'un plafond.
 *
 * ```ts
 * const sms = limiter(
 *   transporteurSms("passerelle-android", process.env),
 *   { parMinute: 10, parJour: 300 },
 * );
 * ```
 *
 * Le transporteur rendu se substitue à l'autre partout : même nom, même canal,
 * même `disponible`. Rien en aval ne sait qu'il est limité.
 */
export function limiter<C>(
  transporteur: Transporteur<C>,
  reglages: ReglagesLimite = {},
): Transporteur<C> {
  const parMinute = reglages.parMinute ?? 10;
  const hasard = reglages.hasard ?? 0.3;
  const horloge = reglages.maintenant ?? (() => new Date());
  const patienter = reglages.attendre ?? dormir;

  const espacement = parMinute > 0 ? 60_000 / parMinute : 0;

  let dernierEnvoi = 0;
  let jourCompte: number | null = null;
  let envoyes = 0;

  return {
    nom: transporteur.nom,
    canal: transporteur.canal,

    // Recopié tel quel : un transporteur qui refuse un numéro mal formé doit
    // continuer à le refuser, et sans consommer de quota pour cela.
    ...(transporteur.disponible
      ? { disponible: transporteur.disponible.bind(transporteur) }
      : {}),

    async envoyer(ou, contenu): Promise<Remise> {
      const maintenant = horloge();

      // ── le plafond du jour ────────────────────────────────────────────────
      //
      // Le compteur suit le jour **civil UTC**, comme tout le reste du dépôt.
      // La journée de facturation d'un opérateur peut commencer ailleurs ; le
      // plafond est un garde-fou, pas une comptabilité, et cet écart ne change
      // rien à ce qu'il protège.
      const aujourdhui = jour(maintenant).getTime();
      if (jourCompte !== aujourdhui) {
        jourCompte = aujourdhui;
        envoyes = 0;
      }

      if (reglages.parJour !== undefined && envoyes >= reglages.parJour) {
        reglages.surRefus?.({
          envoyesAujourdhui: envoyes,
          plafond: reglages.parJour,
        });

        // Et non une exception : le moteur doit pouvoir essayer le barreau
        // suivant, et la relance ne doit pas être notée. Elle repartira demain.
        return { parti: false, reference: null };
      }

      // ── l'espacement ──────────────────────────────────────────────────────
      if (espacement > 0 && dernierEnvoi > 0) {
        const ecoule = maintenant.getTime() - dernierEnvoi;
        const voulu = espacement * (1 + (Math.random() * 2 - 1) * hasard);

        if (ecoule < voulu) await patienter(Math.ceil(voulu - ecoule));
      }

      const remise = await transporteur.envoyer(ou, contenu);

      // On date même un envoi refusé par la passerelle : l'appel a eu lieu, et
      // c'est le rythme des appels que l'opérateur observe, pas leur succès.
      dernierEnvoi = horloge().getTime();

      // On ne compte, en revanche, que ce qui est parti. Un plafond entamé par
      // des échecs se refermerait sur des messages jamais émis.
      if (remise.parti) envoyes += 1;

      return remise;
    },
  };
}
