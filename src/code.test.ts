import { describe, expect, it } from "vitest";

import { engendrer, ESSAIS_MAX, verificateur, type Tentatives } from "./code";

const SECRET = "le-secret-de-ndank-app";
const T = new Date("2026-02-09T10:00:00Z");

/** Un compteur en mémoire. Bon pour un test, jamais pour une production. */
function compteur(): Tentatives & { etat: Map<string, number> } {
  const etat = new Map<string, number>();

  return {
    etat,
    async compter(cle) {
      return etat.get(cle) ?? 0;
    },
    async echec(cle) {
      etat.set(cle, (etat.get(cle) ?? 0) + 1);
    },
    async reussite(cle) {
      etat.delete(cle);
    },
  };
}

describe("engendrer un code", () => {
  it("fait six chiffres, zéros de tête compris", () => {
    // `padStart` : sans lui, un code valant 4711 s'afficherait « 4711 » et
    // l'abonné le taperait dans un champ qui en attend six.
    for (let i = 0; i < 500; i++) {
      const code = engendrer(SECRET, `+22507000${String(i).padStart(5, "0")}`, T);

      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it("donne le même code aux deux écritures d'un même numéro", () => {
    // Sinon l'abonné reçoit un code calculé sur une écriture de son numéro et
    // se le voit refuser sur une autre.
    expect(engendrer(SECRET, "+225 07 00 00 00 00", T)).toBe(
      engendrer(SECRET, "+2250700000000", T),
    );
  });

  it("donne des codes différents à deux personnes", () => {
    expect(engendrer(SECRET, "+2250700000000", T)).not.toBe(
      engendrer(SECRET, "+2250700000001", T),
    );
  });

  it("change de fenêtre en fenêtre", () => {
    const tard = new Date(T.getTime() + 6 * 60_000);

    expect(engendrer(SECRET, "+2250700000000", T)).not.toBe(
      engendrer(SECRET, "+2250700000000", tard),
    );
  });

  it("ne se devine pas sans le secret", () => {
    expect(engendrer("a", "+2250700000000", T)).not.toBe(
      engendrer("b", "+2250700000000", T),
    );
  });


  it("refuse un numéro qui n'est pas en E.164, plutôt que d'en faire un autre", () => {
    // Un hôte qui range « 0700000000 » et un autre « +2250700000000 » donneraient
    // deux identités pour la même personne. L'abonné recevrait alors un code
    // calculé sur une écriture de son numéro et se le verrait refuser sur
    // l'autre — sans erreur, sans trace, sans que personne ne sache quoi
    // chercher.
    expect(() => engendrer(SECRET, "0700000000", T)).toThrow(/E\.164/);
  });

  it("répartit à peu près uniformément", () => {
    // La troncature dynamique de la RFC 4226 est là pour ça : prendre les
    // quatre premiers octets biaiserait vers les valeurs basses, parce que le
    // modulo d'un entier de 32 bits par un million n'est pas uniforme.
    const tranches = new Array(10).fill(0);

    for (let i = 0; i < 2000; i++) {
      const code = engendrer(SECRET, `u${i}@x.ci`, T);
      tranches[Math.floor(Number(code) / 100_000)]! += 1;
    }

    // 200 attendus par tranche ; on laisse une marge large, on cherche un
    // biais grossier, pas une preuve statistique.
    for (const n of tranches) {
      expect(n).toBeGreaterThan(120);
      expect(n).toBeLessThan(290);
    }
  });
});

describe("vérifier un code", () => {
  it("ouvre sur le bon code", async () => {
    const c = compteur();
    const verifier = verificateur({ secret: SECRET, tentatives: c });

    const v = await verifier(
      "+2250700000000",
      engendrer(SECRET, "+2250700000000", T),
      T,
    );

    expect(v).toEqual({ issue: "OUVERT" });
  });

  it("accepte encore le code de la fenêtre précédente", async () => {
    // Un code émis à la fin d'une fenêtre serait mort avant que le SMS
    // n'arrive. Entre cinq et dix minutes, selon le moment où il part.
    const c = compteur();
    const verifier = verificateur({ secret: SECRET, tentatives: c });
    const code = engendrer(SECRET, "+2250700000000", T);
    const plusTard = new Date(T.getTime() + 5 * 60_000);

    expect(await verifier("+2250700000000", code, plusTard)).toEqual({
      issue: "OUVERT",
    });
  });

  it("refuse au-delà de deux fenêtres", async () => {
    const c = compteur();
    const verifier = verificateur({ secret: SECRET, tentatives: c });
    const code = engendrer(SECRET, "+2250700000000", T);
    const bienPlusTard = new Date(T.getTime() + 11 * 60_000);

    expect(
      (await verifier("+2250700000000", code, bienPlusTard)).issue,
    ).toBe("REFUSE");
  });

  it("ferme la porte au bout de cinq essais", async () => {
    // Six chiffres font un million de possibilités, ce qui se parcourt en
    // quelques secondes. Le code ne protège rien ; c'est le nombre d'essais
    // qui protège.
    const c = compteur();
    const verifier = verificateur({ secret: SECRET, tentatives: c });

    for (let i = 0; i < ESSAIS_MAX; i++) {
      const v = await verifier("+2250700000000", "000000", T);
      expect(v.issue).toBe("REFUSE");
    }

    expect(await verifier("+2250700000000", "000000", T)).toEqual({
      issue: "BLOQUE",
    });
  });

  it("ne regarde même pas le bon code une fois la porte fermée", async () => {
    const c = compteur();
    const verifier = verificateur({ secret: SECRET, tentatives: c });
    c.etat.set("+2250700000000", ESSAIS_MAX);

    const v = await verifier(
      "+2250700000000",
      engendrer(SECRET, "+2250700000000", T),
      T,
    );

    expect(v).toEqual({ issue: "BLOQUE" });
  });

  it("dit combien d'essais il reste", async () => {
    const c = compteur();
    const verifier = verificateur({ secret: SECRET, tentatives: c });

    expect(await verifier("+2250700000000", "000000", T)).toEqual({
      issue: "REFUSE",
      restants: 4,
    });
    expect(await verifier("+2250700000000", "000000", T)).toEqual({
      issue: "REFUSE",
      restants: 3,
    });
  });

  it("remet le compteur à zéro quand le code est bon", async () => {
    // Sans cela, quelqu'un qui se trompe quatre fois puis réussit resterait à
    // un essai de se voir bloqué à sa prochaine connexion.
    const c = compteur();
    const verifier = verificateur({ secret: SECRET, tentatives: c });

    await verifier("+2250700000000", "000000", T);
    await verifier("+2250700000000", engendrer(SECRET, "+2250700000000", T), T);

    expect(c.etat.has("+2250700000000")).toBe(false);
  });

  it("compte sur la forme normalisée, et non sur ce qui a été tapé", async () => {
    // Sans cela, il suffirait de réécrire son numéro autrement à chaque essai
    // pour disposer de cinq tentatives de plus à chaque fois.
    const c = compteur();
    const verifier = verificateur({ secret: SECRET, tentatives: c });

    await verifier("+2250700000000", "000000", T);
    await verifier("+225 07 00 00 00 00", "000000", T);

    expect(c.etat.get("+2250700000000")).toBe(2);
  });

  it("refuse de se construire sans compteur", () => {
    // Un port qu'on peut omettre finit par être omis, et l'on découvre le jour
    // de l'incident que la fonction qu'on croyait sûre ne l'était que dans les
    // exemples.
    expect(() =>
      verificateur({
        secret: SECRET,
        tentatives: undefined as unknown as Tentatives,
      }),
    ).toThrow(/compteur de tentatives/);
  });

  it("refuse un code de la bonne longueur mais faux, sans lever", async () => {
    const c = compteur();
    const verifier = verificateur({ secret: SECRET, tentatives: c });

    expect((await verifier("+2250700000000", "abcdef", T)).issue).toBe("REFUSE");
    expect((await verifier("+2250700000000", "", T)).issue).toBe("REFUSE");
    expect((await verifier("+2250700000000", "0".repeat(64), T)).issue).toBe(
      "REFUSE",
    );
  });

  it("ne donne pas le code d'un autre à qui change d'identifiant", async () => {
    const c = compteur();
    const verifier = verificateur({ secret: SECRET, tentatives: c });

    const v = await verifier(
      "+2250700000001",
      engendrer(SECRET, "+2250700000000", T),
      T,
    );

    expect(v.issue).toBe("REFUSE");
  });
});
