# GW2RP Overlay

L'application bureau du hub [GW2RP Nexus](https://www.gw2rp.eu) : des éléments
posés par-dessus Guild Wars 2, nourris de la position du personnage joué.
Tauri 2 (Rust) + React 19 + Tailwind v4. Windows seulement, comme le jeu.

Le hub vit dans le dépôt `nexus` ; ses règles de conception s'appliquent ici
telles quelles, et ce fichier n'en redit que ce que l'overlay change.

## Ce qui ne se discute pas

- **Les jetons font foi.** `src/styles/tokens.css` est **le même fichier** que
  celui du hub, copié tel quel : une sortie du design system, jamais éditée à la
  main. Aucune couleur, taille ou espacement en dur ; les styles de texte sont
  ceux des jetons (`.meta`, `.caption`, `.eyebrow`…), pas un `text-[Npx]`.
- **Le trait plutôt que l'ombre**, angles vifs, aucun dégradé. Un élément
  d'overlay est un panneau opaque `bg-surface` bordé de `rule` : par-dessus un
  jeu, un fond translucide rend le texte illisible dès que la scène s'éclaire.
- **Les capitales s'écrivent dans le contenu** (`toLocaleUpperCase("fr-FR")`),
  jamais avec `text-transform`.
- **Rien d'inventé.** Un état sans donnée porte son titre et rien d'autre :
  « Jeu non détecté », « Relevé… », « Aucun lieu à proximité ». Une distance
  se calcule depuis les coordonnées réelles et s'arrondit à la centaine
  d'unités : la position du lien n'est pas plus précise.
- **L'interface est en français**, code, commentaires et journaux compris. Les
  noms de champs qui viennent du jeu ou de l'API du hub gardent le leur.

## Les fenêtres

**Chaque élément est une fenêtre**, déclarée dans `src-tauri/tauri.conf.json`
sous l'étiquette `overlay-<id>`, cachée au départ : transparente, sans bordure,
toujours au-dessus, absente de la barre des tâches, sans ombre. Toutes chargent
la même page ; l'ancre de leur adresse (`index.html#/meteo`) dit laquelle elles
sont, et `ELEMENTS` (`src/lib/overlays.ts`) est la seule table qui relie l'ancre,
l'étiquette et le titre. Pas de routeur : une fenêtre ne navigue jamais.

**Rust montre, cache et décide** (`src-tauri/src/overlays.rs`). Le front invoque
`montrer_overlay` / `cacher_overlay` et écoute ; il ne crée pas de fenêtre et ne
touche pas à ce qu'elle laisse passer.

**Hors édition, le curseur traverse un élément** (`set_ignore_cursor_events`) :
un clic dessus atteint le jeu en dessous, sinon un panneau posé sur l'écran
volerait au jeu chaque clic dans sa zone. **En édition**, l'élément reprend le
curseur : il se glisse par sa barre (`data-tauri-drag-region`), se
redimensionne par son bord, se déplace aux flèches — d'un pas de dix pixels,
d'un pixel avec `Maj` — et se ferme par sa croix. Le mode est **tenu par Rust**
(`Edition`), pas par une fenêtre : il concerne toutes les fenêtres, il se
bascule au raccourci global `Ctrl+Maj+O` qui tombe pendant que le jeu a le
clavier, et une fenêtre encore cachée doit le connaître quand elle s'ouvre. Le
mode s'applique **avant** de montrer une fenêtre : une fenêtre qui apparaîtrait
un instant en prenant le curseur volerait le clic qui vient de l'ouvrir.

Une fenêtre **reprend sa place** au démarrage : son cadre s'écrit dans les
réglages à chaque déplacement (`ecrireCadre`), en pixels physiques d'écran, et
`CadreElement` le relit au montage. Les éléments laissés ouverts se rouvrent
depuis la fenêtre principale une fois la session confirmée.

**Fermer la fenêtre principale la range**, elle ne quitte pas : l'application
continue derrière son icône de zone de notification (`plateau.rs`), et les
éléments restent à l'écran. Quitter est un choix du plateau.

Le jeu doit être en **fenêtré plein écran**, pas en plein écran exclusif : en
exclusif, rien ne se dessine par-dessus, et ce n'est pas un défaut de
l'application.

## Le lien Mumble

Guild Wars 2 publie un bloc de mémoire partagée nommé `MumbleLink` — le
protocole du logiciel de voix Mumble, complété d'un contexte propre au jeu. On
le lit ; on n'injecte rien dans le jeu et on ne lit pas sa mémoire à lui.
**Un seul lecteur**, côté Rust (`src-tauri/src/mumble.rs`), lit le bloc quatre
fois par seconde et l'émet à toutes les fenêtres sur l'évènement `mumble` :
chaque fenêtre qui lirait de son côté ferait autant de copies du bloc.

La disposition du bloc est documentée en tête de `mumble.rs` et **ne se
réordonne pas** : le jeu écrit à ces décalages-là. Trois garde-fous : un bloc
plus court que `TAILLE` ne se lit pas (relu en zéros, il donnerait une position
crédible et fausse) ; un bloc dont le nom n'est pas « Guild Wars 2 » ne se lit
pas (un autre jeu parlant Mumble remplirait les mêmes champs d'un autre sens) ;
une identité JSON illisible n'invalide pas la position (le jeu l'écrit parfois à
moitié pendant un changement de carte).

**`tick` dit si le jeu tourne** : le compteur d'images avance à chaque image,
donc un compteur immobile entre deux lectures veut dire que rien n'écrit plus le
bloc — jeu fermé, ou figé sur un chargement. `actif` porte ce jugement, et tout
l'écran le suit (« Jeu non détecté »).

Le bloc se **crée** s'il n'existe pas encore (`CreateFileMappingW`) : c'est la
façon convenue de le lire avant que le jeu ne soit lancé, et le jeu, en
démarrant, ouvre celui qui existe.

Hors Windows, le lecteur rend `None` : l'application se développe sans lien, et
l'écran le dit.

## Du repère du jeu à celui du hub

Le hub range ses lieux en **pixels de continent** — ceux du continent 1 (la
Tyrie), à l'échelle de `continent_dims` : 81 920 × 114 688, portée par le zoom
7. Le lien donne la position du personnage dans le repère de la **carte** où il
se tient (`playerX` / `playerY`, en pouces du jeu, le repère de `map_rect` de
l'API) ; l'API publique du jeu (`/v2/maps/{id}`) donne le rectangle que cette
carte occupe sur le continent (`continent_rect`). La projection est une règle de
trois sur chaque axe, **l'axe des ordonnées renversé** : le jeu compte vers le
nord, le continent vers le sud. `projeter` dans `src/lib/carte.ts` fait foi.

Ce n'est **pas** `fAvatarPosition`, qui est en mètres dans un repère à trois
axes dont le deuxième est la hauteur : rien à en faire ici.

La description d'une carte se range dans les réglages (`cartes`) : une carte ne
change pas de rectangle, et l'API n'a pas à être rappelée à chaque lancement
pour la même Kryte. Un personnage sur un autre continent — les Brumes — est
« Hors de Tyrie » : le hub n'a rien à en dire.

**Une distance s'affiche en unités du jeu**, celles des portées de compétence :
`unitesParPixel` se lit sur la carte courante (`map_rect` / `continent_rect`,
vingt-quatre partout dans le jeu de base) plutôt que de s'écrire, et le résultat
s'arrondit à la centaine.

## Les lectures du hub

**La session est un jeton, pas un cookie.** Les requêtes passent par
`@tauri-apps/plugin-http`, exécutées côté Rust : pas de CORS, et pas de cookie
de vue web à espérer. Le hub porte le greffon `bearer` de Better Auth : à la
connexion, il rend le jeton dans l'en-tête `set-auth-token`, l'application le
range dans les réglages et le représente en `Authorization: Bearer` à chaque
appel (`src/lib/nexus.ts`). Une réponse 401 à la relecture de session efface le
jeton.

Les adresses de hub acceptées (`URLS_HUB_AUTORISEES`) et la capacité `http` de
`src-tauri/capabilities/default.json` **doivent dire la même chose** : une
adresse acceptée ici et refusée là échouerait à la première requête sans dire
pourquoi. L'adresse rangée se revalide à chaque lecture — un fichier de réglages
édité à la main ne pointe pas l'application ailleurs.

**Une lecture ne se redemande que quand elle peut changer.** La météo
(`/api/meteo/point`) se relit quand le personnage change de **cellule** de
simulation — 256 px de continent, `CELL_SIZE` comme au hub — ou toutes les cinq
minutes ; la suivre à chaque lecture du lien ferait quatre requêtes par seconde
pour le même ciel. Les lieux (`/api/lieux/proximite`) se relisent quand le
personnage s'est éloigné de plus de `SEUIL_DEPLACEMENT` de son point d'ancrage ;
entre deux appels, distances et directions se recalculent sur place depuis la
position courante — des soustractions, pas des requêtes.

Le relevé d'avant **reste affiché** pendant que le suivant arrive : on voit ce
qu'on quitte, pas un panneau vide.

## Les réglages

Un seul magasin (`reglages.json`, greffon `store`), et un seul handle par
fenêtre (`lireMagasin`) : deux handles sur le même fichier gardent chacun leur
copie en mémoire, et la dernière écriture l'emporterait sur un changement jamais
relu. Le greffon propage les changements d'une fenêtre à l'autre :
`surChangement` suffit pour qu'un overlay suive ce que la principale a réglé, et
pour qu'une déconnexion faite dans une fenêtre se voie dans les autres.

## Frontières

- `src-tauri/**` ne connaît ni le hub ni l'API du jeu : il lit le lien, tient
  les fenêtres, et c'est tout. Les requêtes réseau partent du front, par le
  greffon `http`, sous la capacité qui les borne.
- Le vocabulaire du hub (`src/lib/domaine.ts`) recopie ses valeurs et ses
  libellés ; une valeur inconnue s'affiche telle quelle plutôt que de faire
  tomber l'élément — le hub a pu ajouter un type que cette version ne connaît
  pas.
- Les hooks qui écoutent Rust (`useMumble`, `useEdition`, `useVisibilites`)
  demandent l'état au montage **puis** écoutent : la fenêtre a pu être créée
  cachée bien avant, et l'évènement seul la laisserait sur sa valeur par défaut
  jusqu'au premier changement.

## Avant de pousser

```bash
npm run typecheck && npm run lint && npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Le crate ne se compile entièrement que sous Windows : `ring`, tiré par le
greffon `http`, demande la chaîne MSVC. Ailleurs, `cargo test` sur le module
`mumble` passe, et le reste se vérifie par le workflow `verifier.yml`.

## Publier

**La version s'écrit à trois endroits** — `package.json`, `tauri.conf.json`,
`Cargo.toml` — et `publier.yml` refuse de construire si le tag de la release ne
les égale pas tous : le nom de l'installeur vient de `tauri.conf.json`, et un
tag `v1.1.0` publierait sinon un installeur `1.0.0`. Le workflow n'écrit pas la
release, il y attache les installeurs : les notes sont écrites à la main, et une
release créée par le workflow doublerait celle qui vient de le déclencher.
