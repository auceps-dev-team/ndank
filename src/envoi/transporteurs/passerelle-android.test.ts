import { describe, expect, it } from "vitest";

import type { Http, Requete } from "../../http";
import {
  etatDuMessage,
  passerelleAndroid,
} from "./passerelle-android";

const CONFIG = {
  base: "http://192.168.1.42:8080",
  utilisateur: "sms",
  motDePasse: "secret",
};

const AWA = {
  nom: "Awa",
  courriel: null,
  telephone: "+2250700000000",
  appareils: [],
};

const SMS = {
  texte: "Pass Créateur : 2 000 XOF. https://p.ci/v/abc",
  segments: 1,
  perdus: [],
  tronque: false,
};

function fausseHttp(reponses: Array<{ statut?: number; corps: unknown }>) {
  const vues: Requete[] = [];
  let i = 0;

  const http: Http = async (requete) => {
    vues.push(requete);
    const r = reponses[i++] ?? { corps: {} };
    return { statut: r.statut ?? 200, corps: JSON.stringify(r.corps) };
  };

  return { http, vues };
}

describe("la passerelle Android", () => {
  it("poste le message et rend l'identifiant de la passerelle", async () => {
    const f = fausseHttp([{ corps: { id: "zXDYfTm", state: "Pending" } }]);

    const remise = await passerelleAndroid({ ...CONFIG, http: f.http }).envoyer(
      AWA,
      SMS,
    );

    expect(remise).toEqual({ parti: true, reference: "zXDYfTm" });
    expect(f.vues[0]!.url).toBe(
      "http://192.168.1.42:8080/3rdparty/v1/messages",
    );

    const corps = JSON.parse(f.vues[0]!.corps!);
    expect(corps.textMessage.text).toBe(SMS.texte);
    expect(corps.phoneNumbers).toEqual(["+2250700000000"]);
  });

  it("s'authentifie en Basic, comme l'application le demande", async () => {
    const f = fausseHttp([{ corps: { id: "x", state: "Pending" } }]);

    await passerelleAndroid({ ...CONFIG, http: f.http }).envoyer(AWA, SMS);

    const attendu = `Basic ${Buffer.from("sms:secret").toString("base64")}`;
    expect(f.vues[0]!.entetes["Authorization"]).toBe(attendu);
  });

  it("pose une durée de vie, pour qu'un rappel en retard n'arrive pas", async () => {
    // Un rappel qui part trois jours plus tard, parce que le téléphone était
    // éteint, arrive après le message suivant et dit le contraire.
    const f = fausseHttp([{ corps: { id: "x", state: "Pending" } }]);

    await passerelleAndroid({ ...CONFIG, http: f.http }).envoyer(AWA, SMS);

    expect(JSON.parse(f.vues[0]!.corps!).ttl).toBe(86_400);
  });

  it("compte `Pending` comme parti", async () => {
    // Rendre `false` ferait essayer le canal suivant du palier — donc envoyer
    // deux fois quand le téléphone se rallume une minute plus tard.
    const f = fausseHttp([{ corps: { id: "x", state: "Pending" } }]);

    expect(
      (await passerelleAndroid({ ...CONFIG, http: f.http }).envoyer(AWA, SMS))
        .parti,
    ).toBe(true);
  });

  it("ne compte pas un échec rendu dès l'envoi", async () => {
    // Le noter comme parti ferait que le moteur ne réessaierait jamais : la
    // relance serait inscrite au journal des envois réussis.
    const f = fausseHttp([
      { corps: { id: "x", state: "Failed", reason: "Invalid number" } },
    ]);

    expect(
      (await passerelleAndroid({ ...CONFIG, http: f.http }).envoyer(AWA, SMS))
        .parti,
    ).toBe(false);
  });

  it("n'envoie rien à quelqu'un sans numéro, plutôt que d'appeler pour rien", async () => {
    const f = fausseHttp([]);

    const remise = await passerelleAndroid({ ...CONFIG, http: f.http }).envoyer(
      { ...AWA, telephone: null },
      SMS,
    );

    expect(remise).toEqual({ parti: false, reference: null });
    expect(f.vues).toHaveLength(0);
  });

  it("choisit la SIM et l'appareil quand on les lui donne", async () => {
    const f = fausseHttp([{ corps: { id: "x", state: "Pending" } }]);

    await passerelleAndroid({
      ...CONFIG,
      appareil: "yVULogr4",
      sim: 2,
      http: f.http,
    }).envoyer(AWA, SMS);

    const corps = JSON.parse(f.vues[0]!.corps!);
    expect(corps.deviceId).toBe("yVULogr4");
    expect(corps.simNumber).toBe(2);
  });

  it("les omet quand on ne les donne pas", async () => {
    // Un `deviceId: undefined` sérialisé deviendrait absent, mais un
    // `simNumber: null` serait envoyé — et la passerelle le refuserait.
    const f = fausseHttp([{ corps: { id: "x", state: "Pending" } }]);

    await passerelleAndroid({ ...CONFIG, http: f.http }).envoyer(AWA, SMS);

    const corps = JSON.parse(f.vues[0]!.corps!);
    expect("deviceId" in corps).toBe(false);
    expect("simNumber" in corps).toBe(false);
  });

  it("ne double pas la barre oblique de l'adresse", async () => {
    const f = fausseHttp([{ corps: { id: "x", state: "Pending" } }]);

    await passerelleAndroid({
      ...CONFIG,
      base: "https://api.sms-gate.app/",
      http: f.http,
    }).envoyer(AWA, SMS);

    expect(f.vues[0]!.url).toBe("https://api.sms-gate.app/3rdparty/v1/messages");
  });
});

describe("relire l'état d'un message", () => {
  it("dit `remis` seulement sur `Delivered`", async () => {
    // C'est le seul canal de Ndank où « reçu » a une réponse. Chez Resend et
    // chez Twilio, « parti » veut dire « accepté » et rien de plus.
    const f = fausseHttp([{ corps: { id: "zX", state: "Delivered" } }]);

    const etat = await etatDuMessage({ ...CONFIG, http: f.http }, "zX");

    expect(etat.remis).toBe(true);
    expect(f.vues[0]!.methode).toBe("GET");
    expect(f.vues[0]!.url).toContain("/3rdparty/v1/messages/zX");
  });

  it("ne confond pas `Sent` avec `Delivered`", async () => {
    // `Sent` veut dire que le centre SMS a accepté — pas que quelqu'un l'a eu.
    const f = fausseHttp([{ corps: { id: "zX", state: "Sent" } }]);

    expect((await etatDuMessage({ ...CONFIG, http: f.http }, "zX")).remis).toBe(
      false,
    );
  });

  it("rapporte la raison d'un échec, quand la passerelle la donne", async () => {
    const f = fausseHttp([
      { corps: { id: "zX", state: "Failed", reason: "Invalid number" } },
    ]);

    const etat = await etatDuMessage({ ...CONFIG, http: f.http }, "zX");

    expect(etat.etat).toBe("Failed");
    expect(etat.raison).toBe("Invalid number");
    expect(etat.remis).toBe(false);
  });
});
