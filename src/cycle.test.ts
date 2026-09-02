import { describe, expect, it } from "vitest";

import {
  REGLAGES_PAR_DEFAUT,
  ajouterJours,
  cleDeCycle,
  cycleApresPaiement,
  cycleSuivant,
  jour,
  joursEntre,
} from "./cycle";

const LE_10_JANVIER = new Date("2026-01-10T14:32:00Z");

describe("les dates", () => {
  it("ramène au jour civil UTC, sans l'heure", () => {
    expect(jour(LE_10_JANVIER).toISOString()).toBe("2026-01-10T00:00:00.000Z");
  });

  it("ne change pas de jour selon l'heure d'exécution", () => {
    // Un passage lancé à 23 h 58 et un lancé à 00 h 02 doivent donner la même
    // échéance. Sans cela, deux serveurs dans deux régions factureraient des
    // jours différents.
    const tard = jour(new Date("2026-01-10T23:58:00Z"));
    const tot = jour(new Date("2026-01-10T00:02:00Z"));
    expect(tard.getTime()).toBe(tot.getTime());
  });

  it("compte les jours entre deux instants", () => {
    expect(joursEntre(LE_10_JANVIER, ajouterJours(LE_10_JANVIER, 5))).toBe(5);
    expect(joursEntre(LE_10_JANVIER, ajouterJours(LE_10_JANVIER, -2))).toBe(-2);
  });
});

describe("le premier cycle", () => {
  it("place l'échéance à la cadence, et l'accès au-delà", () => {
    const c = cycleApresPaiement(LE_10_JANVIER, "MENSUEL");

    expect(joursEntre(c.debut, c.echeance)).toBe(30);
    // L'accès dépasse l'échéance : c'est la grâce, et elle est délibérée.
    expect(joursEntre(c.echeance, c.accesJusquA)).toBe(
      REGLAGES_PAR_DEFAUT.graceJours,
    );
    expect(joursEntre(c.accesJusquA, c.repriseJusquA)).toBe(
      REGLAGES_PAR_DEFAUT.repriseJours,
    );
  });

  it("suit la cadence demandée", () => {
    expect(
      joursEntre(
        cycleApresPaiement(LE_10_JANVIER, "HEBDOMADAIRE").debut,
        cycleApresPaiement(LE_10_JANVIER, "HEBDOMADAIRE").echeance,
      ),
    ).toBe(7);
    expect(
      joursEntre(
        cycleApresPaiement(LE_10_JANVIER, "ANNUEL").debut,
        cycleApresPaiement(LE_10_JANVIER, "ANNUEL").echeance,
      ),
    ).toBe(365);
  });

  it("respecte des réglages sur mesure", () => {
    const c = cycleApresPaiement(LE_10_JANVIER, "MENSUEL", {
      graceJours: 2,
      repriseJours: 10,
    });
    expect(joursEntre(c.echeance, c.accesJusquA)).toBe(2);
  });
});

describe("le cycle suivant", () => {
  it("enchaîne sur l'échéance, pas sur la date de paiement", () => {
    // Le test qui compte. Un abonné qui paie trois jours en retard chaque mois
    // verrait sinon son échéance glisser de trois jours par cycle : au bout
    // d'un an, il paierait onze mois au lieu de douze.
    const premier = cycleApresPaiement(LE_10_JANVIER, "MENSUEL");
    const enRetard = ajouterJours(premier.echeance, 3);

    const second = cycleSuivant(premier, enRetard, "MENSUEL");

    expect(joursEntre(premier.echeance, second.echeance)).toBe(30);
    // Et non 33, qui serait le compte à partir du paiement.
  });

  it("garde le rythme même quand on paie en avance", () => {
    const premier = cycleApresPaiement(LE_10_JANVIER, "MENSUEL");
    const enAvance = ajouterJours(premier.echeance, -5);

    const second = cycleSuivant(premier, enAvance, "MENSUEL");

    expect(joursEntre(premier.echeance, second.echeance)).toBe(30);
  });

  it("repart du paiement quand l'accès était déjà perdu", () => {
    // Enchaîner sur une échéance vieille de trois semaines facturerait une
    // période déjà écoulée.
    const premier = cycleApresPaiement(LE_10_JANVIER, "MENSUEL");
    const bienApres = ajouterJours(premier.accesJusquA, 10);

    const second = cycleSuivant(premier, bienApres, "MENSUEL");

    expect(second.debut.getTime()).toBe(jour(bienApres).getTime());
    expect(joursEntre(bienApres, second.echeance)).toBe(30);
  });

  it("traite le paiement au dernier jour de grâce comme un enchaînement", () => {
    // La borne exacte : payer le dernier jour de l'accès garde le rythme.
    const premier = cycleApresPaiement(LE_10_JANVIER, "MENSUEL");
    const second = cycleSuivant(premier, premier.accesJusquA, "MENSUEL");

    expect(joursEntre(premier.echeance, second.echeance)).toBe(30);
  });
});

describe("la clé de cycle", () => {
  it("est la même quelle que soit l'heure du passage", () => {
    // C'est elle qui empêche un passage quotidien de renvoyer sept fois le
    // même rappel pour une seule échéance.
    expect(cleDeCycle(new Date("2026-02-09T23:00:00Z"))).toBe(
      cleDeCycle(new Date("2026-02-09T01:00:00Z")),
    );
  });

  it("change d'un cycle à l'autre", () => {
    const premier = cycleApresPaiement(LE_10_JANVIER, "MENSUEL");
    const second = cycleSuivant(premier, premier.echeance, "MENSUEL");
    expect(cleDeCycle(premier.echeance)).not.toBe(cleDeCycle(second.echeance));
  });
});
