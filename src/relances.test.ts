import { describe, expect, it } from "vitest";

import { coutDesRelances, statistiques } from "./relances";

describe("le coût des relances", () => {
  it("ne connaît aucun prix : l'hôte les déclare", () => {
    // Un SMS ne coûte pas la même chose selon l'opérateur, le pays, le volume
    // négocié et le jour où le contrat a été signé. Un tarif écrit dans la
    // bibliothèque serait faux pour tout le monde sauf pour celui qui l'a
    // écrit.
    const cout = coutDesRelances(
      { courriel: 40, push: 12, sms: 36 },
      { sms: 50 },
      "XOF",
    );

    expect(cout.total).toBe(1800);
    expect(cout.messages).toBe(88);
    expect(cout.parCanal.find((c) => c.canal === "sms")!.cout).toBe(1800);
  });

  it("traite un tarif absent comme gratuit, et non comme inconnu", () => {
    // Le courriel et la notification le sont chez la plupart des passerelles.
    // Obliger à déclarer zéro pour eux ferait oublier de déclarer le SMS.
    const cout = coutDesRelances({ courriel: 100 }, {}, "XOF");

    expect(cout.parCanal[0]!.cout).toBe(0);
    expect(cout.total).toBe(0);
  });

  it("n'affiche pas les canaux qui n'ont rien envoyé", () => {
    const cout = coutDesRelances({ sms: 3 }, { sms: 50 }, "XOF");

    expect(cout.parCanal.map((c) => c.canal)).toEqual(["sms"]);
  });

  it("range du gratuit au payant, comme l'échelle des relances", () => {
    const cout = coutDesRelances(
      { sms: 1, courriel: 1, push: 1 },
      { sms: 50 },
      "XOF",
    );

    expect(cout.parCanal.map((c) => c.canal)).toEqual(["courriel", "push", "sms"]);
  });
});

describe("les statistiques d'un abonné", () => {
  const versement = (reference: string, compteLe: string) => ({
    reference,
    compteLe: new Date(compteLe),
  });

  it("compte les cycles, et non les versements", () => {
    // Payer en trois fois ne fait pas trois cycles payés.
    const s = statistiques([
      versement("20260209-1-ab-1", "2026-02-09T10:00:00Z"),
      versement("20260209-2-ab-1", "2026-02-10T10:00:00Z"),
      versement("20260311-1-ab-1", "2026-03-11T10:00:00Z"),
    ]);

    expect(s.cyclesPayes).toBe(2);
  });

  it("mesure le retard contre l'échéance visée, pas contre le versement précédent", () => {
    // C'est la subtilité du modèle : l'échéance s'enchaîne sur l'échéance, donc
    // un abonné qui règle trois jours en retard chaque mois garde la même date
    // d'échéance. Son retard est constant, pas cumulatif — et le mesurer contre
    // le versement précédent le ferait apparaître ponctuel.
    const s = statistiques([
      versement("20260209-1-ab-1", "2026-02-12T10:00:00Z"),
      versement("20260311-1-ab-1", "2026-03-14T10:00:00Z"),
      versement("20260410-1-ab-1", "2026-04-13T10:00:00Z"),
    ]);

    expect(s.retardMoyenJours).toBe(3);
  });

  it("garde les avances, plutôt que de les ramener à zéro", () => {
    // Ce serait faire apparaître en retard une population qui ne l'est pas —
    // et c'est justement la moyenne qui doit distinguer « paie la veille » de
    // « paie le surlendemain ».
    const s = statistiques([
      versement("20260209-1-ab-1", "2026-02-06T10:00:00Z"),
      versement("20260311-1-ab-1", "2026-03-09T10:00:00Z"),
    ]);

    expect(s.retardMoyenJours).toBe(-2.5);
  });

  it("compare des jours civils, pas des instants", () => {
    // L'heure à laquelle un webhook arrive ne doit pas décider qu'un abonné
    // est ponctuel ou non.
    const minuit = statistiques([versement("20260209-1-ab-1", "2026-02-09T00:01:00Z")]);
    const soir = statistiques([versement("20260209-1-ab-1", "2026-02-09T23:59:00Z")]);

    expect(minuit.retardMoyenJours).toBe(0);
    expect(soir.retardMoyenJours).toBe(0);
  });

  it("rend null plutôt qu'un zéro qui ferait croire à quelqu'un de ponctuel", () => {
    expect(statistiques([]).retardMoyenJours).toBeNull();
    expect(statistiques([versement("REF-EXTERNE", "2026-02-09T10:00:00Z")]).retardMoyenJours)
      .toBeNull();
  });

  it("donne l'ancienneté réelle, par le premier versement compté", () => {
    const s = statistiques([
      versement("20260311-1-ab-1", "2026-03-11T10:00:00Z"),
      versement("20260209-1-ab-1", "2026-02-09T10:00:00Z"),
    ]);

    expect(s.depuis?.toISOString()).toBe("2026-02-09T10:00:00.000Z");
  });
});
