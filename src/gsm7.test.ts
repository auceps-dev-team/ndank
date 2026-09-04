import { describe, expect, it } from "vitest";

import {
  replier,
  replierAvecPertes,
  segments,
  tientEnGsm7,
} from "./gsm7";

/**
 * Le défaut que ces tests attrapent ne se voit pas : le message part, il est
 * lu, et il coûte deux à trois fois son prix. Rien dans le journal ne le dit,
 * rien dans le rendu ne le montre — seule la facture, un mois plus tard.
 */

describe("ce qui fait basculer un message en UCS-2", () => {
  it("l'espace fine insécable que les formateurs de montant insèrent", () => {
    // C'est LE cas réel : `Intl.NumberFormat` en français sépare le montant de
    // sa devise par une espace fine insécable. Chaque relance porte un montant,
    // donc chaque relance basculerait en UCS-2 si on ne repliait pas.
    const montant = "2 000 F";
    expect(tientEnGsm7(montant)).toBe(false);
    expect(tientEnGsm7(replier(montant))).toBe(true);
  });

  it("toutes les autres espaces d'Unicode, et pas seulement les quatre connues", () => {
    // Quatre d'entre elles figuraient dans la table des replis, choisies parce
    // qu'on les avait rencontrées. Les six autres disparaissaient du message ET
    // étaient comptées comme des pertes : les mots se recollaient, et la liste
    // des pertes criait au loup à chaque relance — si bien qu'une vraie perte
    // n'aurait plus été vue.
    //
    // Un libellé d'offre est une chaîne que quelqu'un a saisie, souvent collée
    // depuis un traitement de texte. Un traitement de texte met des espaces
    // typographiques partout.
    const exotiques = [0x00a0, 0x1680, 0x2000, 0x2003, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000];

    for (const point of exotiques) {
      const texte = `Pass${String.fromCharCode(point)}Pro`;
      const repli = replierAvecPertes(texte);

      expect(repli.texte).toBe("Pass Pro");
      expect(repli.perdus).toEqual([]);
      expect(tientEnGsm7(repli.texte)).toBe(true);
    }
  });

  it("l'apostrophe courbe, qu'on écrit partout ailleurs dans Baobart", () => {
    expect(tientEnGsm7("l’accès")).toBe(false);
    expect(replier("l’accès")).toBe("l'accès");
  });

  it("les accents circonflexes et le ç minuscule", () => {
    // Le `Ç` majuscule est dans la norme, le `ç` minuscule non. C'est le genre
    // de détail qu'aucune relecture ne rattrape.
    expect(tientEnGsm7("ç")).toBe(false);
    // Le `à`, lui, reste : le replier appauvrirait le texte sans rien gagner.
    expect(replier("çà et là, un coût")).toBe("cà et là, un cout");
  });

  it("les tirets et points de suspension typographiques", () => {
    expect(replier("un jour — et puis…")).toBe("un jour - et puis...");
  });

  it("un émoji, qui à lui seul ferait tomber le segment à 70", () => {
    expect(replier("Bonjour 👋")).toBe("Bonjour ");
  });
});

describe("ce qui passe tel quel", () => {
  it("les accents que la norme connaît", () => {
    // é è à ù ì ò ä ö ñ ü sont dans l'alphabet : les replier appauvrirait le
    // texte sans rien économiser.
    expect(replier("échéance dépassée, à régler")).toBe("échéance dépassée, à régler");
    expect(tientEnGsm7("échéance dépassée, à régler")).toBe(true);
  });

  it("la ponctuation ordinaire et les chiffres", () => {
    const t = "Renouvelle pour 2000 XOF : https://baobart.ci/a/abc123";
    expect(replier(t)).toBe(t);
    expect(tientEnGsm7(t)).toBe(true);
  });
});

describe("le compte des segments", () => {
  it("un message court tient en un segment", () => {
    expect(segments("Bonjour")).toBe(1);
    expect(segments("")).toBe(0);
  });

  it("bascule à deux segments au-delà de 160, et non de 161", () => {
    expect(segments("a".repeat(160))).toBe(1);
    // L'en-tête de concaténation mange six septets : chaque segment tombe à
    // 153, donc 161 caractères en coûtent deux et non « un et un peu ».
    expect(segments("a".repeat(161))).toBe(2);
    expect(segments("a".repeat(306))).toBe(2);
    expect(segments("a".repeat(307))).toBe(3);
  });

  it("compte double les caractères de la table d'extension", () => {
    // L'euro coûte deux septets. Quatre-vingts euros suffisent à remplir un
    // segment que sa longueur laisserait croire à moitié vide.
    expect(segments("€".repeat(80))).toBe(1);
    expect(segments("€".repeat(81))).toBe(2);
  });

  it("compte en 70 dès qu'un caractère sort de l'alphabet", () => {
    // La démonstration chiffrée du coût : le même texte, à un caractère près.
    expect(segments("a".repeat(100))).toBe(1);
    expect(segments("👋" + "a".repeat(100))).toBe(2);
  });
});

describe("la table d'extension", () => {
  it("garde l'antislash, qui en fait partie", () => {
    // Le jeu s'écrivait "^{}\[~]|€" : dans une chaîne JS, \[ vaut [, donc
    // l'antislash n'échappait pas lui-même mais le crochet, et manquait au jeu.
    // Il disparaissait alors des messages — et, plus grave pour un module qui
    // existe pour mesurer un coût, `segments` comptait en UCS-2 un texte que
    // l'opérateur aurait facturé en GSM-7.
    expect(tientEnGsm7("\\")).toBe(true);
    expect(replier("a\\b")).toBe("a\\b");
  });

  it("compte l'antislash double, comme tout caractère étendu", () => {
    expect(segments("\\".repeat(80))).toBe(1);
    expect(segments("\\".repeat(81))).toBe(2);
  });

  it("ne fait plus basculer en UCS-2 un texte qui en contient un", () => {
    // La démonstration du surcoût annoncé à tort : le même texte, à un
    // antislash près, tenait sur un segment et en était facturé deux.
    expect(segments("a".repeat(100) + "\\")).toBe(1);
  });
});

describe("ce que le repli coûte, et comment le savoir", () => {
  it("dit ce qu'il a supprimé", () => {
    const r = replierAvecPertes("Bonjour 👋");
    expect(r.texte).toBe("Bonjour ");
    expect(r.perdus).toEqual(["👋"]);
  });

  it("ne signale rien quand il a su replier", () => {
    // « ’ » et « â » ont un repli : ce n'est pas une perte à signaler.
    const r = replierAvecPertes("l’accès a coûté");
    expect(r.perdus).toEqual([]);
    expect(r.texte).toBe("l'accès a couté");
  });

  it("signale une écriture entière qu'il a vidée", () => {
    // Le cas qui compte vraiment : au Sénégal, au Mali, au Niger, un nom en
    // écriture arabe disparaît en entier. L'émoji effacé n'est pas grave — le
    // destinataire effacé l'est, et rien ne le disait à l'appelant.
    const r = replierAvecPertes("مرحبا");
    expect(r.texte).toBe("");
    expect(r.perdus.length).toBeGreaterThan(0);
  });

  it("ne compte pas deux fois le même caractère perdu", () => {
    expect(replierAvecPertes("👋👋👋").perdus).toEqual(["👋"]);
  });

  it("rend exactement ce que `replier` rend", () => {
    // Les deux ne doivent pas pouvoir diverger : l'une délègue à l'autre.
    const t = "Renouvelle 2 000 F — l’accès s’arrête… 👋";
    expect(replierAvecPertes(t).texte).toBe(replier(t));
  });
});
