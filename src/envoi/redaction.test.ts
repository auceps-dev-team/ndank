import { describe, expect, it } from "vitest";

import { segments } from "../gsm7";
import type { Message } from "../ports";
import {
  LIMITE_TITRE,
  delai,
  redigerCourriel,
  redigerPush,
  redigerSms,
} from "./redaction";

/** L'espace fine insécable que `Intl.NumberFormat("fr-FR")` glisse dans un montant. */
const FINE = String.fromCharCode(0x202f);

function message(sur: Partial<Message> = {}): Message {
  return {
    cle: "2026-02-09:1",
    destinataire: "Awa",
    offre: "Pass Créateur",
    montant: `2${FINE}000 F CFA`,
    lien: "https://ndank.test/valider/ab-1",
    joursRestants: 5,
    dernier: false,
    ...sur,
  };
}

describe("le courriel", () => {
  it("dit « Bonjour, » quand on ignore le nom, plutôt que d'inventer", () => {
    // Le repli d'avant mettait le libellé de l'offre : « Bonjour Pass
    // Créateur ». On saluait quelqu'un par le nom du produit qu'on lui vend.
    const sans = redigerCourriel(message({ destinataire: null }));

    expect(sans.texte).toContain("Bonjour,");
    expect(sans.texte).not.toContain("Bonjour Pass Créateur");

    expect(redigerCourriel(message()).texte).toContain("Bonjour Awa,");
  });

  it("échappe ce qui vient de la base de l'hôte", () => {
    // Un libellé d'offre est une chaîne que quelqu'un a saisie. Une esperluette
    // et une apostrophe suffisent à casser le rendu — et le lien est échappé
    // jusque dans son attribut, où un guillemet le refermerait.
    const c = redigerCourriel(
      message({
        offre: "Pass Pro & Cie <b>",
        destinataire: "L'Atelier",
        lien: 'https://ndank.test/v?x="1"',
      }),
    );

    expect(c.html).toContain("Pass Pro &amp; Cie &lt;b&gt;");
    expect(c.html).toContain("L&#39;Atelier");
    expect(c.html).toContain('href="https://ndank.test/v?x=&quot;1&quot;"');
    expect(c.html).not.toContain("<b>");

    // Le texte brut, lui, ne s'échappe pas : il n'y a rien à casser.
    expect(c.texte).toContain("Pass Pro & Cie <b>");
  });

  it("prévient toujours que le message a pu croiser un paiement", () => {
    // Le webhook d'un opérateur arrive quand il arrive ; le passage part à
    // heure fixe. Sans cette phrase, l'abonné qui a réglé la veille au soir
    // conclut qu'on ne l'a pas vu, et il repaie.
    for (const jours of [7, 1, 0, -3]) {
      const c = redigerCourriel(message({ joursRestants: jours }));
      expect(c.texte).toContain("croiser votre paiement");
      expect(c.html).toContain("croiser votre paiement");
    }
  });

  it("change de sujet et de verbe quand l'accès est déjà coupé", () => {
    const ouvert = redigerCourriel(message({ joursRestants: 2 }));
    const coupe = redigerCourriel(message({ joursRestants: -2 }));

    expect(ouvert.sujet).toContain("à renouveler");
    expect(ouvert.texte).toContain("Renouveler maintenant");

    expect(coupe.sujet).toContain("suspendu");
    expect(coupe.texte).toContain("Reprendre mon abonnement");
    // Ce que l'abonné a besoin de savoir : reprendre n'est pas se réabonner.
    expect(coupe.texte).toContain("sans repartir de zéro");
  });

  it("annonce le dernier rappel dès le sujet", () => {
    const c = redigerCourriel(message({ dernier: true, joursRestants: 1 }));

    expect(c.sujet).toContain("Dernier rappel");
    expect(c.sujet).toContain("demain");
  });
});

describe("le SMS", () => {
  it("tient en un segment dans le cas ordinaire", () => {
    const s = redigerSms(message());

    expect(s.segments).toBe(1);
    expect(s.tronque).toBe(false);
    expect(s.texte).toContain("https://ndank.test/valider/ab-1");
  });

  it("garde les accents que l'alphabet connaît, et ne replie que les autres", () => {
    // GSM 03.38 contient « é », « è », « à », « ù », « ì », « ò », « ä », « ö »,
    // « ñ », « ü ». Les replier serait une perte gratuite : l'opérateur les
    // aurait acceptés tels quels, au même prix.
    const garde = redigerSms(message({ offre: "Forfait Créateur" }));
    expect(garde.texte).toContain("accès coupé");
    expect(garde.texte).toContain("Créateur");

    // Il ne contient en revanche ni « ê » ni le « ç » minuscule — la norme ne
    // connaît que le « Ç » majuscule. Ceux-là se replient, sans rien perdre.
    const replie = redigerSms(message({ offre: "Fête française" }));
    expect(replie.texte).toContain("Fete francaise");
    expect(replie.perdus).toEqual([]);
  });

  it("ne compte pas l'espace fine d'un montant formaté comme une perte", () => {
    // Le cas est concret : `Intl.NumberFormat("fr-FR")` sépare les milliers par
    // U+202F depuis Node 18, et cette espace-là n'est pas dans l'alphabet
    // GSM-7. C'est `replier` qui la ramène à une espace ordinaire — la
    // rédaction n'a pas sa propre table, sinon les deux finiraient par diverger.
    const s = redigerSms(message());

    expect(s.perdus).toEqual([]);
    expect(s.texte).toContain("2 000 F CFA");
  });

  it("signale en revanche ce qu'aucun repli ne sait rendre", () => {
    const s = redigerSms(message({ offre: "Pass 🔥" }));

    expect(s.perdus).toEqual(["🔥"]);
  });

  it("coupe le nom de l'offre, jamais le lien", () => {
    // La règle absolue. Un SMS trop long coûte un segment de plus ; un lien
    // tronqué ne mène nulle part, et c'est la relance la plus chère de
    // l'échelle qui devient inutile.
    const long = "Abonnement intégral à la plateforme des créateurs indépendants de Côte d'Ivoire et du Sénégal";
    const s = redigerSms(message({ offre: long }));

    expect(s.segments).toBe(1);
    expect(s.tronque).toBe(true);
    expect(s.texte).toContain("https://ndank.test/valider/ab-1");
    expect(s.texte).not.toContain(long);
    // Il reste de quoi reconnaître l'offre.
    expect(s.texte).toContain("Abonnement intégral");
  });

  it("garde le lien entier même quand lui seul fait déborder", () => {
    // Deux segments, et l'hôte le voit. C'est le prix d'un lien qui fonctionne.
    const enorme = `https://ndank.test/valider/${"a".repeat(200)}`;
    const s = redigerSms(message({ lien: enorme }));

    expect(s.texte).toContain(enorme);
    expect(s.segments).toBeGreaterThan(1);
    expect(s.tronque).toBe(true);
  });

  it("respecte un budget de segments élargi quand l'hôte en demande un", () => {
    const long = "Abonnement intégral à la plateforme des créateurs indépendants de Côte d'Ivoire et du Sénégal";

    const serre = redigerSms(message({ offre: long }), 1);
    const large = redigerSms(message({ offre: long }), 2);

    expect(segments(serre.texte)).toBe(1);
    expect(segments(large.texte)).toBeLessThanOrEqual(2);
    expect(large.texte.length).toBeGreaterThan(serre.texte.length);
  });

  it("ne salue pas : chaque septet compte", () => {
    const s = redigerSms(message());

    expect(s.texte).not.toContain("Bonjour");
  });
});

describe("la notification", () => {
  it("garde le suffixe qui distingue les paliers, et abrège l'offre", () => {
    // Le système coupe un titre trop long sans prévenir. Raccourcir par la fin
    // effacerait « dernier rappel », c'est-à-dire exactement ce qui distingue
    // cette notification de la précédente.
    const p = redigerPush(
      message({
        offre: "Abonnement intégral à la plateforme des créateurs",
        dernier: true,
      }),
    );

    expect(p.titre).toContain("dernier rappel");
    expect(p.titre).toContain("Abonnement");
    expect(p.titre.length).toBeLessThanOrEqual(LIMITE_TITRE + 2);
  });

  it("porte la clé de relance, pour remplacer plutôt qu'empiler", () => {
    expect(redigerPush(message()).identifiant).toBe("2026-02-09:1");
  });

  it("dit la suspension quand l'accès est tombé", () => {
    const p = redigerPush(message({ joursRestants: -4 }));

    expect(p.titre).toContain("accès suspendu");
    expect(p.corps).toContain("pour reprendre");
  });

  it("mène au même lien que les autres canaux", () => {
    expect(redigerPush(message()).lien).toBe("https://ndank.test/valider/ab-1");
  });
});

describe("le délai", () => {
  it("dit les jours comme on les dit", () => {
    expect(delai(5)).toBe("dans 5 jours");
    expect(delai(1)).toBe("demain");
    expect(delai(0)).toBe("aujourd'hui");
    expect(delai(-1)).toBe("depuis hier");
    expect(delai(-4)).toBe("depuis 4 jours");
  });

  it("abrège pour le SMS, où quatre septets valent quatre caractères d'offre", () => {
    expect(delai(5, true)).toBe("dans 5 j");
    expect(delai(-4, true)).toBe("depuis 4 j");
    // Ceux-là ne s'abrègent pas : ils sont déjà courts, et « demain » n'a pas
    // de forme brève qui reste lisible.
    expect(delai(1, true)).toBe("demain");
    expect(delai(0, true)).toBe("aujourd'hui");
  });
});
