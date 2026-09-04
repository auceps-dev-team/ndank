import { describe, expect, it } from "vitest";

import { evolution, parMois, recurrentMensuel, type Recurrent } from "./argent";

describe("ramener une cadence au mois", () => {
  it("laisse le mensuel intact", () => {
    expect(parMois(2000, "MENSUEL")).toBe(2000);
  });

  it("multiplie l'hebdomadaire, divise le trimestriel et l'annuel", () => {
    // 1 500 F par semaine, c'est trente jours sur sept.
    expect(parMois(1500, "HEBDOMADAIRE")).toBe(6429);
    expect(parMois(6000, "TRIMESTRIEL")).toBe(2000);
    expect(parMois(20_000, "ANNUEL")).toBe(1644);
  });

  it("emploie les trente jours du cœur, et non un mois calendaire", () => {
    // `JOURS_DE_CADENCE` dit qu'un cycle mensuel dure trente jours. Ce n'est
    // pas une approximation qu'on corrigerait en prenant 30,44 : c'est LA
    // durée qu'un abonnement mensuel a chez Ndank, celle qui décide de
    // l'échéance. Prendre autre chose ferait afficher 2 029 F pour un abonné
    // qu'on facture 2 000 — un écart invisible et irrapprochable.
    expect(parMois(2000, "MENSUEL")).toBe(2000);
    expect(parMois(60_000, "TRIMESTRIEL")).toBe(20_000);
  });
});

describe("le revenu récurrent mensuel", () => {
  it("additionne les cadences après les avoir ramenées au mois", () => {
    const groupes: Recurrent[] = [
      { devise: "XOF", cadence: "MENSUEL", nombre: 38, total: 76_000 },
      { devise: "XOF", cadence: "ANNUEL", nombre: 2, total: 40_000 },
    ];

    const [xof] = recurrentMensuel(groupes);

    expect(xof!.nombre).toBe(40);
    expect(xof!.total).toBe(76_000 + parMois(40_000, "ANNUEL"));
  });

  it("ne mélange jamais deux devises", () => {
    // Le franc CFA et le cedi n'ont ni la même valeur ni le même nombre de
    // décimales. Les additionner produirait un nombre qui ressemble à de
    // l'argent sans en être — et personne ne s'en apercevrait, parce qu'un
    // total est toujours plausible.
    const lignes = recurrentMensuel([
      { devise: "XOF", cadence: "MENSUEL", nombre: 10, total: 20_000 },
      { devise: "GHS", cadence: "MENSUEL", nombre: 5, total: 10_000 },
    ]);

    expect(lignes).toHaveLength(2);
    expect(lignes.map((l) => l.devise).sort()).toEqual(["GHS", "XOF"]);
  });

  it("arrondit une fois par groupe, et non une fois par abonnement", () => {
    // Mille arrondis feraient dériver le total. Un seul par groupe garde un
    // chiffre qu'on peut rapprocher de ce qu'on facture.
    const groupe: Recurrent[] = [
      { devise: "XOF", cadence: "ANNUEL", nombre: 1000, total: 1000 * 20_000 },
    ];

    // Arrondi une fois sur le total : 20 000 000 × 30 / 365.
    expect(recurrentMensuel(groupe)[0]!.total).toBe(
      Math.round((1000 * 20_000 * 30) / 365),
    );
    // Et non mille fois 1 644, qui donnerait 1 644 000.
    expect(recurrentMensuel(groupe)[0]!.total).not.toBe(1000 * 1644);
  });

  it("ignore une cadence qu'il ne connaît pas plutôt que de la deviner", () => {
    // La faire passer pour « mensuel » rendrait le total faux sans que rien
    // ne le dise. Le compte d'abonnements, lui, trahit l'écart.
    const lignes = recurrentMensuel([
      { devise: "XOF", cadence: "MENSUEL", nombre: 10, total: 20_000 },
      { devise: "XOF", cadence: "QUOTIDIEN", nombre: 5, total: 500 },
    ]);

    expect(lignes[0]!.total).toBe(20_000);
    expect(lignes[0]!.nombre).toBe(10);
  });

  it("range la devise la plus lourde en premier", () => {
    const lignes = recurrentMensuel([
      { devise: "GHS", cadence: "MENSUEL", nombre: 1, total: 100 },
      { devise: "XOF", cadence: "MENSUEL", nombre: 1, total: 50_000 },
    ]);

    expect(lignes[0]!.devise).toBe("XOF");
  });

  it("rend une liste vide quand il n'y a rien, sans inventer un zéro", () => {
    expect(recurrentMensuel([])).toEqual([]);
  });
});

describe("l'évolution entre deux périodes", () => {
  it("rend le pourcentage à une décimale", () => {
    expect(evolution(216_800, 200_000)).toBe(8.4);
    expect(evolution(180_000, 200_000)).toBe(-10);
  });

  it("rend null quand il n'y a rien à comparer", () => {
    // Le mois où l'on démarre, il n'y a pas de mois dernier. Rendre « +100 % »
    // serait inventer une histoire, et un tableau de bord qui affiche « +∞ % »
    // fait douter du reste.
    expect(evolution(200_000, 0)).toBeNull();
    expect(evolution(0, 0)).toBeNull();
  });

  it("dit bien zéro quand rien n'a bougé", () => {
    expect(evolution(200_000, 200_000)).toBe(0);
  });
});
