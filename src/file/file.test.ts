import { describe, expect, it } from "vitest";

import type { RequeteWeb } from "../web";
import { fileEnMemoire } from "./memoire";
import { routeurFile, type FaitFile } from "./routeur";
import { versLaFile } from "./transporteur";

const AWA = { nom: "Awa", courriel: null, telephone: "+2250718350482", appareils: [] };
const SMS = {
  texte: "Pass Créateur : 2 000 XOF à régler. https://p.ci/v/abc",
  segments: 1,
  perdus: [],
  tronque: false,
};
const JETON = "jeton-de-l-appareil";
const T = new Date("2026-09-05T02:00:00Z");

/** Une horloge qu'on avance, et une attente qui l'avance. */
function horloge(depart: Date = T) {
  let t = depart.getTime();
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

function get(chemin: string, parametres: Record<string, string> = {}): RequeteWeb {
  return {
    methode: "GET",
    chemin,
    parametres,
    corps: "",
    entetes: { authorization: `Bearer ${JETON}` },
  };
}

function post(chemin: string, corps: unknown): RequeteWeb {
  return {
    methode: "POST",
    chemin,
    parametres: {},
    corps: JSON.stringify(corps),
    entetes: { authorization: `Bearer ${JETON}` },
  };
}

describe("déposer plutôt qu'appeler", () => {
  it("met le message en file et rend son identifiant", async () => {
    const h = horloge();
    const file = fileEnMemoire();
    const sms = versLaFile({ file, ...h, identifiant: () => "m-1" });

    const remise = await sms.envoyer(AWA, SMS);

    expect(remise).toEqual({ parti: true, reference: "m-1" });
    expect(file.contenu()).toHaveLength(1);
    expect(file.contenu()[0]!.telephone).toBe("+2250718350482");
    expect(file.contenu()[0]!.texte).toBe(SMS.texte);
  });

  it("n'appelle aucune passerelle, donc ne peut pas être ralenti par une", async () => {
    // C'est le gain du renversement : le passage quotidien ne dépend plus de la
    // disponibilité d'un téléphone.
    const h = horloge();
    const sms = versLaFile({ file: fileEnMemoire(), ...h });

    await sms.envoyer(AWA, SMS);

    expect(h.attentes).toHaveLength(0);
  });

  it("pose une péremption, parce qu'un rappel en retard dit le contraire", async () => {
    // Un téléphone rallumé après trois jours viderait sa file d'un coup :
    // l'abonné recevrait « accès coupé dans 7 jours » le jour où il est coupé.
    const h = horloge();
    const file = fileEnMemoire();
    await versLaFile({ file, ...h, valableSecondes: 3600 }).envoyer(AWA, SMS);

    expect(file.contenu()[0]!.expireLe).toEqual(new Date(T.getTime() + 3_600_000));
  });

  it("ne dépose rien pour quelqu'un sans numéro", async () => {
    const file = fileEnMemoire();
    const remise = await versLaFile({ file }).envoyer({ ...AWA, telephone: null }, SMS);

    expect(remise).toEqual({ parti: false, reference: null });
    expect(file.contenu()).toHaveLength(0);
  });
});

describe("le long-polling", () => {
  it("rend la main tout de suite quand la file n'est pas vide", async () => {
    // L'appareil ne doit pas attendre un intervalle de sondage pour rien.
    const h = horloge();
    const file = fileEnMemoire();
    await versLaFile({ file, ...h, identifiant: () => "m-1" }).envoyer(AWA, SMS);

    const routeur = routeurFile({ file, jeton: JETON, ...h });
    const r = await routeur(get("/attente"));

    expect(r.statut).toBe(200);
    expect(h.attentes).toHaveLength(0);
    expect(JSON.parse(r.corps)[0].id).toBe("m-1");
  });

  it("suspend la requête quand elle est vide, puis rend 204", async () => {
    const h = horloge();
    const routeur = routeurFile({
      file: fileEnMemoire(),
      jeton: JETON,
      attenteMax: 25,
      sondage: 250,
      ...h,
    });

    const r = await routeur(get("/attente"));

    expect(r.statut).toBe(204);
    // Vingt-cinq secondes par tranches de deux cent cinquante millisecondes.
    expect(h.attentes.length).toBeGreaterThan(90);
    expect(h.attentes.every((a) => a === 250)).toBe(true);
  });

  it("libère dès qu'un message arrive, sans attendre la fin", async () => {
    // C'est ce qui rend le code SMS possible : quelques centaines de
    // millisecondes, et non trente secondes de silence devant un écran.
    const h = horloge();
    const file = fileEnMemoire();
    let tours = 0;

    const routeur = routeurFile({
      file,
      jeton: JETON,
      attenteMax: 25,
      sondage: 250,
      maintenant: h.maintenant,
      attendre: async (ms) => {
        tours += 1;
        // Quelqu'un dépose au troisième tour.
        if (tours === 3) {
          await versLaFile({ file, maintenant: h.maintenant, identifiant: () => "m-9" })
            .envoyer(AWA, SMS);
        }
        await h.attendre(ms);
      },
    });

    const r = await routeur(get("/attente"));

    expect(r.statut).toBe(200);
    expect(JSON.parse(r.corps)[0].id).toBe("m-9");
    // Trois tours, pas cent : on n'a pas attendu la fin de la fenêtre.
    expect(tours).toBe(3);
  });

  it("rend la main immédiatement quand on ne veut pas suspendre", async () => {
    // Le réglage du serverless : tenir une requête ouverte y est facturé.
    const h = horloge();
    const routeur = routeurFile({
      file: fileEnMemoire(),
      jeton: JETON,
      attenteMax: 0,
      ...h,
    });

    expect((await routeur(get("/attente"))).statut).toBe(204);
    expect(h.attentes).toHaveLength(0);
  });

  it("borne la taille du lot à ce que l'hôte a permis", async () => {
    const h = horloge();
    const file = fileEnMemoire();
    const sms = versLaFile({ file, ...h });
    for (let i = 0; i < 30; i++) await sms.envoyer(AWA, SMS);

    const routeur = routeurFile({ file, jeton: JETON, parLot: 5, ...h });

    expect(JSON.parse((await routeur(get("/attente", { max: "99" }))).corps)).toHaveLength(5);
  });
});

describe("le bail, et ce qu'il empêche de perdre", () => {
  it("ne rend pas deux fois le même message à deux appareils", async () => {
    // Sans bail, deux appareils enverraient le même SMS.
    const h = horloge();
    const file = fileEnMemoire();
    await versLaFile({ file, ...h, identifiant: () => "m-1" }).envoyer(AWA, SMS);

    expect(await file.prendre(10, h.maintenant())).toHaveLength(1);
    expect(await file.prendre(10, h.maintenant())).toHaveLength(0);
  });

  it("rend le message quand l'appareil meurt sans acquitter", async () => {
    // Batterie, réseau, processus tué. Sans cela, dix messages disparaîtraient
    // en silence.
    const h = horloge();
    const file = fileEnMemoire({ bailSecondes: 120 });
    await versLaFile({ file, ...h, identifiant: () => "m-1" }).envoyer(AWA, SMS);

    await file.prendre(10, h.maintenant());
    h.avancer(121_000);

    expect(await file.prendre(10, h.maintenant())).toHaveLength(1);
  });

  it("retire un message acquitté comme parti", async () => {
    const h = horloge();
    const file = fileEnMemoire();
    await versLaFile({ file, ...h, identifiant: () => "m-1" }).envoyer(AWA, SMS);
    await file.prendre(10, h.maintenant());

    await file.acquitter([{ id: "m-1", parti: true }], h.maintenant());

    expect(file.contenu()).toHaveLength(0);
  });

  it("remet en file un message que l'appareil n'a pas pu émettre", async () => {
    // Il dit qu'il n'a pas pu, pas que le message n'a plus lieu d'être.
    const h = horloge();
    const file = fileEnMemoire();
    await versLaFile({ file, ...h, identifiant: () => "m-1" }).envoyer(AWA, SMS);
    await file.prendre(10, h.maintenant());

    await file.acquitter(
      [{ id: "m-1", parti: false, cause: "pas de réseau" }],
      h.maintenant(),
    );

    expect(await file.prendre(10, h.maintenant())).toHaveLength(1);
  });

  it("laisse expirer plutôt que de réessayer indéfiniment", async () => {
    const h = horloge();
    const file = fileEnMemoire();
    await versLaFile({ file, ...h, valableSecondes: 3600, identifiant: () => "m-1" })
      .envoyer(AWA, SMS);

    h.avancer(3_601_000);

    expect(await file.prendre(10, h.maintenant())).toHaveLength(0);
    expect(file.contenu()).toHaveLength(0);
  });
});

describe("la profondeur de la file dit ce qu'aucun autre signal ne disait", () => {
  it("montre l'attente sans qu'un seul envoi ait échoué", async () => {
    // La panne du téléphone était invisible jusqu'au passage suivant : il
    // fallait qu'un lot entier échoue pour que `bilan()` s'en aperçoive.
    // Ici, personne ne vient chercher — et cela se voit tout de suite.
    const h = horloge();
    const file = fileEnMemoire();
    const sms = versLaFile({ file, ...h });
    for (let i = 0; i < 12; i++) await sms.envoyer(AWA, SMS);

    h.avancer(1_800_000);
    const s = await file.statistiques!(h.maintenant());

    expect(s.enAttente).toBe(12);
    expect(s.enCours).toBe(0);
    expect(s.attenteMax).toBe(1800);
  });

  it("distingue ce qui attend de ce qui est en cours d'émission", async () => {
    const h = horloge();
    const file = fileEnMemoire();
    const sms = versLaFile({ file, ...h });
    for (let i = 0; i < 5; i++) await sms.envoyer(AWA, SMS);

    await file.prendre(2, h.maintenant());
    const s = await file.statistiques!(h.maintenant());

    expect(s).toMatchObject({ enAttente: 3, enCours: 2 });
  });
});

describe("ce que la route refuse", () => {
  it("refuse de se construire sans jeton", () => {
    // La file porte des numéros, des montants et des liens signés.
    expect(() => routeurFile({ file: fileEnMemoire(), jeton: "" })).toThrow(/jeton/);
  });

  it("refuse un jeton faux", async () => {
    const routeur = routeurFile({ file: fileEnMemoire(), jeton: JETON, ...horloge() });

    const r = await routeur({
      methode: "GET",
      chemin: "/attente",
      parametres: {},
      corps: "",
      entetes: { authorization: "Bearer faux" },
    });

    expect(r.statut).toBe(401);
  });

  it("accepte le jeton en paramètre, pour un appareil qui ne pose pas d'en-tête", async () => {
    const h = horloge();
    const file = fileEnMemoire();
    await versLaFile({ file, ...h, identifiant: () => "m-1" }).envoyer(AWA, SMS);
    const routeur = routeurFile({ file, jeton: JETON, ...h });

    const r = await routeur({
      methode: "GET",
      chemin: "/attente",
      parametres: { jeton: JETON },
      corps: "",
      entetes: {},
    });

    expect(r.statut).toBe(200);
  });

  it("refuse un corps d'accusés qui n'en est pas un", async () => {
    const routeur = routeurFile({ file: fileEnMemoire(), jeton: JETON, ...horloge() });

    expect((await routeur(post("/accuses", { pas: "un tableau" }))).statut).toBe(400);
  });

  it("ne met rien en cache, jamais", async () => {
    // Numéros et liens signés : rien ne doit finir dans un cache intermédiaire.
    const h = horloge();
    const routeur = routeurFile({ file: fileEnMemoire(), jeton: JETON, attenteMax: 0, ...h });

    expect((await routeur(get("/attente"))).entetes["Cache-Control"]).toBe("no-store");
  });

  it("dit où aller quand la route n'existe pas", async () => {
    const routeur = routeurFile({ file: fileEnMemoire(), jeton: JETON, ...horloge() });
    const r = await routeur(get("/nimporte"));

    expect(r.statut).toBe(404);
    expect(r.corps).toContain("/attente");
  });
});

describe("le tour complet", () => {
  it("dépose, prend, émet, acquitte", async () => {
    const h = horloge();
    const file = fileEnMemoire();
    const faits: FaitFile[] = [];
    const routeur = routeurFile({
      file,
      jeton: JETON,
      journal: (f) => faits.push(f),
      ...h,
    });

    // 1 — le passage quotidien dépose deux relances.
    const sms = versLaFile({ file, ...h });
    await sms.envoyer(AWA, SMS);
    await sms.envoyer({ ...AWA, telephone: "+2250769630987" }, SMS);

    // 2 — l'appareil vient chercher.
    const lot = JSON.parse((await routeur(get("/attente"))).corps) as Array<{
      id: string;
      telephone: string;
    }>;
    expect(lot).toHaveLength(2);
    expect(lot.map((m) => m.telephone)).toEqual([
      "+2250718350482",
      "+2250769630987",
    ]);

    // 3 — il émet, et rapporte. Le second n'est pas passé.
    await routeur(
      post("/accuses", [
        { id: lot[0]!.id, parti: true, reference: "SMS-1" },
        { id: lot[1]!.id, parti: false, cause: "pas de réseau" },
      ]),
    );

    // 4 — le premier est clos, le second attend son tour suivant.
    expect(file.contenu()).toHaveLength(1);
    expect(await file.prendre(10, h.maintenant())).toHaveLength(1);

    expect(faits).toEqual([
      { quoi: "PRIS", combien: 2 },
      { quoi: "ACQUITTE", partis: 1, echoues: 1 },
    ]);
  });
});
