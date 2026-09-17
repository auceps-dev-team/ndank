# L'espace abonné

> La projection multi-sites, la connexion par code, et les permissions.
>
> [← Retour au README](../README.md)

---

# Voir tous ses abonnements, d'un site à l'autre

C'est la seule question de ce dépôt qui ne puisse pas se répondre chez le
marchand. Un abonné chez trois hôtes est trois lignes, dans trois bases, que
rien ne rapproche — et aucun des trois hôtes ne connaît les deux autres.

```ts
import { projectionDe, pousser } from "ndank/projection";

const lignes = abonnements
  .map((a) => projectionDe(a, { site: "Baobart", poivre, lien }))
  .filter((l) => l !== null);

await pousser(lignes, { base, jeton, poivre, site: "Baobart" });
```

Ce qui reste chez l'hôte : l'argent, les versements, les webhooks, les
coordonnées complètes. Ce qui part : de quoi afficher une carte.

**On envoie des dates, jamais un état.** `etatDe` est la seule autorité sur ce
qu'est un abonnement suspendu, et Ndank App l'applique aux dates reçues. Envoyer
un état calculé chez l'hôte ferait qu'un abonné lirait « à jour » chez lui et
« suspendu » chez le marchand, selon la fraîcheur de la dernière poussée.

Un lot qui échoue n'emporte pas les autres, même règle que le passage quotidien
et pour la même raison : la poussée suivante rattrapera.

## L'empreinte n'est pas de l'anonymisation

Il faut le dire sans détour, parce que le contraire se croit facilement.

Un numéro de téléphone vit dans un espace minuscule — quelques milliards de
valeurs — et quiconque tient le poivre peut en dresser la table complète en
quelques heures. Une empreinte de numéro se retrouve, toujours. Et le poivre est
**partagé** entre Ndank App et tous les hôtes : il le faut, puisque l'hôte doit
calculer l'empreinte pour la pousser et Ndank App doit la recalculer quand
l'abonné se connecte. Il fuit donc avec n'importe lequel d'entre eux.

Ce qu'elle fait quand même, et qui n'est pas rien : une copie de la base de Ndank
App, prise sans le poivre, ne livre pas un annuaire.

**Ndank App détient donc des données personnelles** pour le compte de plusieurs
marchands, et l'empreinte ne l'en dispense pas. Elle réduit l'exposition
accidentelle, pas l'attaque décidée.

## Une empreinte peut aussi porter une adresse, et cela a une suite

`projectionDe` prend le téléphone **ou**, à défaut, le courriel. Un abonné
qu'un hôte n'a inscrit que par adresse reste donc visible dans la vue
multi-sites, au lieu de disparaître.

C'est voulu, et cela crée une obligation en face : **une application qui ne sait
connecter que par code SMS laissera ces abonnés devant une carte qu'ils ne
peuvent pas atteindre.** Qui reçoit la projection doit donc soit accepter aussi
la connexion par courriel, soit ne pas projeter les abonnés sans numéro.

## Les numéros doivent être en E.164, et Ndank refuse le reste

`normaliserIdentifiant` lève sur un numéro qui ne commence pas par `+`.

C'est délibéré, et c'est la panne qu'on ne voit jamais autrement : un hôte qui
range « 0700000000 » et un autre « +2250700000000 » donneraient deux identités à
la même personne, et la vue multi-sites n'afficherait qu'une carte sur deux —
sans erreur, sans trace, sans que personne ne sache quoi chercher.

Et l'on ne peut pas deviner l'indicatif manquant : `+225` est une hypothèse qui a
l'air raisonnable jusqu'au premier abonné sénégalais. L'hôte, lui, sait le sien,
et il a déjà `enE164`.

## Un receveur ne doit rendre aucun champ obligatoire

Les hôtes ne montent pas de version en même temps. Un champ ajouté au contrat —
`offreId` est arrivé en 0.24 — n'est simplement **pas dans le corps** que pousse
un hôte resté en 0.23.

`Projection.offreId` est déclaré `string | null` : requis et nullable en
TypeScript, parce que c'est ce qu'un receveur veut lire. Mais **sur le fil, la
clé est absente**, et ce ne sont pas les mêmes choses.

Un schéma d'entrée qui exigerait la clé refuserait donc la poussée de tout hôte
en retard. Et le refus est silencieux du mauvais côté : **l'hôte voit un 400
sans savoir ce qui a changé**, puisque rien n'a changé chez lui.

La forme qui tient les deux, avec zod :

```ts
offreId: z.string().nullable().default(null)
```

`default` sépare le type d'entrée du type de sortie : facultatif sur le fil,
`string | null` après analyse — donc un contrôle d'égalité de types entre le
corps reçu et `Projection` reste satisfait. Permissif à l'exécution, strict à la
compilation.

La règle vaut pour tout champ qu'on ajoutera ensuite, pas seulement celui-là.
Relevé par Ndank App en posant `offreId`, avant que le piège ne se referme.

**Et aucune migration n'est nécessaire** : les lignes déjà reçues restent à
`null` jusqu'à la prochaine poussée de chaque hôte. La projection se rafraîchit
d'elle-même.

# Le code SMS

```ts
import { engendrer, verificateur } from "ndank/code";

const code = engendrer(secret, "+2250700000000");
// → « 481207 », à envoyer par SMS

const verifier = verificateur({ secret, tentatives });
await verifier("+2250700000000", saisi);
// → { issue: "OUVERT" } | { issue: "REFUSE", restants } | { issue: "BLOQUE" }
```

Le code se dérive de `HMAC(secret, identifiant + fenêtre)` plutôt que de se tirer
au sort et de se ranger quelque part : pas de table à écrire, pas de purge à
programmer, pas de code oublié en base six mois plus tard. C'est la construction
de la RFC 4226, avec une fenêtre de temps à la place du compteur. Il vaut entre
cinq et dix minutes — la vérification accepte aussi la fenêtre précédente, sans
quoi un code émis à la fin d'une fenêtre serait mort avant que le SMS n'arrive.

**Six chiffres font un million de possibilités, ce qui se parcourt en quelques
secondes.** Le code ne protège donc rien par lui-même ; ce qui protège, c'est le
nombre d'essais. `Tentatives` n'est pas optionnel et `verificateur()` refuse de
se construire sans lui : un port qu'on peut omettre finit par être omis, et l'on
découvre le jour de l'incident que la fonction qu'on croyait sûre ne l'était que
dans les exemples.

## Ne construisez pas le vérificateur au chargement du module

```ts
// ✗ s'évalue à l'import
const verifier = verificateur({ secret: secretDuCode(), tentatives });

// ✓ s'évalue à l'appel
const verifier = (id: string, code: string) =>
  verificateur({ secret: secretDuCode(), tentatives })(id, code);
```

`verificateur()` est une fabrique : elle lit son secret quand on l'appelle. Si
la fonction qui fournit ce secret lève quand la variable d'environnement manque
— ce qu'elle devrait faire — alors la placer au niveau du module fait lever à
**l'import**.

Le piège n'apparaît pas au développement, où le secret est posé. Il apparaît à
la construction : un `next build` charge chaque route pour en collecter les
métadonnées, et échoue sur un secret de production qui n'a rien à faire là.
L'erreur parle du secret, jamais du moment.

Relevé par l'écriture de Ndank App, qui l'a rencontré en montant sa connexion
abonné.

# Les permissions

```ts
import { permissionsDe, peut, peutVoir, pourquoiPas } from "ndank/permissions";

const verdict = permissionsDe(
  [{ offreId: "socle", abonnement, libelle: "Pass Créateur" }],
  { droits: { socle: ["lire", "publier"] }, impaye: "LECTURE" },
);

peut(verdict, "publier");                        // écrire
peutVoir(verdict, "publier");                    // au moins consulter
pourquoiPas(verdict, "exporter", reglages);      // pourquoi CE droit-là est refusé
verdict.motif;                                   // pourquoi l'accès est diminué
```

## Deux questions, et il faut les deux

`motif` explique pourquoi l'**accès** est diminué. `peut()` répond **par droit**.
Elles ne coïncident pas, et c'est par là qu'un mur revenait : un abonné
parfaitement à jour à qui l'on demande un droit que son palier ne comprend pas
recevait `false` et `motif: null` — donc rien à lui dire.

`pourquoiPas` couvre ce cas, et distingue trois refus qui n'appellent pas la
même phrase :

```
Vous pouvez consulter, pas modifier.
Pass Créateur est à renouveler depuis 10 jours. Le paiement rouvre l'accès.
Votre abonnement ne comprend pas cette fonctionnalité. Elle est incluse dans : option.
```

**Dire « renouvelez » à quelqu'un dont le palier ne comprend pas la
fonctionnalité l'enverrait payer pour rien.**

**Ndank ne sait pas ce qu'est un droit.** « publier », « exporter » sont des mots
de l'hôte ; la bibliothèque décide seulement lesquels sont encore valables,
d'après l'état des abonnements. Une offre absente de la table ne donne rien —
ajouter un palier sans lui donner de droits doit produire un abonné qui ne peut
rien, pas un abonné qui peut tout.

## Trois niveaux, et non un booléen

`accesOuvert` répond déjà par oui ou non. Ce module existe parce que cette
question, seule, mène à une cruauté banale : **un abonné qui cesse de payer a
écrit des choses.** Lui rendre son propre travail invisible le jour où son
paiement échoue, c'est le punir d'un incident de carte.

D'où `LECTURE` — voir ce qui existe, n'en créer rien de plus. Ce n'est pas de la
générosité : quelqu'un qui peut encore consulter son compte revient le régler.

Le défaut reste pourtant `AUCUN`, pour rester d'accord avec `accesOuvert` : deux
fonctions de la même bibliothèque ne doivent pas se contredire sur la même
question. Passer en lecture tient en une ligne, `{ impaye: "LECTURE" }`.

## La grâce donne le plein accès

`A_RENOUVELER` veut dire « on relance, l'accès tient ». Diminuer les droits à ce
moment-là viderait la grâce de son sens — elle existe pour que celui qui a passé
le week-end hors réseau ne perde rien pour deux jours de retard.

Et **résilier n'est pas confisquer**, ici comme ailleurs : un résilié qui a payé
jusqu'au 30 garde ses droits pleins jusqu'au 30.

## Quatre réglages, parce qu'il y a quatre situations

`impaye`, `suspendu`, `resilie`, `expire` — et chacun existe parce que le
regrouper effacerait une distinction qui compte pour la personne en face.

## Une suspension n'est pas un impayé

`etatDe` rend `SUSPENDUE` dans les deux cas — le marchand a suspendu, ou la grâce
est épuisée. Le mot est le même ; la situation ne l'est pas. Le premier est une
sanction, le second un retard, et l'abonné réglera peut-être demain.

D'où deux réglages séparés, `suspendu` et `impaye`. Les confondre, c'est
infliger à quelqu'un dont la carte a expiré ce qu'on réserve à quelqu'un qui a
fraudé.

Et **résilier n'est pas expirer**, pour la même raison d'un cran plus loin :
résilier est une décision, laisser expirer est un oubli. Quelqu'un qui a cliqué
« résilier » a dit ce qu'il voulait ; quelqu'un dont l'abonnement s'est éteint
tout seul n'a rien dit du tout. D'où `resilie`, distinct de `expire` — le module
faisait cette distinction deux fois et l'oubliait la troisième.

## Où vit la table des droits, et pourquoi pas dans `Offre`

Non pas pour ne pas « mélanger la grille tarifaire et la sémantique » — c'est
vrai et faible. Le vrai départage est le **rythme de changement** : la table des
droits bouge quand le code bouge, une fonctionnalité neuve appelant un droit
neuf ; la grille bouge quand le commerce bouge.

Les réunir voudrait dire qu'un déploiement de code exige une migration de
données, et qu'ajouter un palier tarifaire exige un développeur.

**Un obstacle à connaître si vous visez l'espace abonné** : `Porteur.offreId`
attend `Offre.id`, et la projection ne le transporte pas — `Projection.offre`
est un nom d'affichage, `Projection.reference` l'identifiant de l'abonnement. Un
receveur de projections ne peut donc pas indexer la table des droits
aujourd'hui. C'est un champ à ajouter au contrat, pas un argument pour déplacer
les droits.

## Le motif porte un geste

« Accès refusé » est la phrase qui fait écrire au support : l'abonné ne sait pas
s'il a oublié de payer, s'il est suspendu, ou si le service est en panne.

```
Pass Créateur est à renouveler depuis 10 jours. Le paiement rouvre l'accès
immédiatement.

Pass Créateur est suspendu depuis 2 jours. Contactez le service client — une
suspension se lève à la main.
```

Le second ne parle pas de paiement, et c'est délibéré : payer ne lèvera pas une
suspension.

## Plusieurs abonnements s'additionnent

Quelqu'un peut tenir un socle à jour et une option en retard. Ne garder que le
« meilleur » lui retirerait ce que l'autre lui donne : les droits s'additionnent,
et un droit accordé en plein par l'un et en lecture par l'autre reste plein.

**Rien n'est stocké.** Comme `etatDe`, tout se déduit à l'instant de la question.
Une colonne `droits` en base serait fausse le lendemain matin, et personne ne le
verrait.
