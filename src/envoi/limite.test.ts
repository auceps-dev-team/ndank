import { describe, expect, it } from "vitest";

import { limiter } from "./limite";
import type { Remise, TransporteurSms } from "./port";

const AWA = { nom: "Awa", courriel: null, telephone: "+2250700000000", appareils: [] };
const SMS = { texte: "Pass Créateur : 2 000 XOF.", segments: 1, perdus: [], tronque: false };

/** Une horloge qu'on avance à la main, et une attente qui l'avance. */
function horlogeFausse(depart = "2026-09-05T02:00:00Z") {
  let t = new Date(depart).getTime();
  const attentes: number[] = [];

  return {
    attentes,
    maintenant: () => new Date(t),
    attendre: async (ms: number) => {
      attentes.push(ms);
      t += ms;
    },
    avancer: (ms: number) => {
      t += ms;
    },
  };
}

function fauxTransporteur(remise: Partial<Remise> = {}): TransporteurSms & {
  appels: number;
} {
  const t = {
    nom: "faux",
    canal: "sms" as const,
    appels: 0,
    async envoyer(): Promise<Remise> {
      t.appels += 1;
      return { parti: true, reference: `m-${t.appels}`, ...remise };
    },
  };
  return t;
}

describe("l'espacement", () => {
  it("laisse passer le premier sans attendre", async () => {
    // Rien à espacer d'un message précédent qui n'existe pas.
    const h = horlogeFausse();
    const sms = limiter(fauxTransporteur(), { ...h, parMinute: 10 });

    await sms.envoyer(AWA, SMS);

    expect(h.attentes).toHaveLength(0);
  });

  it("attend entre deux envois rapprochés", async () => {
    const h = horlogeFausse();
    const sms = limiter(fauxTransporteur(), { ...h, parMinute: 10, hasard: 0 });

    await sms.envoyer(AWA, SMS);
    await sms.envoyer(AWA, SMS);

    // Dix par minute : six secondes entre deux.
    expect(h.attentes).toHaveLength(1);
    expect(h.attentes[0]).toBe(6000);
  });

  it("n'attend pas si le temps a déjà passé", async () => {
    // Le cas d'un passage lent : si l'envoi précédent remonte à dix secondes,
    // rien ne justifie d'en ajouter six.
    const h = horlogeFausse();
    const sms = limiter(fauxTransporteur(), { ...h, parMinute: 10, hasard: 0 });

    await sms.envoyer(AWA, SMS);
    h.avancer(10_000);
    await sms.envoyer(AWA, SMS);

    expect(h.attentes).toHaveLength(0);
  });

  it("fait varier l'attente, parce qu'une cadence parfaite est une signature", async () => {
    // Un message exactement toutes les six secondes ne ressemble à rien
    // d'humain. Le hasard coûte zéro et retire ce motif.
    const h = horlogeFausse();
    const sms = limiter(fauxTransporteur(), { ...h, parMinute: 10, hasard: 0.3 });

    for (let i = 0; i < 40; i++) await sms.envoyer(AWA, SMS);

    const uniques = new Set(h.attentes);
    expect(uniques.size).toBeGreaterThan(30);

    for (const a of h.attentes) {
      expect(a).toBeGreaterThanOrEqual(4200);
      expect(a).toBeLessThanOrEqual(7800);
    }
  });

  it("n'espace rien quand on ne lui demande pas de débit", async () => {
    const h = horlogeFausse();
    const sms = limiter(fauxTransporteur(), { ...h, parMinute: 0 });

    await sms.envoyer(AWA, SMS);
    await sms.envoyer(AWA, SMS);

    expect(h.attentes).toHaveLength(0);
  });

  it("date même un envoi refusé par la passerelle", async () => {
    // C'est le rythme des appels que l'opérateur observe, pas leur succès.
    const h = horlogeFausse();
    const t = fauxTransporteur({ parti: false, reference: null });
    const sms = limiter(t, { ...h, parMinute: 10, hasard: 0 });

    await sms.envoyer(AWA, SMS);
    await sms.envoyer(AWA, SMS);

    expect(h.attentes).toEqual([6000]);
  });
});

describe("le plafond du jour", () => {
  it("refuse au-delà, sans lever", async () => {
    // Lever ferait de l'abonnement entier un incident. Rendre `false` laisse le
    // moteur essayer le barreau suivant, et ne note pas la relance.
    const h = horlogeFausse();
    const t = fauxTransporteur();
    const sms = limiter(t, { ...h, parMinute: 0, parJour: 3 });

    const issues: boolean[] = [];
    for (let i = 0; i < 5; i++) issues.push((await sms.envoyer(AWA, SMS)).parti);

    expect(issues).toEqual([true, true, true, false, false]);
    expect(t.appels).toBe(3);
  });

  it("prévient qui veut le savoir", async () => {
    const h = horlogeFausse();
    const refus: Array<{ envoyesAujourdhui: number; plafond: number }> = [];
    const sms = limiter(fauxTransporteur(), {
      ...h,
      parMinute: 0,
      parJour: 1,
      surRefus: (f) => refus.push(f),
    });

    await sms.envoyer(AWA, SMS);
    await sms.envoyer(AWA, SMS);

    expect(refus).toEqual([{ envoyesAujourdhui: 1, plafond: 1 }]);
  });

  it("ne compte que ce qui est parti", async () => {
    // Un plafond entamé par des échecs se refermerait sur des messages jamais
    // émis — et l'hôte paierait un quota qu'il n'a pas consommé.
    const h = horlogeFausse();
    const t = fauxTransporteur({ parti: false, reference: null });
    const sms = limiter(t, { ...h, parMinute: 0, parJour: 2 });

    for (let i = 0; i < 5; i++) await sms.envoyer(AWA, SMS);

    expect(t.appels).toBe(5);
  });

  it("repart à zéro au jour civil suivant", async () => {
    const h = horlogeFausse("2026-09-05T22:00:00Z");
    const t = fauxTransporteur();
    const sms = limiter(t, { ...h, parMinute: 0, parJour: 2 });

    await sms.envoyer(AWA, SMS);
    await sms.envoyer(AWA, SMS);
    expect((await sms.envoyer(AWA, SMS)).parti).toBe(false);

    // Minuit passé, le compteur est neuf.
    h.avancer(3 * 3_600_000);
    expect((await sms.envoyer(AWA, SMS)).parti).toBe(true);
  });

  it("ne plafonne rien quand on ne lui donne pas de plafond", async () => {
    // Il n'existe pas de valeur raisonnable universelle : elle dépend du
    // forfait, de l'opérateur et du pays. En poser une d'office donnerait une
    // fausse sécurité à qui ne l'a pas choisie.
    const h = horlogeFausse();
    const t = fauxTransporteur();
    const sms = limiter(t, { ...h, parMinute: 0 });

    for (let i = 0; i < 50; i++) await sms.envoyer(AWA, SMS);

    expect(t.appels).toBe(50);
  });
});

describe("ce que le décorateur préserve", () => {
  it("garde le nom et le canal, pour que rien en aval ne change", async () => {
    const sms = limiter(fauxTransporteur(), { parMinute: 0 });

    expect(sms.nom).toBe("faux");
    expect(sms.canal).toBe("sms");
  });

  it("garde `disponible`, et ne consomme pas de quota pour un refus", async () => {
    // Un transporteur qui refuse un numéro mal formé doit continuer à le
    // refuser — et sans entamer le plafond, puisque rien ne part.
    const base: TransporteurSms = {
      nom: "faux",
      canal: "sms",
      disponible: (ou) => ou.telephone?.startsWith("+225") ?? false,
      async envoyer() {
        return { parti: true, reference: "m" };
      },
    };

    const sms = limiter(base, { parMinute: 0, parJour: 1 });

    expect(sms.disponible!(AWA)).toBe(true);
    expect(sms.disponible!({ ...AWA, telephone: "+33600000000" })).toBe(false);
  });

  it("n'ajoute pas `disponible` à un transporteur qui n'en a pas", async () => {
    // `joignable` doit continuer à décider seul : en inventer un ici changerait
    // le comportement du composeur sans que personne ne l'ait demandé.
    const sms = limiter(fauxTransporteur(), { parMinute: 0 });

    expect(sms.disponible).toBeUndefined();
  });
});
