# GW2RP Overlay

L'application bureau du hub [GW2RP Nexus](https://www.gw2rp.eu) : des éléments
posés par-dessus Guild Wars 2, qui suivent le personnage joué.

- **Météo** — le temps qu'il fait, dans la simulation du hub, là où le
  personnage se tient.
- **À proximité** — les lieux de jeu de rôle du registre autour de lui, du plus
  proche au plus éloigné, avec leur direction ; les scènes annoncées alentour ;
  les dernières rumeurs de la région. Une recherche y trouve lieux,
  personnages, groupes et scènes de tout le hub. Un lieu s'ouvre dans sa
  **fiche** — description, accès, tenanciers, plans et scènes — à côté de la
  liste ; le reste s'ouvre sur le hub, dans le navigateur.
- **Personnage** — son nom, sa race, sa profession, sa carte et sa position
  dans le repère du hub.

Le hub n'est affilié ni à ArenaNet, LLC ni à NCSOFT.

## La pile

| | |
| --- | --- |
| Cadre | Tauri 2 (Rust) — fenêtres transparentes, plateau, raccourci global |
| Interface | React 19 + Tailwind CSS v4, sur les jetons du design system Tyrie RP |
| Jeu | Lien Mumble de Guild Wars 2 (mémoire partagée `MumbleLink`) |
| Hub | `https://www.gw2rp.eu`, session par jeton (greffon `bearer` de Better Auth) |
| Cartes | API publique du jeu, `/v2/maps/{id}`, pour poser chaque carte sur le continent |

## Comment ça marche

Le jeu publie à chaque image un bloc de mémoire partagée — le protocole du
logiciel de voix Mumble, complété d'un contexte à lui : la carte, la position du
personnage sur la carte du monde, son nom, sa profession. L'application le lit
quatre fois par seconde. Rien n'est injecté dans le jeu.

Cette position est déjà en **pixels de continent**, le repère dans lequel le
hub range ses lieux et joue sa météo ; l'API publique du jeu ne sert qu'à dire
le continent et l'échelle des distances. Le reste est des lectures publiques du
hub : `/api/meteo/point` pour le ciel, `/api/alentours` pour les lieux, scènes
et rumeurs autour du personnage, `/api/recherche` pour la recherche,
`/api/lieux/<slug>` et ses `/evenements` pour la fiche.

Chaque élément est une fenêtre transparente, toujours au-dessus du jeu. Chacun
porte un **cadenas** : fermé, les clics le traversent et atteignent le jeu —
sauf sur le cadenas lui-même, pour le rouvrir ; ouvert, il prend la souris. La
météo et le personnage naissent fermés, il n'y a rien à y cliquer ;
« À proximité » naît ouvert. En édition — `Ctrl+Maj+O`, ou le bouton de la
fenêtre principale — chaque fenêtre se déplace, se redimensionne et se ferme,
et reprend sa place au prochain démarrage.

L'opacité du fond des éléments se règle depuis la fenêtre principale ; le
texte reste entier quelle que soit la valeur.

Le jeu doit être en **fenêtré plein écran** : en plein écran exclusif, rien ne
se dessine par-dessus.

## Démarrer

Il faut [Node 22](https://nodejs.org), [Rust](https://rustup.rs) et les
[prérequis de Tauri](https://v2.tauri.app/start/prerequisites/) pour Windows
(outils de compilation C++ de Visual Studio et WebView2).

```bash
npm install
npm run tauri dev
```

La fenêtre principale demande une connexion au hub — le compte est celui du
site, courriel et mot de passe. Une fois connecté, chaque élément s'affiche ou
se masque depuis cette fenêtre.

Pour un hub local (`npm run dev` dans le dépôt `nexus`), choisir
`http://localhost:3000` dans la liste « Hub » de l'écran de connexion. Le hub
doit porter le greffon `bearer` : c'est lui qui rend le jeton de session à
l'application.

```bash
npm run tauri build     # installeurs NSIS et MSI dans src-tauri/target/release/bundle
```

## Vérifier

```bash
npm run typecheck && npm run lint && npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Le workflow `.github/workflows/verifier.yml` rejoue ces vérifications sous
Windows et publie les installeurs en artefact.

## Publier une release

`.github/workflows/publier.yml` se déclenche quand une release `v*` est
**publiée** sur GitHub. Il n'écrit pas la release : les notes restent écrites à
la main, et il y attache les deux installeurs, NSIS et MSI, une fois construits
sous Windows.

```bash
# aligner les trois fichiers de version, puis
npm version 1.1.0 --no-git-tag-version
sed -i 's/^version = ".*"/version = "1.1.0"/' src-tauri/Cargo.toml
sed -i 's/"version": ".*"/"version": "1.1.0"/' src-tauri/tauri.conf.json
cargo update -w --manifest-path src-tauri/Cargo.toml
git commit -am "Version 1.1.0" && git push
# puis créer et publier la release v1.1.0 sur GitHub, depuis main
```

Le workflow refuse de construire si le tag ne correspond pas aux versions de
`package.json`, `tauri.conf.json` et `Cargo.toml` : un tag `v1.1.0` publierait
sinon un `GW2RP Overlay_1.0.0_x64-setup.exe`. Il se relance à la demande sur
une release existante (« Run workflow », avec le tag) ; `--clobber` remplace
alors les installeurs déjà attachés.

### Mise à jour automatique

L'application interroge la dernière release GitHub au démarrage puis toutes les
six heures. Si elle annonce une version **supérieure** à celle du binaire, la
fenêtre principale la montre, avec ses notes et un bouton qui télécharge et
installe. Rien ne s'installe sans ce bouton. Sous Windows, l'installeur NSIS
est lancé en mode `passive` : le greffon termine l'application juste après
l'avoir lancé, et l'installeur la relance.

Le greffon refuse toute mise à jour qu'il ne peut pas vérifier, d'où une paire
de clés minisign. La **publique** est versionnée dans `plugins.updater.pubkey`
de `src-tauri/tauri.conf.json`. La **privée** n'existe que dans les secrets du
dépôt :

| Secret | Contenu |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | le contenu du fichier `.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | son mot de passe, ou vide si la clé n'en a pas |

Sans eux, `publier.yml` échoue franchement plutôt que de publier des
installeurs que personne ne pourra installer. Pour refaire une paire — la
privée perdue, les versions déjà installées ne se mettront plus à jour
d'elles-mêmes :

```bash
npm run tauri signer generate -- -w "$HOME/.tauri/gw2rp-overlay.key"
```

La sortie donne la clé publique à recopier dans la configuration, et le
fichier `.key` à déposer dans les secrets.

`publier.yml` construit avec `--config src-tauri/updater.conf.json`, qui ajoute
`createUpdaterArtifacts` : l'empaqueteur signe alors chaque installeur et écrit
un `.sig` à côté. Ce réglage est tenu hors de `tauri.conf.json` pour que
`verifier.yml`, sans clé, continue de construire. Le workflow attache ensuite
un `latest.json` à la release, dont l'adresse d'installeur est relue **depuis
les fichiers de la release** : GitHub remplace les espaces des noms par des
points. L'application le lit via
`https://github.com/GW2RP/overlay/releases/latest/download/latest.json`, qui
ne résout que vers la dernière release **publiée** : un brouillon n'est proposé
à personne.

### Les greffons vont par deux

Chaque greffon Tauri existe en crate et en paquet npm, et le CLI refuse de
construire si leurs versions majeure et mineure diffèrent. `Cargo.toml` et
`package.json` écrivent donc la même mineure pour chacun ; une montée de
version se fait des deux côtés à la fois.

## Regarder sans le jeu

```bash
npm run apercu                          # captures dans ./captures
APERCU_HUB=https://…vercel.app npm run apercu
```

L'outil rend chaque fenêtre dans Chromium, par Playwright, en tenant lieu de
l'IPC de Tauri. La météo, les alentours, la recherche et la fiche viennent du
hub, l'API du jeu décrit la carte ; seuls le lien Mumble — un personnage posé dans la Vallée de la reine —,
la session et le fond qui tient lieu du jeu sont factices. `APERCU_CHROMIUM`
désigne un Chromium déjà installé quand Playwright n'a pas téléchargé le sien.

## Où les choses vivent

```
src/
  main.tsx              l'entrée : l'ancre de la fenêtre dit laquelle elle est
  fenetres/             la principale, le cadre commun des éléments, la fiche d'un lieu
  elements/             météo, à proximité, personnage
  components/           le cadenas, le markdown du hub, les glyphes, les boutons
  lib/
    mumble.ts           le lien du jeu, tel que Rust l'émet
    gw2.ts              les cartes du jeu, décrites par son API et rangées
    carte.ts            la position en pixels de continent, distances, directions
    position.ts         où le personnage se tient, pour le hub
    nexus.ts            le client du hub : session par jeton, météo, alentours, fiche, recherche
    overlays.ts         les éléments, la fiche, et ce que Rust en tient
    cadre.ts            une fenêtre qui reprend sa place
    lecture.ts          une lecture du hub cadencée, fenêtre visible seulement
    liens.ts            ouvrir le hub dans le navigateur
    reglages.ts         le magasin persistant
    domaine.ts          le vocabulaire du hub et du jeu
  styles/tokens.css     les jetons du design system — le même fichier que le hub
src-tauri/
  src/mumble.rs         la mémoire partagée du jeu, et son décodage
  src/overlays.rs       montrer, cacher, mode d'édition, cadenas, fiche
  src/plateau.rs        l'icône de la zone de notification
  tauri.conf.json       les fenêtres, une par élément, plus la fiche
  capabilities/         ce que les fenêtres ont le droit de faire
```
