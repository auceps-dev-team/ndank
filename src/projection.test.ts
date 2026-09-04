import { describe, expect, it } from "vitest";

import type { Http, Requete } from "./http";
import {
  aProjeter,
  empreinte,
  pousser,
  projectionDe,
  type Projection,
} from "./projection";

const POIVRE = "un-poivre-partage-par-tous-les-hotes";

function ligne(sur: Partial<Projection> = {}): Projection {
  return {
    reference: "abo-1",
    empreinte: empreinte("+2250700000000", POIVRE),
    site: "Baobart",
    offre: "Pass Créateur",
    montant: 2000,
    devise: "XOF",
    cadence: "MENSUEL",
    debut: "2026-01-10T00:00:00.000Z",
    echeance: "2026-02-09T00:00:00.000Z",
    accesJusquA: "2026-02-16T00:00:00.000Z",
    repriseJusquA: "2026-03-18T00:00:00.000Z",
    resilieeLe: null,
    suspenduLe: null,
    lien: "https://p.baobart.ci/v/abc.def.ghi",
    ...sur,
  };
}

function fausseHttp(statuts: number[] = []) {
  const requetes: Requete[] = [];
  let i = 0;

  const http: Http = async (requete) => {
    requetes.push(requete);
    return { statut: statuts[i++] ?? 200, corps: "{}" };
  };

  return { http, requetes };
}

describe("l'empreinte d'un abonné", () => {
  it("recolle deux hôtes qui écrivent le numéro autrement", () => {
    // Sans normalisation, « 07 00 00 00 00 » chez l'un et « +2250700000000 »
    // chez l'autre donneraient deux empreintes — et la vue multi-sites ne
    // recollerait rien, ce qui est précisément sa raison d'être.
    expect(empreinte("+225 07 00 00 00 00", POIVRE)).toBe(
      empreinte("+2250700000000", POIVRE),
    );
  });

  it("change avec le poivre, donc le poivre doit être le même partout", () => {
    expect(empreinte("+2250700000000", "a")).not.toBe(
      empreinte("+2250700000000", "b"),
    );
  });

  it("ne rend pas le numéro lisible, sans prétendre l'anonymiser", () => {
    // Ce n'est pas de l'anonymisation : un numéro vit dans un espace minuscule,
    // et quiconque tient le poivre en dresse la table complète. Ce que
    // l'empreinte fait, c'est qu'une copie de base prise sans le poivre ne
    // livre pas un annuaire.
    const e = empreinte("+2250700000000", POIVRE);

    expect(e).not.toContain("2250700000000");
    expect(e).not.toContain("0700000000");
  });
});

describe("pousser une projection", () => {
  it("envoie par lots, et non une ligne à la fois", async () => {
    const f = fausseHttp();
    const lignes = Array.from({ length: 250 }, (_, i) =>
      ligne({ reference: `abo-${i}` }),
    );

    const bilan = await pousser(lignes, {
      base: "https://app.ndank.test",
      jeton: "jeton",
      poivre: POIVRE,
      site: "Baobart",
      http: f.http,
    });

    expect(bilan.lots).toBe(3);
    expect(bilan.envoyees).toBe(250);
    expect(f.requetes).toHaveLength(3);
  });

  it("n'emporte pas les autres lots quand l'un échoue", async () => {
    // Une projection n'est pas une transaction. Si le deuxième lot sur trois
    // échoue, les deux autres sont à jour — ce qui vaut infiniment mieux que
    // rien, puisque la poussée suivante rattrapera.
    const f = fausseHttp([200, 500, 200]);
    const lignes = Array.from({ length: 250 }, (_, i) =>
      ligne({ reference: `abo-${i}` }),
    );

    const bilan = await pousser(lignes, {
      base: "https://app.ndank.test",
      jeton: "jeton",
      poivre: POIVRE,
      site: "Baobart",
      http: f.http,
    });

    expect(bilan.echecs).toHaveLength(1);
    expect(bilan.echecs[0]!.lot).toBe(2);
    expect(bilan.envoyees).toBe(150);
  });

  it("n'envoie aucun état, seulement des dates", async () => {
    // `etatDe` est la seule autorité sur ce qu'est un abonnement « suspendu ».
    // Envoyer un état calculé chez l'hôte ferait qu'un abonné verrait « à
    // jour » chez lui et « suspendu » chez le marchand, selon la fraîcheur de
    // la dernière poussée.
    const f = fausseHttp();

    await pousser([ligne()], {
      base: "https://app.ndank.test",
      jeton: "jeton",
      poivre: POIVRE,
      site: "Baobart",
      http: f.http,
    });

    const envoye = JSON.parse(f.requetes[0]!.corps!) as {
      lignes: Record<string, unknown>[];
    };

    expect(envoye.lignes[0]!["etat"]).toBeUndefined();
    expect(envoye.lignes[0]!["echeance"]).toBe("2026-02-09T00:00:00.000Z");
    expect(envoye.lignes[0]!["repriseJusquA"]).toBe("2026-03-18T00:00:00.000Z");
  });

  it("n'envoie ni nom, ni numéro, ni adresse", async () => {
    const f = fausseHttp();

    await pousser([ligne()], {
      base: "https://app.ndank.test",
      jeton: "jeton",
      poivre: POIVRE,
      site: "Baobart",
      http: f.http,
    });

    const corps = f.requetes[0]!.corps!;

    expect(corps).not.toContain("2250700000000");
    expect(corps).not.toContain("@");
    expect(corps).not.toContain("nom");
  });

  it("porte le jeton du projet, jamais celui du tableau de bord", async () => {
    const f = fausseHttp();

    await pousser([ligne()], {
      base: "https://app.ndank.test/",
      jeton: "jeton-de-projection",
      poivre: POIVRE,
      site: "Baobart",
      http: f.http,
    });

    expect(f.requetes[0]!.entetes["Authorization"]).toBe("Bearer jeton-de-projection");
    // La barre finale ne double pas.
    expect(f.requetes[0]!.url).toBe("https://app.ndank.test/projection");
  });

  it("ne fait rien quand il n'y a rien à pousser", async () => {
    const f = fausseHttp();

    const bilan = await pousser([], {
      base: "https://app.ndank.test",
      jeton: "j",
      poivre: POIVRE,
      site: "Baobart",
      http: f.http,
    });

    expect(bilan).toEqual({ envoyees: 0, lots: 0, echecs: [] });
    expect(f.requetes).toHaveLength(0);
  });
});

describe("ce qu'on projette", () => {
  const maintenant = new Date("2026-02-09T00:00:00Z");

  it("garde ce dont il peut encore advenir quelque chose", () => {
    expect(
      aProjeter({ repriseJusquA: new Date("2026-03-18T00:00:00Z") }, maintenant),
    ).toBe(true);
  });

  it("laisse tomber un abonnement clos", () => {
    // Le pousser ferait grossir Ndank App d'un historique que personne ne
    // regarde — et donnerait à un service tiers la trace de tout ce à quoi une
    // personne a jamais été abonnée.
    expect(
      aProjeter(
        { repriseJusquA: new Date("2026-03-18T00:00:00Z"), closLe: maintenant },
        maintenant,
      ),
    ).toBe(false);
  });

  it("laisse tomber ce qui est au-delà de la reprise", () => {
    expect(
      aProjeter({ repriseJusquA: new Date("2026-01-01T00:00:00Z") }, maintenant),
    ).toBe(false);
  });

  it("garde un résilié tant que son accès payé court", () => {
    // C'est justement là qu'il a besoin de le voir : il a payé jusqu'au bout
    // du cycle, et résilier ne confisque pas ce temps.
    expect(
      aProjeter({ repriseJusquA: new Date("2026-03-18T00:00:00Z") }, maintenant),
    ).toBe(true);
  });
});

describe("faire une carte à partir d'un abonnement", () => {
  const maintenant = new Date("2026-02-09T00:00:00Z");

  const abonnement = {
    id: "abo-1",
    libelle: "Pass Créateur",
    montant: 2000,
    devise: "XOF",
    cadence: "MENSUEL" as const,
    debut: new Date("2026-01-10T00:00:00Z"),
    echeance: new Date("2026-02-09T00:00:00Z"),
    accesJusquA: new Date("2026-02-16T00:00:00Z"),
    repriseJusquA: new Date("2026-03-18T00:00:00Z"),
    resilieeLe: null,
    suspenduLe: null,
    abonne: { courriel: "awa@baobart.ci", telephone: "+2250700000000" },
  };

  const reglages = { site: "Baobart", poivre: POIVRE };

  it("identifie par le numéro quand il y en a un", () => {
    // C'est par lui que l'abonné se connectera à Ndank App.
    const p = projectionDe(abonnement, reglages, maintenant)!;

    expect(p.empreinte).toBe(empreinte("+2250700000000", POIVRE));
  });

  it("se rabat sur l'adresse plutôt que de rendre l'abonné invisible", () => {
    const p = projectionDe(
      { ...abonnement, abonne: { courriel: "awa@baobart.ci", telephone: null } },
      reglages,
      maintenant,
    )!;

    expect(p.empreinte).toBe(empreinte("awa@baobart.ci", POIVRE));
  });

  it("ne confond pas deux adresses différentes", () => {
    // Un numéro se réduit à ses chiffres ; appliquer la même règle à une
    // adresse la réduirait à la chaîne vide, et tous les abonnés inscrits par
    // courriel partageraient une seule et même empreinte.
    expect(empreinte("awa@baobart.ci", POIVRE)).not.toBe(
      empreinte("kofi@baobart.ci", POIVRE),
    );
  });

  it("recolle deux écritures de la même adresse", () => {
    expect(empreinte("  Awa@Baobart.ci ", POIVRE)).toBe(
      empreinte("awa@baobart.ci", POIVRE),
    );
  });

  it("ne projette rien quand on n'a aucun moyen de joindre l'abonné", () => {
    // Il ne pourra jamais se connecter pour voir cette carte : la pousser
    // reviendrait à confier une ligne à un service tiers pour que personne ne
    // la lise.
    expect(
      projectionDe(
        { ...abonnement, abonne: { courriel: null, telephone: null } },
        reglages,
        maintenant,
      ),
    ).toBeNull();
    expect(projectionDe({ ...abonnement, abonne: undefined }, reglages, maintenant))
      .toBeNull();
  });

  it("porte le calendrier, donc la date de début", () => {
    const p = projectionDe(abonnement, reglages, maintenant)!;

    expect(p.debut).toBe("2026-01-10T00:00:00.000Z");
  });

  it("porte le lien quand l'hôte en donne un, et null sinon", () => {
    expect(
      projectionDe(
        abonnement,
        { ...reglages, lien: (id) => `https://p.baobart.ci/v/${id}` },
        maintenant,
      )!.lien,
    ).toBe("https://p.baobart.ci/v/abo-1");

    expect(projectionDe(abonnement, reglages, maintenant)!.lien).toBeNull();
  });

  it("ne projette pas un abonnement clos", () => {
    expect(
      projectionDe({ ...abonnement, closLe: maintenant }, reglages, maintenant),
    ).toBeNull();
  });
});

describe("un numéro mal rangé", () => {
  const maintenant = new Date("2026-02-09T00:00:00Z");

  it("lève, au lieu de fabriquer une seconde identité en silence", () => {
    // Une absence de contact est un fait de la base ; un numéro local est un
    // défaut. Rendre `null` traiterait les deux pareil, et se tairait sur le
    // second.
    expect(() =>
      projectionDe(
        {
          id: "abo-1",
          libelle: "Pass Créateur",
          montant: 2000,
          devise: "XOF",
          cadence: "MENSUEL",
          debut: new Date("2026-01-10T00:00:00Z"),
          echeance: new Date("2026-02-09T00:00:00Z"),
          accesJusquA: new Date("2026-02-16T00:00:00Z"),
          repriseJusquA: new Date("2026-03-18T00:00:00Z"),
          resilieeLe: null,
          suspenduLe: null,
          abonne: { courriel: null, telephone: "0700000000" },
        },
        { site: "Baobart", poivre: POIVRE },
        maintenant,
      ),
    ).toThrow(/E\.164/);
  });
});
