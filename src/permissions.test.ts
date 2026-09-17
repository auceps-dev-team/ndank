import { describe, expect, it } from "vitest";

import { ajouterJours } from "./cycle";
import type { Abonnement } from "./etats";
import {
  niveauDe,
  permissionsDe,
  peut,
  peutVoir,
  pourquoiPas,
  type Porteur,
  type ReglagesPermissions,
} from "./permissions";

const MAINTENANT = new Date("2026-09-15T10:00:00Z");

/** Un abonnement dont l'échéance tombe dans `dans` jours. */
function abonnement(dans: number, sur: Partial<Abonnement> = {}): Abonnement {
  const echeance = ajouterJours(MAINTENANT, dans);
  return {
    cycle: {
      debut: ajouterJours(echeance, -30),
      echeance,
      accesJusquA: ajouterJours(echeance, 7),
      repriseJusquA: ajouterJours(echeance, 37),
    },
    resilieeLe: null,
    suspenduLe: null,
    ...sur,
  };
}

const REGLAGES: ReglagesPermissions = {
  droits: {
    socle: ["lire", "publier"],
    option: ["exporter"],
  },
};

const porteur = (offreId: string, a: Abonnement, libelle?: string): Porteur =>
  libelle === undefined ? { offreId, abonnement: a } : { offreId, abonnement: a, libelle };

// ══════════════════════════════════════════════════════════════════════════

describe("le niveau d'un abonnement", () => {
  it("donne tout à un abonnement à jour", () => {
    expect(niveauDe(porteur("socle", abonnement(20)), REGLAGES, MAINTENANT)).toBe(
      "PLEIN",
    );
  });

  /**
   * C'est toute la raison d'être de la grâce : celui qui a passé le week-end
   * hors réseau ne perd rien pour deux jours de retard. Diminuer les droits ici
   * la viderait de son sens.
   */
  it("donne tout pendant la grâce, échéance dépassée comprise", () => {
    for (const dans of [3, 0, -3, -6]) {
      expect(
        niveauDe(porteur("socle", abonnement(dans)), REGLAGES, MAINTENANT),
      ).toBe("PLEIN");
    }
  });

  it("ne donne rien quand la grâce est épuisée, par défaut", () => {
    expect(niveauDe(porteur("socle", abonnement(-10)), REGLAGES, MAINTENANT)).toBe(
      "AUCUN",
    );
  });

  it("donne la lecture quand l'hôte l'a demandé", () => {
    expect(
      niveauDe(porteur("socle", abonnement(-10)), { ...REGLAGES, impaye: "LECTURE" }, MAINTENANT),
    ).toBe("LECTURE");
  });

  /**
   * `etatDe` rend `SUSPENDUE` dans les deux cas — le marchand a suspendu, ou la
   * grâce est épuisée. Le mot est le même, la situation non : l'un est une
   * sanction, l'autre un retard de paiement.
   *
   * Ce test est la raison d'être des deux réglages séparés.
   */
  it("ne confond pas une suspension du marchand avec un impayé", () => {
    const suspendu = abonnement(20, { suspenduLe: ajouterJours(MAINTENANT, -2) });
    const impaye = abonnement(-10);

    const genereux: ReglagesPermissions = { ...REGLAGES, impaye: "LECTURE" };

    // Le même réglage généreux ouvre la lecture à l'impayé et pas au suspendu.
    expect(niveauDe(porteur("socle", impaye), genereux, MAINTENANT)).toBe("LECTURE");
    expect(niveauDe(porteur("socle", suspendu), genereux, MAINTENANT)).toBe("AUCUN");
  });

  it("laisse tout de même l'hôte adoucir une suspension s'il le veut", () => {
    const suspendu = abonnement(20, { suspenduLe: ajouterJours(MAINTENANT, -2) });
    expect(
      niveauDe(porteur("socle", suspendu), { ...REGLAGES, suspendu: "LECTURE" }, MAINTENANT),
    ).toBe("LECTURE");
  });

  /**
   * Un abonné qui résilie le 3 a payé jusqu'au 30. Lui couper le service à
   * l'instant du clic, c'est garder son argent et lui retirer ce qu'il a acheté.
   * `accesOuvert` a dû apprendre cette règle en 0.12 ; elle vaut ici aussi.
   */
  it("garde les droits pleins d'un résilié qui a payé d'avance", () => {
    const resilie = abonnement(20, { resilieeLe: ajouterJours(MAINTENANT, -1) });
    expect(niveauDe(porteur("socle", resilie), REGLAGES, MAINTENANT)).toBe("PLEIN");
  });

  it("mais plus rien une fois l'accès payé terminé", () => {
    const resilie = abonnement(-20, { resilieeLe: ajouterJours(MAINTENANT, -25) });
    expect(niveauDe(porteur("socle", resilie), REGLAGES, MAINTENANT)).toBe("AUCUN");
  });

  it("ne donne rien sur un abonnement expiré", () => {
    expect(niveauDe(porteur("socle", abonnement(-50)), REGLAGES, MAINTENANT)).toBe(
      "AUCUN",
    );
  });
});

describe("les droits, plusieurs abonnements réunis", () => {
  it("additionne ce que chaque abonnement donne", () => {
    const v = permissionsDe(
      [porteur("socle", abonnement(20)), porteur("option", abonnement(20))],
      REGLAGES,
      MAINTENANT,
    );

    expect(v.niveau).toBe("PLEIN");
    expect(v.droits).toEqual(["exporter", "lire", "publier"]);
    expect(v.motif).toBeNull();
  });

  /**
   * Ne garder que le « meilleur » abonnement retirerait à l'abonné ce que
   * l'autre lui donne — quelqu'un peut tenir un socle à jour et une option en
   * retard.
   */
  it("garde les droits de l'abonnement à jour quand l'autre est en retard", () => {
    const v = permissionsDe(
      [porteur("socle", abonnement(20)), porteur("option", abonnement(-10))],
      REGLAGES,
      MAINTENANT,
    );

    expect(v.niveau).toBe("PLEIN");
    expect(v.droits).toEqual(["lire", "publier"]);
    expect(v.droits).not.toContain("exporter");
  });

  it("retient le mieux-disant quand un droit est donné deux fois", () => {
    const deuxFois: ReglagesPermissions = {
      droits: { socle: ["lire"], autre: ["lire"] },
      impaye: "LECTURE",
    };

    const v = permissionsDe(
      [porteur("socle", abonnement(-10)), porteur("autre", abonnement(20))],
      deuxFois,
      MAINTENANT,
    );

    expect(peut(v, "lire")).toBe(true);
  });

  /**
   * Ajouter un palier à la grille sans lui donner de droits doit produire un
   * abonné qui ne peut rien — pas un abonné qui peut tout.
   */
  it("ne donne rien pour une offre absente de la table", () => {
    const v = permissionsDe(
      [porteur("palier-tout-neuf", abonnement(20))],
      REGLAGES,
      MAINTENANT,
    );

    expect(v.droits).toEqual([]);
    expect(v.niveau).toBe("PLEIN");

    // Le trou que ce test laissait passer : il vérifiait `droits` et `niveau`,
    // jamais ce qu'on avait à dire à l'abonné.
    expect(pourquoiPas(v, "publier", REGLAGES)).not.toBeNull();
  });

  it("rend AUCUN et le dit quand il n'y a aucun abonnement", () => {
    const v = permissionsDe([], REGLAGES, MAINTENANT);

    expect(v.niveau).toBe("AUCUN");
    expect(v.droits).toEqual([]);
    expect(v.motif).toMatch(/aucun abonnement/i);
    expect(v.offreId).toBeNull();
  });
});

describe("peut et peutVoir", () => {
  it("un droit plein est aussi un droit en lecture", () => {
    const v = permissionsDe([porteur("socle", abonnement(20))], REGLAGES, MAINTENANT);

    expect(peut(v, "publier")).toBe(true);
    expect(peutVoir(v, "publier")).toBe(true);
  });

  it("un droit en lecture n'autorise pas à écrire", () => {
    const v = permissionsDe(
      [porteur("socle", abonnement(-10))],
      { ...REGLAGES, impaye: "LECTURE" },
      MAINTENANT,
    );

    expect(peut(v, "publier")).toBe(false);
    expect(peutVoir(v, "publier")).toBe(true);
  });

  it("un droit qu'on n'a pas reste faux dans les deux sens", () => {
    const v = permissionsDe([porteur("socle", abonnement(20))], REGLAGES, MAINTENANT);

    expect(peut(v, "exporter")).toBe(false);
    expect(peutVoir(v, "exporter")).toBe(false);
  });
});

/**
 * « Accès refusé » est la phrase qui fait écrire au support : l'abonné ne sait
 * pas s'il a oublié de payer, s'il est suspendu, ou si le service est en panne.
 * Chaque motif doit donc porter un geste ou une date.
 */
describe("le motif", () => {
  it("nomme l'offre quand l'hôte la donne", () => {
    const v = permissionsDe(
      [porteur("socle", abonnement(-10), "Pass Créateur")],
      REGLAGES,
      MAINTENANT,
    );

    expect(v.motif).toContain("Pass Créateur");
  });

  it("dit depuis quand, et que payer suffit", () => {
    const v = permissionsDe([porteur("socle", abonnement(-10))], REGLAGES, MAINTENANT);

    expect(v.motif).toMatch(/depuis 10 jours/);
    expect(v.motif).toMatch(/paiement rouvre/i);
  });

  /**
   * Le cas se trouve sur une suspension, et non sur un impayé : la grâce dure
   * sept jours, donc au moment où un impayé mord, l'échéance a au moins huit
   * jours. « À renouveler depuis hier » est inatteignable par construction.
   */
  it("dit « depuis hier » plutôt que « depuis 1 jours »", () => {
    const hier = abonnement(20, { suspenduLe: ajouterJours(MAINTENANT, -1) });
    const v = permissionsDe([porteur("socle", hier)], REGLAGES, MAINTENANT);
    expect(v.motif).toMatch(/depuis hier/);
  });

  it("dit « aujourd'hui » quand c'est arrivé le jour même", () => {
    const cejour = abonnement(20, { suspenduLe: MAINTENANT });
    const v = permissionsDe([porteur("socle", cejour)], REGLAGES, MAINTENANT);
    expect(v.motif).toMatch(/aujourd'hui/);
  });

  it("renvoie une suspension vers le service client, et non vers un paiement", () => {
    const suspendu = abonnement(20, { suspenduLe: ajouterJours(MAINTENANT, -2) });
    const v = permissionsDe([porteur("socle", suspendu)], REGLAGES, MAINTENANT);

    expect(v.motif).toMatch(/suspendu/i);
    expect(v.motif).toMatch(/service client/i);
    expect(v.motif).not.toMatch(/paiement rouvre/i);
  });

  it("dit qu'un abonnement expiré demande de souscrire à nouveau", () => {
    const v = permissionsDe([porteur("socle", abonnement(-50))], REGLAGES, MAINTENANT);

    expect(v.motif).toMatch(/expiré/i);
    expect(v.motif).toMatch(/souscrire à nouveau/i);
  });

  it("ne dit rien quand tout va bien", () => {
    const v = permissionsDe([porteur("socle", abonnement(20))], REGLAGES, MAINTENANT);
    expect(v.motif).toBeNull();
  });

  /**
   * Un abonné qui a un abonnement à jour et un autre en retard ne doit pas voir
   * un message d'alarme : il a bien accès. Le motif reste pourtant, pour que
   * l'écran puisse signaler ce qui manque.
   */
  it("reste présent quand un abonnement sur deux est en retard", () => {
    const v = permissionsDe(
      [porteur("socle", abonnement(20)), porteur("option", abonnement(-10), "Option Pro")],
      REGLAGES,
      MAINTENANT,
    );

    expect(v.niveau).toBe("PLEIN");
    expect(v.motif).toContain("Option Pro");
  });
});

/**
 * `motif` explique pourquoi l'accès est diminué ; `peut()` répond par droit. Les
 * deux questions ne coïncident pas, et c'est par là que le mur revenait.
 */
describe("pourquoiPas", () => {
  it("ne dit rien quand le droit est accordé", () => {
    const v = permissionsDe([porteur("socle", abonnement(20))], REGLAGES, MAINTENANT);
    expect(pourquoiPas(v, "publier", REGLAGES)).toBeNull();
  });

  /**
   * Le cas qui manquait. Un abonné parfaitement à jour, à qui l'on demande un
   * droit que son palier ne comprend pas, recevait `false` et rien à lui dire.
   */
  it("nomme l'offre qui donnerait le droit, plutôt que de se taire", () => {
    const v = permissionsDe([porteur("socle", abonnement(20))], REGLAGES, MAINTENANT);

    expect(peut(v, "exporter")).toBe(false);
    expect(v.motif).toBeNull();

    const dit = pourquoiPas(v, "exporter", REGLAGES);
    expect(dit).toMatch(/ne comprend pas/i);
    expect(dit).toContain("option");
  });

  /**
   * Dire « renouvelez » à quelqu'un dont le palier ne comprend pas la
   * fonctionnalité l'enverrait payer pour rien.
   */
  it("ne renvoie pas vers un paiement quand c'est le palier qui manque", () => {
    const v = permissionsDe(
      [porteur("socle", abonnement(20)), porteur("autre", abonnement(-10))],
      { droits: { socle: ["lire"], autre: ["publier"], option: ["exporter"] } },
      MAINTENANT,
    );

    expect(pourquoiPas(v, "exporter", { droits: REGLAGES.droits })).not.toMatch(
      /renouveler/i,
    );
  });

  it("renvoie vers le paiement quand l'offre détenue donnerait le droit", () => {
    const v = permissionsDe([porteur("socle", abonnement(-10))], REGLAGES, MAINTENANT);

    expect(pourquoiPas(v, "publier", REGLAGES)).toMatch(/renouveler/i);
  });

  it("distingue « consultable » de « refusé »", () => {
    const v = permissionsDe(
      [porteur("socle", abonnement(-10))],
      { ...REGLAGES, impaye: "LECTURE" },
      MAINTENANT,
    );

    expect(pourquoiPas(v, "publier", REGLAGES)).toMatch(/consulter, pas modifier/i);
  });

  /**
   * La phrase qui vivait dans `motifDe` et n'y était jamais atteinte. Elle se
   * déclenche ici : aucune offre, détenue ou non, ne donne ce droit.
   */
  it("le dit aussi quand aucune offre ne donne ce droit", () => {
    const v = permissionsDe([porteur("socle", abonnement(20))], REGLAGES, MAINTENANT);

    expect(pourquoiPas(v, "droit-qui-n-existe-pas", REGLAGES)).toMatch(
      /ne donne pas accès/i,
    );
  });
});

/**
 * Résilier est une décision, laisser expirer est un oubli — la même distinction
 * qui a justifié de séparer `impaye` de `suspendu`.
 */
describe("résilier n'est pas expirer", () => {
  it("emploie `resilie` et non `expire` pour un résilié dont l'accès est fini", () => {
    const resilie = abonnement(-20, { resilieeLe: ajouterJours(MAINTENANT, -25) });

    expect(
      niveauDe(porteur("socle", resilie), { ...REGLAGES, resilie: "LECTURE" }, MAINTENANT),
    ).toBe("LECTURE");

    // `expire` ne doit pas décider à sa place.
    expect(
      niveauDe(porteur("socle", resilie), { ...REGLAGES, expire: "LECTURE" }, MAINTENANT),
    ).toBe("AUCUN");
  });
});

describe("rien n'est stocké", () => {
  /**
   * Le même abonnement, la même table de droits, deux instants : deux réponses.
   * C'est la règle de `etatDe`, et elle vaut ici — une colonne `droits` en base
   * serait fausse le lendemain matin, sans que personne ne le voie.
   */
  it("la même question à deux dates ne donne pas la même réponse", () => {
    const p = [porteur("socle", abonnement(2))];

    expect(permissionsDe(p, REGLAGES, MAINTENANT).niveau).toBe("PLEIN");
    expect(
      permissionsDe(p, REGLAGES, ajouterJours(MAINTENANT, 30)).niveau,
    ).toBe("AUCUN");
  });
});
