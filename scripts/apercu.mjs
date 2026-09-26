/**
 * Un aperçu des fenêtres, sans Tauri ni jeu.
 *
 * Le crate ne se lance que sous Windows, et le jeu n'est pas là de toute façon.
 * Cet outil rend chaque fenêtre dans Chromium, par Playwright, en tenant lieu
 * de l'IPC de Tauri : les commandes que le front invoque (`lire_mumble`, les
 * greffons `http` et `store`, les fenêtres) reçoivent ici une réponse écrite
 * dans ce fichier. Il sert à regarder l'interface, et à rien d'autre.
 *
 * **Ce qui est vrai** : la météo, les alentours et la recherche viennent du
 * hub, l'API du jeu décrit la carte. `overlay_visible` répond vrai : les
 * éléments n'interrogent le hub que fenêtre visible. **Ce qui est
 * factice** : le lien Mumble — un personnage posé dans la Vallée de la reine —,
 * la session, et le fond sombre qui tient lieu du jeu derrière les fenêtres
 * transparentes.
 *
 *   APERCU_HUB=https://…vercel.app node scripts/apercu.mjs [dossier de sortie]
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";
import { createServer } from "vite";

const RACINE = fileURLToPath(new URL("..", import.meta.url));
const SORTIE = path.resolve(process.argv[2] ?? path.join(RACINE, "captures"));
const HUB = (process.env.APERCU_HUB ?? "https://www.gw2rp.eu").replace(/\/+$/, "");
const PORT = 1420;

/** La carte où l'on pose le personnage : la Vallée de la reine. */
const CARTE_ID = 15;
/** Le point, en pixels de continent, où le personnage se tient. */
const POINT = { x: 43_200, y: 29_600 };
/** Ce que l'application demande au hub, comme `centreDeGrille` : le centre de
 *  la cellule de 256 px pour la météo, celui de la case de 512 px pour les
 *  alentours. Les réponses sont servies par chemin, mais les adresses lues
 *  sont celles de la production. */
const centreDeGrille = (point, maille) => ({
  x: Math.floor(point.x / maille) * maille + maille / 2,
  y: Math.floor(point.y / maille) * maille + maille / 2,
});
const CENTRE_CELLULE = centreDeGrille(POINT, 256);
const ANCRE = centreDeGrille(POINT, 512);

/** Les fenêtres, telles que `tauri.conf.json` les déclare. */
const FENETRES = [
  { label: "overlay-meteo", ancre: "#/meteo", largeur: 320, hauteur: 150, verrouille: true },
  { label: "overlay-proximite", ancre: "#/proximite", largeur: 340, hauteur: 600, verrouille: false },
  { label: "overlay-personnage", ancre: "#/personnage", largeur: 320, hauteur: 132, verrouille: true },
];
/** La fiche d'un lieu, telle que `tauri.conf.json` la déclare. */
const FICHE = { label: "overlay-fiche", ancre: "#/fiche", largeur: 560, hauteur: 720 };
/** Ce qu'on tape dans la recherche : assez court pour ramener plusieurs familles. */
const RECHERCHE = "ka";

async function lireJson(url) {
  const reponse = await fetch(url, { headers: { Accept: "application/json" } });
  if (!reponse.ok) throw new Error(`${url} → HTTP ${reponse.status}`);
  return reponse.json();
}

/** Le lien Mumble tel que Rust l'émettrait pour un personnage posé au point. */
function lienMumble(carte) {
  return {
    tick: 48_213,
    actif: true,
    avatar_position: [0, 0, 0],
    avatar_front: [0, 0, 1],
    identite: {
      name: "Aperçu de l'overlay",
      profession: 6,
      spec: 0,
      race: 2,
      map_id: carte.id,
      world_id: 2008,
      team_color_id: 0,
      commander: false,
      fov: 0.873,
      uisz: 1,
    },
    map_id: carte.id,
    map_type: 5,
    shard_id: 0,
    build_id: 0,
    etat: {
      carte_ouverte: false,
      jeu_au_premier_plan: true,
      mode_competitif: false,
      champ_de_texte_actif: false,
      en_combat: false,
    },
    // Le jeu écrit la position en pixels de continent : le point, tel quel.
    player_x: POINT.x,
    player_y: POINT.y,
    map_center_x: 0,
    map_center_y: 0,
    map_scale: 1,
    mount_index: 0,
  };
}

/**
 * Ce que la page reçoit à la place de Tauri. Écrit en fonction pour être
 * sérialisé vers le navigateur ; `contexte` porte les réponses préparées.
 */
function installerTauri(contexte) {
  const { label, edition, lien, reponses, session, verrouille, fiche } = contexte;
  const rappels = new Map();
  const magasin = new Map(Object.entries(contexte.magasin));
  let prochainRid = 1;
  const corps = new Map();

  const encoder = (objet) => Array.from(new TextEncoder().encode(JSON.stringify(objet)));

  function reponseHttp(url) {
    const chemin = url.replace(/^https?:\/\/[^/]+/, "").replace(/\?.*$/, "");
    // Le préfixe le plus long l'emporte : `/api/lieux/<slug>/evenements` avant
    // `/api/lieux/<slug>`, lui-même avant `/api/lieux`.
    const prefixe = Object.keys(reponses)
      .filter((candidat) => chemin === candidat || chemin.startsWith(`${candidat}/`) || chemin.startsWith(candidat))
      .sort((a, b) => b.length - a.length)[0];
    if (prefixe) return { statut: 200, charge: reponses[prefixe] };
    if (chemin.startsWith("/api/auth/get-session")) return { statut: 200, charge: session };
    return { statut: 404, charge: { erreur: `Aucune réponse préparée pour ${chemin}` } };
  }

  async function invoke(commande, args = {}) {
    switch (commande) {
      case "plugin:event|listen":
        return args.handler;
      case "plugin:event|unlisten":
      case "plugin:event|emit":
        return null;
      case "lire_mumble":
        return lien;
      case "lire_edition":
        return edition;
      case "overlay_visible":
        return true;
      case "overlay_verrouille":
        return verrouille ?? false;
      case "fiche_courante":
        return fiche ?? null;
      case "montrer_overlay":
      case "cacher_overlay":
      case "regler_edition":
      case "basculer_edition":
      case "verrouiller_overlay":
      case "deverrouiller_overlay":
      case "ouvrir_fiche":
      case "plugin:opener|open_url":
        return null;
      case "plugin:store|load":
        return prochainRid++;
      case "plugin:store|get": {
        const valeur = magasin.get(args.key);
        return [valeur ?? null, valeur !== undefined];
      }
      case "plugin:store|set":
        magasin.set(args.key, args.value);
        return null;
      case "plugin:store|delete":
        return magasin.delete(args.key);
      case "plugin:http|fetch": {
        const rid = prochainRid++;
        corps.set(rid, reponseHttp(args.clientConfig.url));
        return rid;
      }
      case "plugin:http|fetch_send": {
        const { statut } = corps.get(args.rid);
        return {
          status: statut,
          statusText: statut === 200 ? "OK" : "Not Found",
          url: "",
          headers: [["content-type", "application/json"]],
          rid: args.rid,
        };
      }
      case "plugin:http|fetch_read_body": {
        // Le greffon lit par morceaux : un morceau porte ses octets et un
        // dernier octet à zéro ; le morceau final ne porte que le un qui dit
        // que le corps est fini. Un morceau à la fois, donc deux lectures.
        const reponse = corps.get(args.rid);
        if (reponse.envoye) {
          corps.delete(args.rid);
          return [1];
        }
        reponse.envoye = true;
        return [...encoder(reponse.charge), 0];
      }
      case "plugin:http|fetch_cancel":
      case "plugin:http|fetch_cancel_body":
        return null;
      case "plugin:app|version":
        return "1.0.0";
      case "plugin:updater|check":
        return null;
      case "plugin:window|scale_factor":
        return 1;
      case "plugin:window|outer_position":
        return { x: 40, y: 40 };
      case "plugin:window|inner_size":
        return { width: window.innerWidth, height: window.innerHeight };
      case "plugin:window|set_position":
      case "plugin:window|set_size":
      case "plugin:window|start_dragging":
      case "plugin:window|set_focus":
        return null;
      default:
        throw new Error(`Commande sans réponse préparée : ${commande}`);
    }
  }

  function transformCallback(rappel, uneFois = false) {
    const id = window.crypto.getRandomValues(new Uint32Array(1))[0];
    rappels.set(id, (donnees) => {
      if (uneFois) rappels.delete(id);
      return rappel?.(donnees);
    });
    return id;
  }

  window.__TAURI_INTERNALS__ = {
    invoke,
    transformCallback,
    unregisterCallback: (id) => rappels.delete(id),
    runCallback: (id, donnees) => rappels.get(id)?.(donnees),
    callbacks: rappels,
    metadata: {
      currentWindow: { label },
      currentWebview: { label, windowLabel: label },
      windows: [{ label }],
      webviews: [{ label, windowLabel: label }],
    },
    convertFileSrc: (chemin) => chemin,
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}

async function main() {
  await mkdir(SORTIE, { recursive: true });

  console.log(`Lecture du hub ${HUB} et de l'API du jeu…`);
  // Les mêmes adresses que l'application : le relevé au centre de la cellule,
  // les alentours depuis l'ancre, un peu plus loin que le rayon affiché.
  const [carte, meteo, alentours, recherche] = await Promise.all([
    lireJson(`https://api.guildwars2.com/v2/maps/${CARTE_ID}?lang=fr`),
    lireJson(`${HUB}/api/meteo/point?x=${CENTRE_CELLULE.x}&y=${CENTRE_CELLULE.y}`),
    lireJson(`${HUB}/api/alentours?x=${ANCRE.x}&y=${ANCRE.y}&rayon=2900&limite=6&rumeurs=3`),
    lireJson(`${HUB}/api/recherche?q=${encodeURIComponent(RECHERCHE)}&limite=5`),
  ]);
  // La fiche montre le lieu le plus proche ; sans lieu à proximité, la capture
  // de la fiche dit « Lieu introuvable », et c'est la vérité.
  const slug = alentours.lieux[0]?.slug ?? "aucun";
  const [lieu, scenesDuLieu] = await Promise.all([
    lireJson(`${HUB}/api/lieux/${encodeURIComponent(slug)}`).catch(() => null),
    lireJson(`${HUB}/api/lieux/${encodeURIComponent(slug)}/evenements?limite=12`).catch(() => ({
      evenements: [],
    })),
  ]);
  console.log(
    `  ${carte.name} · ${meteo.condition} · ${alentours.lieux.length} lieu(x), ${alentours.evenements.length} scène(s), ${alentours.rumeurs.length} rumeur(s) à moins de ${alentours.rayon} px · fiche : ${lieu?.name ?? slug}`,
  );

  const lien = lienMumble(carte);
  const contexteCommun = {
    lien,
    reponses: {
      "/api/meteo/point": meteo,
      "/api/alentours": alentours,
      "/api/recherche": recherche,
      [`/api/lieux/${slug}`]: lieu ?? { erreur: "Lieu introuvable" },
      [`/api/lieux/${slug}/evenements`]: scenesDuLieu,
    },
    magasin: {
      urlHub: HUB,
      cartes: { [String(carte.id)]: carte },
    },
  };
  const sessionFactice = {
    user: { id: "apercu", name: "Aperçu", email: "apercu@exemple.fr", role: "membre" },
  };

  const vite = await createServer({ root: RACINE, server: { port: PORT, strictPort: true } });
  await vite.listen();
  // `APERCU_CHROMIUM` désigne un Chromium déjà là, quand Playwright n'a pas
  // téléchargé le sien.
  const navigateur = await chromium.launch({ executablePath: process.env.APERCU_CHROMIUM });

  try {
    const capturer = async ({ nom, ancre, largeur, hauteur, contexte, fond, saisie }) => {
      const page = await navigateur.newPage({
        viewport: { width: largeur, height: hauteur },
        deviceScaleFactor: 2,
      });
      // Une erreur de page se lit ici plutôt que de se deviner sur une capture vide.
      page.on("pageerror", (erreur) => console.error(`  [${nom}] ${erreur.message}`));
      page.on("console", (message) => {
        if (message.type() === "error" || message.type() === "warning") {
          console.error(`  [${nom}] ${message.text()}`);
        }
      });
      await page.addInitScript(installerTauri, contexte);
      await page.goto(`http://localhost:${PORT}/index.html${ancre}`);
      // Le fond tient lieu du jeu : la fenêtre est transparente.
      if (fond) await page.addStyleTag({ content: `body { background: ${fond} !important; }` });
      const attendre = () =>
        page.waitForFunction(
          () => !document.body.textContent?.match(/Relevé…|Recherche…|Lecture…|Session…|en cours de lecture/),
          undefined,
          { timeout: 15_000 },
        );
      await attendre();
      // Une recherche se tape dans le champ, comme la personne le ferait.
      if (saisie) {
        await page.fill("input[type=search]", saisie);
        await page.waitForTimeout(500);
        await attendre();
      }
      await page.waitForTimeout(400);
      const fichier = path.join(SORTIE, `${nom}.png`);
      // La fenêtre principale défile ; les éléments, non.
      await page.screenshot({ path: fichier, fullPage: nom.startsWith("principale") });
      await page.close();
      console.log(`  ${fichier}`);
    };

    const FOND_JEU = "#3b4a3d";
    for (const fenetre of FENETRES) {
      for (const edition of [false, true]) {
        await capturer({
          nom: `${fenetre.label}${edition ? "-edition" : ""}`,
          ancre: fenetre.ancre,
          largeur: fenetre.largeur,
          hauteur: fenetre.hauteur + (edition ? 44 : 0),
          fond: FOND_JEU,
          contexte: {
            ...contexteCommun,
            label: fenetre.label,
            edition,
            verrouille: fenetre.verrouille,
            magasin: { ...contexteCommun.magasin, jeton: "apercu" },
            session: sessionFactice,
          },
        });
      }
    }

    // La recherche, remplie : lieux, personnages, groupes et scènes.
    await capturer({
      nom: "overlay-proximite-recherche",
      ancre: "#/proximite",
      largeur: 340,
      hauteur: 600,
      fond: FOND_JEU,
      saisie: RECHERCHE,
      contexte: {
        ...contexteCommun,
        label: "overlay-proximite",
        edition: false,
        verrouille: false,
        magasin: { ...contexteCommun.magasin, jeton: "apercu" },
        session: sessionFactice,
      },
    });

    // La fiche du lieu le plus proche, et la fenêtre avant qu'on ait choisi un lieu.
    for (const [nom, ficheOuverte] of [
      ["overlay-fiche", slug],
      ["overlay-fiche-vide", null],
    ]) {
      await capturer({
        nom,
        ancre: FICHE.ancre,
        largeur: FICHE.largeur,
        hauteur: FICHE.hauteur,
        fond: FOND_JEU,
        contexte: {
          ...contexteCommun,
          label: FICHE.label,
          edition: false,
          fiche: ficheOuverte,
          magasin: { ...contexteCommun.magasin, jeton: "apercu" },
          session: sessionFactice,
        },
      });
    }

    // Le fond à 60 % : ce que le réglage d'affichage produit.
    await capturer({
      nom: "overlay-meteo-opacite-60",
      ancre: "#/meteo",
      largeur: 320,
      hauteur: 150,
      fond: FOND_JEU,
      contexte: {
        ...contexteCommun,
        label: "overlay-meteo",
        edition: false,
        magasin: { ...contexteCommun.magasin, jeton: "apercu", opacite: 60 },
        session: sessionFactice,
      },
    });

    await capturer({
      nom: "principale-connexion",
      ancre: "#/principale",
      largeur: 480,
      hauteur: 760,
      contexte: { ...contexteCommun, label: "principale", edition: false, session: null },
    });
    await capturer({
      nom: "principale-tableau-de-bord",
      ancre: "#/principale",
      largeur: 480,
      hauteur: 760,
      contexte: {
        ...contexteCommun,
        label: "principale",
        edition: false,
        magasin: { ...contexteCommun.magasin, jeton: "apercu" },
        session: sessionFactice,
      },
    });
  } finally {
    await navigateur.close();
    await vite.close();
  }
}

main().catch((erreur) => {
  console.error(erreur);
  process.exit(1);
});
