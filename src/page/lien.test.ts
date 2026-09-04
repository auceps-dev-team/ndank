import { describe, expect, it } from "vitest";

import { segments, tientEnGsm7 } from "../gsm7";
import {
  JOURS_DE_VALIDITE,
  jourDe,
  lienDe,
  lireLien,
  signerLien,
  type LectureJeton,
  type Refus,
} from "./lien";

const SECRET = "un-secret-de-quarante-caracteres-au-moins";
const LE_9 = new Date("2026-02-09T10:00:00Z");

/** Le motif du refus, ou `null` si le jeton était bon. */
const refusDe = (lu: LectureJeton): Refus | null =>
  lu.valide ? null : lu.refus;

describe("le jeton", () => {
  it("se relit tel qu'on l'a écrit", () => {
    const jeton = signerLien(SECRET, {
      abonnementId: "ab-1",
      jourLimite: jourDe(LE_9) + 15,
    });

    const lu = lireLien(SECRET, jeton, LE_9);

    expect(lu.valide).toBe(true);
    expect(lu.valide && lu.contenu.abonnementId).toBe("ab-1");
  });

  it("survit à un identifiant qui contient un point", () => {
    // Ndank ne choisit pas les identifiants de l'hôte. Transcrire l'identifiant
    // tel quel casserait le découpage sur le premier qui contient le séparateur.
    const jeton = signerLien(SECRET, {
      abonnementId: "projet.abonnement.42",
      jourLimite: jourDe(LE_9) + 1,
    });

    const lu = lireLien(SECRET, jeton, LE_9);
    expect(lu.valide && lu.contenu.abonnementId).toBe("projet.abonnement.42");
  });

  it("n'est pas énumérable : deux identifiants voisins ne se ressemblent pas", () => {
    // C'est le défaut du lien que montrait le README. Avec « /valider/ab-1 »,
    // quiconque reçoit un lien change un chiffre et lit la page d'un autre :
    // son offre, son montant, son retard. Il n'y a rien à deviner, il suffit de
    // compter.
    const a = signerLien(SECRET, { abonnementId: "ab-1", jourLimite: 20_500 });
    const b = signerLien(SECRET, { abonnementId: "ab-2", jourLimite: 20_500 });

    const sceauA = a.split(".")[2]!;
    const sceauB = b.split(".")[2]!;

    expect(sceauA).not.toBe(sceauB);
    // Aucun préfixe commun exploitable entre les deux sceaux.
    expect(sceauA[0] === sceauB[0] && sceauA[1] === sceauB[1]).toBe(false);
  });
});

describe("ce qu'un jeton refuse", () => {
  it("un sceau fabriqué avec un autre secret", () => {
    const jeton = signerLien("le-bon-secret", {
      abonnementId: "ab-1",
      jourLimite: 99_999,
    });

    expect(lireLien("un-autre-secret", jeton, LE_9)).toEqual({
      valide: false,
      refus: "SCEAU",
    });
  });

  it("un identifiant changé après coup", () => {
    // La tentative évidente : prendre son propre lien et remplacer l'abonnement.
    const mien = signerLien(SECRET, {
      abonnementId: "ab-1",
      jourLimite: 99_999,
    });

    const sceau = mien.split(".")[2]!;
    const autre = Buffer.from("ab-2", "utf8").toString("base64url");
    const bricole = `${autre}.${(99_999).toString(36)}.${sceau}`;

    expect(lireLien(SECRET, bricole, LE_9).valide).toBe(false);
  });

  it("une date d'expiration repoussée après coup", () => {
    const jeton = signerLien(SECRET, { abonnementId: "ab-1", jourLimite: 100 });

    const [id, , sceau] = jeton.split(".") as [string, string, string];
    const repousse = `${id}.${(99_999).toString(36)}.${sceau}`;

    expect(lireLien(SECRET, repousse, LE_9).valide).toBe(false);
  });

  it("un jeton dont la forme ne tient pas", () => {
    expect(refusDe(lireLien(SECRET, "", LE_9))).toBe("FORME");
    expect(refusDe(lireLien(SECRET, "abc", LE_9))).toBe("FORME");
    expect(refusDe(lireLien(SECRET, "a.b.c.d", LE_9))).toBe("FORME");
  });

  it("vérifie le sceau AVANT l'expiration", () => {
    // Inverser reviendrait à répondre « expiré » à un jeton fabriqué de toutes
    // pièces — ce qui confirme à celui qui l'a fabriqué que sa forme est la
    // bonne, et qu'il ne lui reste qu'à trouver le sceau.
    const perime = `${Buffer.from("ab-1", "utf8").toString("base64url")}.${(1).toString(36)}.zzzzzzzzzzzzzzzz`;

    expect(refusDe(lireLien(SECRET, perime, LE_9))).toBe("SCEAU");
  });
});

describe("l'expiration", () => {
  it("laisse passer le dernier jour, et refuse le lendemain", () => {
    const jeton = signerLien(SECRET, {
      abonnementId: "ab-1",
      jourLimite: jourDe(LE_9),
    });

    // Le même jour civil, à n'importe quelle heure. C'est la même règle que
    // partout : on compare des jours, pas des instants — sinon un lien
    // expirerait à des heures différentes selon le fuseau du serveur.
    expect(lireLien(SECRET, jeton, new Date("2026-02-09T23:59:00Z")).valide).toBe(
      true,
    );
    expect(refusDe(lireLien(SECRET, jeton, new Date("2026-02-10T00:01:00Z")))).toBe(
      "EXPIRE",
    );
  });

  it("couvre toute l'échelle des relances", () => {
    // Sept jours avant l'échéance, sept après : un lien plus court expirerait
    // avant le dernier palier, et l'abonné qui remonte dans ses SMS tomberait
    // sur une page morte au moment où il se décide enfin.
    expect(JOURS_DE_VALIDITE).toBeGreaterThan(14);
  });
});

describe("le lien complet", () => {
  it("se compose sur la base publique de l'hôte, sans barre doublée", () => {
    expect(lienDe("https://p.baobart.ci/v/", SECRET, "ab-1", LE_9)).toMatch(
      /^https:\/\/p\.baobart\.ci\/v\/[A-Za-z0-9_-]+\.[a-z0-9]+\.[A-Za-z0-9_-]{16}$/,
    );
  });

  it("passe en GSM-7 sans repli, et ne coûte pas un segment à lui seul", () => {
    // Les soixante-quatre caractères de base64url sont tous dans l'alphabet par
    // défaut de la norme. Le lien ne fait donc pas basculer la relance en
    // UCS-2 — où le segment tombe de 160 à 70 caractères.
    const lien = lienDe("https://p.baobart.ci/v", SECRET, "clx7k2p9a0001qw", LE_9);

    expect(tientEnGsm7(lien)).toBe(true);
    expect(segments(lien)).toBe(1);
    // Il reste de la place pour le message autour.
    expect(lien.length).toBeLessThan(90);
  });

  it("garde le sceau court, pour rendre des caractères au nom de l'offre", () => {
    // Douze octets, soit seize caractères, au lieu des quarante-trois d'un
    // HMAC-SHA256 complet : vingt-sept caractères de SMS rendus à chaque
    // relance.
    const jeton = signerLien(SECRET, { abonnementId: "ab-1", jourLimite: 20_500 });

    expect(jeton.split(".")[2]!).toHaveLength(16);
  });
});
