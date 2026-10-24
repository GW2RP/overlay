import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type { Decoration, Maillage } from "@/lib/pavillon";

/**
 * Le pavillon en trois dimensions.
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
 * Three.js veut y vers le haut : `versThree` passe d'un repère à l'autre.
 * Les sommets des modèles y passent une fois, à la construction ; les
 * placements se conjuguent (`B·M·B`), ce qui garde leur déterminant positif.
 */

/** Le côté d'un repère, en pouces : la taille d'un coffre. */
const COTE_REPERE = 60;

/** Du repère du jeu à celui de three.js : (x, y, z) → (x, -z, -y). C'est une
 *  symétrie — le jeu compte dans un repère indirect — et non une rotation. */
const VERS_THREE = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, -1, 0, 0, -1, 0, 0, 0, 0, 0, 1);

/** La place d'une décoration dans la scène. La convention des rotations du
 *  jeu n'est pas documentée ; elle est **mesurée** sur la Serre Silvie, dont
 *  le toit tient sur des murs inclinés sur deux axes : les angles se lisent
 *  dans le sens inverse, et s'appliquent z d'abord, puis y, puis x. Toute
 *  autre lecture couche les murs du toit et fait sortir les chevrons du
 *  pavillon. */
function matriceDe(decoration: Decoration, avecEchelle: boolean): THREE.Matrix4 {
  const [x, y, z] = decoration.position;
  const [rx, ry, rz] = decoration.rotation;
  const echelle = avecEchelle ? decoration.echelle : 1;
  const placement = new THREE.Matrix4()
    .makeTranslation(x, y, z)
    .multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-rx, -ry, -rz, "XYZ")))
    .multiply(new THREE.Matrix4().makeScale(echelle, echelle, echelle));
  return VERS_THREE.clone().multiply(placement).multiply(VERS_THREE);
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
  const valeur = getComputedStyle(document.documentElement).getPropertyValue(nom).trim();
  return new THREE.Color(valeur || "#808080");
}

type Monde = {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  rendre: () => void;
  /** Les décorations, un maillage instancié par sorte. */
  sortes: THREE.Group;
  /** L'avant des repères. */
  traits: THREE.Group;
};

type Props = {
  decorations: Decoration[];
  /** Les modèles déjà lus, par sorte ; une liste vide pour une sorte sans
   *  modèle. Une sorte absente attend le sien. */
  modeles: Map<number, Maillage[]>;
  /** La sorte choisie dans la liste : ses décorations s'allument. */
  choisie: number | null;
  /** Une décoration cliquée dans la scène. */
  onChoisir: (decoration: Decoration | null) => void;
};

export function ScenePavillon({ decorations, modeles, choisie, onChoisir }: Props) {
  const conteneur = useRef<HTMLDivElement>(null);
  const monde = useRef<Monde | null>(null);
  // Le rappel le plus récent, lu par le clic : la scène ne se reconstruit
  // pas parce que le parent a redessiné.
  const onChoisirCourant = useRef(onChoisir);
  useEffect(() => {
    onChoisirCourant.current = onChoisir;
  }, [onChoisir]);

  // La scène, la caméra et leurs commandes : une fois par disposition.
  useEffect(() => {
    const hote = conteneur.current;
    if (!hote || decorations.length === 0) return;

    const rendu = new THREE.WebGLRenderer({ antialias: true });
    rendu.setPixelRatio(window.devicePixelRatio);
    hote.appendChild(rendu.domElement);

    const scene = new THREE.Scene();
    scene.background = jeton("--ground");
    scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2.2));
    const soleil = new THREE.DirectionalLight(0xffffff, 1.4);
    soleil.position.set(1, 2, 1.5);
    scene.add(soleil);

    const sortes = new THREE.Group();
    const traits = new THREE.Group();
    scene.add(sortes, traits);

    // Le cadre : la caméra embrasse toutes les décorations.
    const boite = new THREE.Box3();
    const point = new THREE.Vector3();
    for (const decoration of decorations) {
      boite.expandByPoint(point.setFromMatrixPosition(matriceDe(decoration, false)));
    }
    const centre = boite.getCenter(new THREE.Vector3());
    const rayon = Math.max(boite.getSize(new THREE.Vector3()).length() / 2, COTE_REPERE * 4);

    const camera = new THREE.PerspectiveCamera(50, 1, 10, rayon * 40);
    camera.position.copy(centre).add(new THREE.Vector3(rayon, rayon * 1.1, rayon));
    const controles = new OrbitControls(camera, rendu.domElement);
    controles.target.copy(centre);

    const sol = new THREE.GridHelper(rayon * 4, 40, jeton("--rule"), jeton("--hairline"));
    sol.position.set(centre.x, boite.min.y, centre.z);
    scene.add(sol);

    const rendre = () => rendu.render(scene, camera);
    controles.addEventListener("change", rendre);
    controles.update();

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

    // Un clic sans glissé choisit la décoration sous le curseur.
    const lancer = new THREE.Raycaster();
    let appui: { x: number; y: number } | null = null;
    const surAppui = (e: PointerEvent) => {
      appui = { x: e.clientX, y: e.clientY };
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
      onChoisirCourant.current(
        membres && touche.instanceId != null ? (membres[touche.instanceId] ?? null) : null,
      );
    };
    rendu.domElement.addEventListener("pointerdown", surAppui);
    rendu.domElement.addEventListener("pointerup", surRelache);

    monde.current = { scene, camera, rendre, sortes, traits };

    return () => {
      monde.current = null;
      vider(sortes);
      vider(traits);
      observateur.disconnect();
      controles.dispose();
      rendu.domElement.removeEventListener("pointerdown", surAppui);
      rendu.domElement.removeEventListener("pointerup", surRelache);
      rendu.dispose();
      rendu.domElement.remove();
    };
  }, [decorations]);

  // Les décorations : reconstruites à chaque modèle qui arrive. Quelques
  // centaines de maillages instanciés, c'est l'affaire d'une image.
  useEffect(() => {
    const courant = monde.current;
    if (!courant) return;
    vider(courant.sortes);
    vider(courant.traits);

    const parSorte = new Map<number, Decoration[]>();
    for (const decoration of decorations) {
      const membres = parSorte.get(decoration.id);
      if (membres) membres.push(decoration);
      else parSorte.set(decoration.id, [decoration]);
    }

    const couleurModele = jeton("--gold");
    const couleurRepere = jeton("--rain");
    const couleurChoisie = jeton("--crimson");
    const avant = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, COTE_REPERE / 2, 0),
      new THREE.Vector3(COTE_REPERE, COTE_REPERE / 2, 0),
    ]);
    const materiauTrait = new THREE.LineBasicMaterial({ color: jeton("--ink") });

    for (const [id, membres] of parSorte) {
      const maillages = modeles.get(id);
      const aUnModele = maillages !== undefined && maillages.length > 0;
      const geometrie = aUnModele
        ? geometrieDe(maillages)
        : new THREE.BoxGeometry(COTE_REPERE, COTE_REPERE, COTE_REPERE).translate(0, COTE_REPERE / 2, 0);
      const materiau = new THREE.MeshLambertMaterial({
        color: id === choisie ? couleurChoisie : aUnModele ? couleurModele : couleurRepere,
        side: THREE.DoubleSide,
      });
      const instances = new THREE.InstancedMesh(geometrie, materiau, membres.length);
      instances.userData = { id, decorations: membres, aUnModele };
      membres.forEach((decoration, i) => instances.setMatrixAt(i, matriceDe(decoration, aUnModele)));
      instances.computeBoundingSphere();
      courant.sortes.add(instances);

      if (!aUnModele) {
        for (const decoration of membres) {
          const trait = new THREE.Line(avant, materiauTrait);
          trait.matrixAutoUpdate = false;
          trait.matrix.copy(matriceDe(decoration, false));
          courant.traits.add(trait);
        }
      }
    }
    courant.rendre();
    // `choisie` est appliquée par l'effet suivant, sans tout reconstruire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decorations, modeles]);

  // La sorte choisie s'allume.
  useEffect(() => {
    const courant = monde.current;
    if (!courant) return;
    const couleurModele = jeton("--gold");
    const couleurRepere = jeton("--rain");
    const couleurChoisie = jeton("--crimson");
    for (const objet of courant.sortes.children) {
      const instances = objet as THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
      const { id, aUnModele } = instances.userData as { id: number; aUnModele: boolean };
      instances.material.color.copy(
        id === choisie ? couleurChoisie : aUnModele ? couleurModele : couleurRepere,
      );
    }
    courant.rendre();
  }, [choisie, decorations, modeles]);

  return <div ref={conteneur} className="size-full min-h-0" />;
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
