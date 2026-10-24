import { useEffect, useRef, type RefObject } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";

import {
  arrondirEchelle,
  normaliserAngle,
  type Decoration,
  type Maillage,
} from "@/lib/pavillon";

/**
 * Le pavillon en trois dimensions, et ses poignées.
 *
 * Une décoration dont l'archive du jeu a donné le modèle se montre par ce
 * modèle, à son échelle. Les autres — archive pas encore ouverte, modèle en
 * route ou introuvable — se montrent par un **repère** : un cube de côté
 * fixe, d'une autre couleur, à sa place, tourné comme elle, avec une arête qui
 * dit où est son avant. Le repère ne prétend pas à sa taille, et l'échelle du
 * jeu ne s'y applique pas : un repère grossi dirait une taille que personne
 * n'a mesurée.
 *
 * Le jeu compte en pouces, x vers l'est, y vers le nord, z vers le bas.
 * Three.js veut y vers le haut : `VERS_THREE` passe d'un repère à l'autre.
 * Les sommets des modèles y passent une fois, à la construction ; les
 * placements se conjuguent (`B·M·B`), ce qui garde leur déterminant positif.
 *
 * Les poignées (`TransformControls`) tiennent un **pivot** au centre de la
 * sélection. Pendant le glissé, la scène suit seule, sans passer par React ;
 * au relâché, les décorations transformées remontent en un seul geste.
 */

/** Le côté d'un repère, en pouces : la taille d'un coffre. */
const COTE_REPERE = 60;

/** Du repère du jeu à celui de three.js : (x, y, z) → (x, -z, -y). C'est une
 *  symétrie — le jeu compte dans un repère indirect — et non une rotation.
 *  Elle est sa propre inverse. */
const VERS_THREE = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, -1, 0, 0, 0, 0, 0, 1);

/** L'ordre des rotations du jeu, sur des angles lus dans le sens inverse. */
const ORDRE: THREE.EulerOrder = "YXZ";

/** La place d'une décoration dans la scène. La convention des rotations du
 *  jeu n'est pas documentée ; elle est **mesurée** sur la Serre Silvie, dont
 *  le toit tient sur des murs inclinés sur deux axes : les angles se lisent
 *  dans le sens inverse, et s'appliquent z d'abord, puis x, puis y. C'est la
 *  seule lecture où chaque mur du toit reste dans l'axe de sa rangée : z,
 *  puis y, puis x les tord de 14° autour de la pente, et les autres couchent
 *  les murs ou font sortir les chevrons du pavillon. */
function matriceDe(decoration: Decoration, avecEchelle: boolean): THREE.Matrix4 {
  const [x, y, z] = decoration.position;
  const [rx, ry, rz] = decoration.rotation;
  const echelle = avecEchelle ? decoration.echelle : 1;
  const placement = new THREE.Matrix4()
    .makeTranslation(x, y, z)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-rx, -ry, -rz, ORDRE)))
    .multiply(new THREE.Matrix4().makeScale(echelle, echelle, echelle));
  return VERS_THREE.clone().multiply(placement).multiply(VERS_THREE);
}

/** L'inverse de `matriceDe` : une place dans la scène, relue en position,
 *  rotation et échelle du jeu. */
function decomposer(matrice: THREE.Matrix4, avant: Decoration): Decoration {
  const placement = VERS_THREE.clone().multiply(matrice).multiply(VERS_THREE);
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const echelle = new THREE.Vector3();
  placement.decompose(position, rotation, echelle);
  const angles = new THREE.Euler().setFromQuaternion(rotation, ORDRE);
  return {
    ...avant,
    position: [position.x, position.y, position.z],
    rotation: [normaliserAngle(-angles.x), normaliserAngle(-angles.y), normaliserAngle(-angles.z)],
    echelle: arrondirEchelle(echelle.x),
  };
}

/** Un point ou un écart de la scène, en pouces du jeu. */
function versJeu(point: THREE.Vector3): [number, number, number] {
  return [point.x, -point.z, -point.y];
}

/** Les maillages d'un modèle en une géométrie, passée dans le repère de
 *  three.js. La symétrie retourne les faces : l'ordre des sommets de chaque
 *  triangle s'inverse avec elle. */
function geometrieDe(maillages: Maillage[]): THREE.BufferGeometry {
  const sommets = maillages.reduce((n, m) => n + m.positions.length / 3, 0);
  const index = maillages.reduce((n, m) => n + m.triangles.length, 0);
  const positions = new Float32Array(sommets * 3);
  const triangles = new Uint32Array(index);
  let s = 0;
  let t = 0;
  for (const maillage of maillages) {
    const base = s;
    for (let i = 0; i < maillage.positions.length; i += 3) {
      positions[s * 3] = maillage.positions[i];
      positions[s * 3 + 1] = -maillage.positions[i + 2];
      positions[s * 3 + 2] = -maillage.positions[i + 1];
      s += 1;
    }
    for (let i = 0; i < maillage.triangles.length; i += 3) {
      triangles[t] = base + maillage.triangles[i + 2];
      triangles[t + 1] = base + maillage.triangles[i + 1];
      triangles[t + 2] = base + maillage.triangles[i];
      t += 3;
    }
  }
  const geometrie = new THREE.BufferGeometry();
  geometrie.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometrie.setIndex(new THREE.BufferAttribute(triangles, 1));
  geometrie.computeVertexNormals();
  return geometrie;
}

/** Une couleur des jetons, lue sur la page : la scène suit le thème comme le
 *  reste de l'écran. */
function jeton(nom: string): THREE.Color {
  // Un jeton manquant laisse la couleur par défaut de three.js plutôt
  // qu'une teinte inventée ici.
  const valeur = getComputedStyle(document.documentElement).getPropertyValue(nom).trim();
  return valeur ? new THREE.Color(valeur) : new THREE.Color();
}

export type Outil = "deplacer" | "tourner" | "echelle";

const MODE_DES_POIGNEES: Record<Outil, "translate" | "rotate" | "scale"> = {
  deplacer: "translate",
  tourner: "rotate",
  echelle: "scale",
};

/** Où une décoration vit dans la scène : son maillage instancié et son rang
 *  dans celui-ci. */
type Place = {
  instances: THREE.InstancedMesh;
  rang: number;
  decoration: Decoration;
  aUnModele: boolean;
};

type Monde = {
  poignees: TransformControls;
  pivot: THREE.Object3D;
  rendre: () => void;
  /** Les décorations, un maillage instancié par sorte. */
  sortes: THREE.Group;
  /** L'avant des repères. */
  traits: THREE.Group;
  /** Un matériau pour toutes : la couleur est portée par chaque instance. */
  materiau: THREE.MeshLambertMaterial;
  /** Une géométrie par sorte, gardée d'un geste à l'autre : un mur de
   *  quatorze mille sommets ne se recalcule pas à chaque déplacement. */
  geometries: Map<number, { source: Maillage[] | null; geometrie: THREE.BufferGeometry }>;
  places: Map<number, Place>;
};

type Glisse = {
  pivot: THREE.Matrix4;
  position: THREE.Vector3;
  places: Place[];
  matrices: THREE.Matrix4[];
};

type Props = {
  /** Change à chaque disposition chargée : la caméra se recadre sur elle.
   *  Un geste ne la fait pas bouger. */
  cadrage: number;
  decorations: Decoration[];
  /** Les modèles déjà lus, par sorte ; une liste vide pour une sorte sans
   *  modèle. Une sorte absente attend le sien. */
  modeles: Map<number, Maillage[]>;
  /** Les clés des décorations choisies : elles s'allument, et les poignées
   *  se posent au milieu d'elles. */
  selection: ReadonlySet<number>;
  outil: Outil;
  /** Le pas des poignées, en pouces et en radians ; `null` : libre. */
  pasPosition: number | null;
  pasAngle: number | null;
  /** Un clic dans la scène : la décoration touchée, ou `null` dans le vide.
   *  `ajouter` quand Ctrl ou Maj est tenu. */
  onCliquer: (cle: number | null, ajouter: boolean) => void;
  /** Les décorations qu'un glissé des poignées a transformées. */
  onTransformer: (transformees: Decoration[]) => void;
  /** Rempli par la scène : où poser une décoration ajoutée, en pouces du
   *  jeu — le point que la caméra regarde, ramené au sol. */
  pointDePoseRef?: RefObject<(() => [number, number, number]) | null>;
};

export function ScenePavillon({
  cadrage,
  decorations,
  modeles,
  selection,
  outil,
  pasPosition,
  pasAngle,
  onCliquer,
  onTransformer,
  pointDePoseRef,
}: Props) {
  const conteneur = useRef<HTMLDivElement>(null);
  const monde = useRef<Monde | null>(null);
  // Les valeurs les plus récentes, lues par les écouteurs : la scène ne se
  // reconstruit pas parce que le parent a redessiné.
  const courant = useRef({ decorations, selection, outil, onCliquer, onTransformer });
  useEffect(() => {
    courant.current = { decorations, selection, outil, onCliquer, onTransformer };
  }, [decorations, selection, outil, onCliquer, onTransformer]);

  // La scène, la caméra et leurs commandes : une fois par disposition.
  useEffect(() => {
    const hote = conteneur.current;
    if (!hote) return;

    const rendu = new THREE.WebGLRenderer({ antialias: true });
    rendu.setPixelRatio(window.devicePixelRatio);
    hote.appendChild(rendu.domElement);

    const scene = new THREE.Scene();
    scene.background = jeton("--ground");
    // Des lumières sans teinte : la couleur est celle des jetons, portée par
    // les instances. Le ciel éclaire plus que le sol, d'où le relief.
    scene.add(new THREE.HemisphereLight(undefined, jeton("--ink-muted"), 2.2));
    const soleil = new THREE.DirectionalLight(undefined, 1.4);
    soleil.position.set(1, 2, 1.5);
    scene.add(soleil);

    const sortes = new THREE.Group();
    const traits = new THREE.Group();
    const pivot = new THREE.Object3D();
    scene.add(sortes, traits, pivot);

    // Le cadre : la caméra embrasse toutes les décorations.
    const boite = new THREE.Box3();
    const point = new THREE.Vector3();
    for (const decoration of courant.current.decorations) {
      boite.expandByPoint(point.setFromMatrixPosition(matriceDe(decoration, false)));
    }
    if (boite.isEmpty()) boite.expandByPoint(point.set(0, 0, 0));
    const centre = boite.getCenter(new THREE.Vector3());
    const rayon = Math.max(boite.getSize(new THREE.Vector3()).length() / 2, COTE_REPERE * 4);

    const camera = new THREE.PerspectiveCamera(50, 1, 10, rayon * 40);
    camera.position.copy(centre).add(new THREE.Vector3(rayon, rayon * 1.1, rayon));
    const orbite = new OrbitControls(camera, rendu.domElement);
    orbite.target.copy(centre);

    const grille = new THREE.GridHelper(rayon * 4, 40, jeton("--rule"), jeton("--hairline"));
    grille.position.set(centre.x, boite.min.y, centre.z);
    scene.add(grille);

    const rendre = () => rendu.render(scene, camera);
    orbite.addEventListener("change", rendre);
    orbite.update();

    const poignees = new TransformControls(camera, rendu.domElement);
    poignees.setSpace("world");
    const aide = poignees.getHelper();
    scene.add(aide);
    poignees.addEventListener("change", rendre);

    // Le glissé : ce que chaque décoration choisie était au départ, et ce
    // qu'était le pivot. Chacune suit la transformation du pivot.
    let glisse: Glisse | null = null;
    const ecart = (depart: Glisse) =>
      new THREE.Matrix4().multiplyMatrices(pivot.matrixWorld, depart.pivot.clone().invert());

    const commencer = () => {
      const m = monde.current;
      if (!m) return;
      pivot.updateMatrixWorld();
      const places = [...courant.current.selection].flatMap((cle) => {
        const place = m.places.get(cle);
        return place ? [place] : [];
      });
      glisse = {
        pivot: pivot.matrixWorld.clone(),
        position: pivot.position.clone(),
        places,
        matrices: places.map((p) => matriceDe(p.decoration, true)),
      };
    };

    const finir = () => {
      const depart = glisse;
      glisse = null;
      if (!depart) return;
      pivot.updateMatrixWorld();
      const outilCourant = courant.current.outil;
      let transformees: Decoration[];
      if (outilCourant === "deplacer") {
        // Un déplacement n'ajoute que la translation : les angles et
        // l'échelle restent ceux du fichier, au chiffre près.
        const [dx, dy, dz] = versJeu(pivot.position.clone().sub(depart.position));
        transformees =
          dx === 0 && dy === 0 && dz === 0
            ? []
            : depart.places.map(({ decoration: d }) => ({
                ...d,
                position: [d.position[0] + dx, d.position[1] + dy, d.position[2] + dz],
              }));
      } else {
        const delta = ecart(depart);
        transformees = delta.equals(new THREE.Matrix4())
          ? []
          : depart.places.map(({ decoration }, i) => {
              const apres = decomposer(delta.clone().multiply(depart.matrices[i]), decoration);
              // Une rotation ne touche pas l'échelle.
              return outilCourant === "tourner" ? { ...apres, echelle: decoration.echelle } : apres;
            });
      }
      // Le pivot reprend sa forme ; la sélection transformée le replacera.
      pivot.rotation.set(0, 0, 0);
      pivot.scale.set(1, 1, 1);
      if (transformees.length > 0) courant.current.onTransformer(transformees);
    };

    poignees.addEventListener("dragging-changed", (evenement) => {
      const enCours = Boolean(evenement.value);
      orbite.enabled = !enCours;
      if (enCours) commencer();
      else finir();
    });

    poignees.addEventListener("objectChange", () => {
      const depart = glisse;
      if (!depart) return;
      // L'échelle du jeu est uniforme : la poignée d'un axe la donne aux trois.
      if (courant.current.outil === "echelle") {
        const { x, y, z } = pivot.scale;
        const loin = [x, y, z].sort((a, b) => Math.abs(b - 1) - Math.abs(a - 1))[0];
        pivot.scale.setScalar(Math.max(loin, 0.01));
      }
      pivot.updateMatrixWorld();
      const delta = ecart(depart);
      depart.places.forEach((place, i) => {
        const matrice = delta.clone().multiply(depart.matrices[i]);
        if (!place.aUnModele) {
          // Un repère ne prend pas l'échelle.
          const s = 1 / place.decoration.echelle;
          matrice.multiply(new THREE.Matrix4().makeScale(s, s, s));
        }
        place.instances.setMatrixAt(place.rang, matrice);
        place.instances.instanceMatrix.needsUpdate = true;
      });
    });

    const ajuster = () => {
      const { clientWidth: l, clientHeight: h } = hote;
      if (l === 0 || h === 0) return;
      rendu.setSize(l, h);
      camera.aspect = l / h;
      camera.updateProjectionMatrix();
      rendre();
    };
    const observateur = new ResizeObserver(ajuster);
    observateur.observe(hote);
    ajuster();

    // Un clic sans glissé choisit la décoration sous le curseur — sauf sur
    // une poignée, qui le prend pour elle.
    const lancer = new THREE.Raycaster();
    let appui: { x: number; y: number } | null = null;
    const surAppui = (e: PointerEvent) => {
      appui = poignees.axis === null ? { x: e.clientX, y: e.clientY } : null;
    };
    const surRelache = (e: PointerEvent) => {
      if (!appui || Math.hypot(e.clientX - appui.x, e.clientY - appui.y) > 4) return;
      const cadre = rendu.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - cadre.left) / cadre.width) * 2 - 1,
        -((e.clientY - cadre.top) / cadre.height) * 2 + 1,
      );
      lancer.setFromCamera(ndc, camera);
      const touche = lancer.intersectObjects(sortes.children, false)[0];
      const membres = touche?.object.userData.decorations as Decoration[] | undefined;
      const decoration = membres && touche.instanceId != null ? membres[touche.instanceId] : undefined;
      courant.current.onCliquer(decoration?.cle ?? null, e.ctrlKey || e.metaKey || e.shiftKey);
    };
    rendu.domElement.addEventListener("pointerdown", surAppui);
    rendu.domElement.addEventListener("pointerup", surRelache);

    const materiau = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
    const geometries: Monde["geometries"] = new Map();
    monde.current = {
      poignees,
      pivot,
      rendre,
      sortes,
      traits,
      materiau,
      geometries,
      places: new Map(),
    };
    if (pointDePoseRef) {
      pointDePoseRef.current = () =>
        versJeu(new THREE.Vector3(orbite.target.x, boite.min.y, orbite.target.z));
    }

    return () => {
      monde.current = null;
      if (pointDePoseRef) pointDePoseRef.current = null;
      sortes.clear();
      vider(traits);
      geometries.forEach(({ geometrie }) => geometrie.dispose());
      materiau.dispose();
      grille.geometry.dispose();
      [grille.material].flat().forEach((m) => m.dispose());
      poignees.detach();
      poignees.dispose();
      aide.removeFromParent();
      observateur.disconnect();
      orbite.dispose();
      rendu.domElement.removeEventListener("pointerdown", surAppui);
      rendu.domElement.removeEventListener("pointerup", surRelache);
      rendu.dispose();
      // Sans cela, le contexte WebGL vit jusqu'au ramasse-miettes, et la vue
      // web en refuse de nouveaux après quelques imports.
      rendu.forceContextLoss();
      rendu.domElement.remove();
    };
    // `pointDePoseRef` est une référence stable du parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cadrage]);

  // Les décorations : reconstruites à chaque geste et à chaque lot de modèles
  // qui arrive. Les géométries restent ; seules les instances se refont.
  useEffect(() => {
    const m = monde.current;
    if (!m) return;
    m.sortes.clear();
    vider(m.traits);
    m.places.clear();

    const parSorte = new Map<number, Decoration[]>();
    for (const decoration of decorations) {
      const membres = parSorte.get(decoration.id);
      if (membres) membres.push(decoration);
      else parSorte.set(decoration.id, [decoration]);
    }

    const avant = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, COTE_REPERE / 2, 0),
      new THREE.Vector3(COTE_REPERE, COTE_REPERE / 2, 0),
    ]);
    const materiauTrait = new THREE.LineBasicMaterial({ color: jeton("--ink") });

    for (const [id, membres] of parSorte) {
      const maillages = modeles.get(id);
      const source = maillages !== undefined && maillages.length > 0 ? maillages : null;
      let gardee = m.geometries.get(id);
      if (!gardee || gardee.source !== source) {
        gardee?.geometrie.dispose();
        gardee = {
          source,
          geometrie: source
            ? geometrieDe(source)
            : new THREE.BoxGeometry(COTE_REPERE, COTE_REPERE, COTE_REPERE).translate(0, COTE_REPERE / 2, 0),
        };
        m.geometries.set(id, gardee);
      }
      const aUnModele = source !== null;
      const instances = new THREE.InstancedMesh(gardee.geometrie, m.materiau, membres.length);
      instances.userData = { decorations: membres };
      membres.forEach((decoration, rang) => {
        instances.setMatrixAt(rang, matriceDe(decoration, aUnModele));
        m.places.set(decoration.cle, { instances, rang, decoration, aUnModele });
      });
      instances.computeBoundingSphere();
      m.sortes.add(instances);

      if (!aUnModele) {
        for (const decoration of membres) {
          const trait = new THREE.Line(avant, materiauTrait);
          trait.matrixAutoUpdate = false;
          trait.matrix.copy(matriceDe(decoration, false));
          m.traits.add(trait);
        }
      }
    }
    // Une sorte qui a quitté la disposition n'a plus de géométrie à garder.
    for (const [id, { geometrie }] of m.geometries) {
      if (!parSorte.has(id)) {
        geometrie.dispose();
        m.geometries.delete(id);
      }
    }
  }, [decorations, modeles, cadrage]);

  // Les couleurs et les poignées : la sélection s'allume, et le pivot se pose
  // au milieu d'elle.
  useEffect(() => {
    const m = monde.current;
    if (!m) return;
    const couleurModele = jeton("--gold");
    const couleurRepere = jeton("--rain");
    const couleurChoisie = jeton("--crimson");
    const centre = new THREE.Vector3();
    const point = new THREE.Vector3();
    let choisies = 0;
    for (const [cle, place] of m.places) {
      const choisie = selection.has(cle);
      place.instances.setColorAt(
        place.rang,
        choisie ? couleurChoisie : place.aUnModele ? couleurModele : couleurRepere,
      );
      if (choisie) {
        centre.add(point.setFromMatrixPosition(matriceDe(place.decoration, false)));
        choisies += 1;
      }
    }
    couleursAJour(m.sortes);

    if (choisies > 0) {
      m.pivot.position.copy(centre.divideScalar(choisies));
      m.pivot.rotation.set(0, 0, 0);
      m.pivot.scale.set(1, 1, 1);
      m.pivot.updateMatrixWorld();
      m.poignees.attach(m.pivot);
    } else {
      m.poignees.detach();
    }
    m.rendre();
  }, [selection, decorations, modeles, cadrage]);

  // L'outil et son pas.
  useEffect(() => {
    const m = monde.current;
    if (!m) return;
    m.poignees.setMode(MODE_DES_POIGNEES[outil]);
    m.poignees.setTranslationSnap(pasPosition);
    m.poignees.setRotationSnap(pasAngle);
    m.rendre();
  }, [outil, pasPosition, pasAngle, cadrage]);

  return <div ref={conteneur} className="size-full min-h-0" />;
}

/** Les couleurs posées par `setColorAt` partent au prochain rendu. */
function couleursAJour(sortes: THREE.Group) {
  for (const objet of sortes.children) {
    const instances = objet as THREE.InstancedMesh;
    if (instances.instanceColor) instances.instanceColor.needsUpdate = true;
  }
}

/** Retire et libère tout ce qu'un groupe porte. */
function vider(groupe: THREE.Group) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materiaux = new Set<THREE.Material>();
  for (const objet of groupe.children) {
    const porteur = objet as THREE.Mesh | THREE.Line;
    geometries.add(porteur.geometry);
    for (const materiau of [porteur.material].flat()) materiaux.add(materiau);
  }
  groupe.clear();
  geometries.forEach((g) => g.dispose());
  materiaux.forEach((m) => m.dispose());
}
