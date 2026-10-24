//! Les blocs BC7 : seize pixels en seize octets, sous l'un de huit modes.
//!
//! Le format est celui de Direct3D 11, décrit par sa spécification ; ce module
//! le décode à la manière de bcdec (Sergii Kudlai, domaine public), dont il
//! reprend les tables de partitions.

/// Les bits de couleur et d'alpha d'une extrémité, par mode.
const BITS_COULEUR: [u32; 8] = [4, 6, 5, 7, 5, 7, 7, 5];
const BITS_ALPHA: [u32; 8] = [0, 0, 0, 0, 6, 8, 7, 5];
/// Les modes dont chaque extrémité a son bit P.
const BIT_P_PAR_EXTREMITE: [bool; 8] = [true, false, false, true, false, false, true, true];

const POIDS_2: [u32; 4] = [0, 21, 43, 64];
const POIDS_3: [u32; 8] = [0, 9, 18, 27, 37, 46, 55, 64];
const POIDS_4: [u32; 16] = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

/// Les partitions à deux sous-ensembles : deux bits par pixel, son sous-ensemble.
const PARTITIONS_2: [u32; 64] = [
    0x50505050, 0x40404040, 0x54545454, 0x54505040, 0x50404000, 0x55545450, 0x55545040, 0x54504000,
    0x50400000, 0x55555450, 0x55544000, 0x54400000, 0x55555440, 0x55550000, 0x55555500, 0x55000000,
    0x55150100, 0x00004054, 0x15010000, 0x00405054, 0x00004050, 0x15050100, 0x05010000, 0x40505054,
    0x00404050, 0x05010100, 0x14141414, 0x05141450, 0x01155440, 0x00555500, 0x15014054, 0x05414150,
    0x44444444, 0x55005500, 0x11441144, 0x05055050, 0x05500550, 0x11114444, 0x41144114, 0x44111144,
    0x15055054, 0x01055040, 0x05041050, 0x05455150, 0x14414114, 0x50050550, 0x41411414, 0x00141400,
    0x00041504, 0x00105410, 0x10541000, 0x04150400, 0x50410514, 0x41051450, 0x05415014, 0x14054150,
    0x41050514, 0x41505014, 0x40011554, 0x54150140, 0x50505500, 0x00555050, 0x15151010, 0x54540404,
];
/// Les partitions à trois sous-ensembles.
const PARTITIONS_3: [u32; 64] = [
    0xAA685050, 0x6A5A5040, 0x5A5A4200, 0x5450A0A8, 0xA5A50000, 0xA0A05050, 0x5555A0A0, 0x5A5A5050,
    0xAA550000, 0xAA555500, 0xAAAA5500, 0x90909090, 0x94949494, 0xA4A4A4A4, 0xA9A59450, 0x2A0A4250,
    0xA5945040, 0x0A425054, 0xA5A5A500, 0x55A0A0A0, 0xA8A85454, 0x6A6A4040, 0xA4A45000, 0x1A1A0500,
    0x0050A4A4, 0xAAA59090, 0x14696914, 0x69691400, 0xA08585A0, 0xAA821414, 0x50A4A450, 0x6A5A0200,
    0xA9A58000, 0x5090A0A8, 0xA8A09050, 0x24242424, 0x00AA5500, 0x24924924, 0x24499224, 0x50A50A50,
    0x500AA550, 0xAAAA4444, 0x66660000, 0xA5A0A5A0, 0x50A050A0, 0x69286928, 0x44AAAA44, 0x66666600,
    0xAA444444, 0x54A854A8, 0x95809580, 0x96969600, 0xA85454A8, 0x80959580, 0xAA141414, 0x96960000,
    0xAAAA1414, 0xA05050A0, 0xA0A5A5A0, 0x96000000, 0x40804080, 0xA9A8A9A8, 0xAAAAAA44, 0x2A4A5254,
];
/// Le pixel de référence du second sous-ensemble, à deux sous-ensembles.
const ANCRES_2: [u8; 64] = [
    15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8,
    2, 2, 8, 8, 2, 2, 15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2,
    2, 15, 15, 15, 15, 15, 2, 2, 15,
];
/// Les pixels de référence des deuxième et troisième sous-ensembles.
const ANCRES_3: [[u8; 2]; 64] = [
    [3, 15],
    [3, 8],
    [15, 8],
    [15, 3],
    [8, 15],
    [3, 15],
    [15, 3],
    [15, 8],
    [8, 15],
    [8, 15],
    [6, 15],
    [6, 15],
    [6, 15],
    [5, 15],
    [3, 15],
    [3, 8],
    [3, 15],
    [3, 8],
    [8, 15],
    [15, 3],
    [3, 15],
    [3, 8],
    [6, 15],
    [10, 8],
    [5, 3],
    [8, 15],
    [8, 6],
    [6, 10],
    [8, 15],
    [5, 15],
    [15, 10],
    [15, 8],
    [8, 15],
    [15, 3],
    [3, 15],
    [5, 10],
    [6, 10],
    [10, 8],
    [8, 9],
    [15, 10],
    [15, 6],
    [3, 15],
    [15, 8],
    [5, 15],
    [15, 3],
    [15, 6],
    [15, 6],
    [15, 8],
    [3, 15],
    [15, 3],
    [5, 15],
    [5, 15],
    [5, 15],
    [8, 15],
    [5, 15],
    [10, 15],
    [5, 15],
    [10, 15],
    [8, 15],
    [13, 15],
    [15, 3],
    [12, 15],
    [3, 15],
    [3, 8],
];

/// Les bits d'un bloc, du poids faible au poids fort.
struct Flux(u128);

impl Flux {
    fn lire(&mut self, n: u32) -> u32 {
        let valeur = (self.0 & ((1u128 << n) - 1)) as u32;
        self.0 >>= n;
        valeur
    }
}

fn poids(bits: u32) -> &'static [u32] {
    match bits {
        2 => &POIDS_2,
        3 => &POIDS_3,
        _ => &POIDS_4,
    }
}

fn interpoler(a: u32, b: u32, poids: u32) -> u8 {
    (((64 - poids) * a + poids * b + 32) >> 6) as u8
}

/// Étend une valeur de `bits` bits à huit, en recopiant ses bits forts.
fn etendre(valeur: u32, bits: u32) -> u32 {
    if bits == 0 {
        return 255;
    }
    let v = valeur << (8 - bits);
    v | (v >> bits)
}

/// Les seize pixels RGBA d'un bloc, ligne par ligne.
pub fn decoder_bloc(octets: &[u8; 16]) -> [[u8; 4]; 16] {
    let mut flux = Flux(u128::from_le_bytes(*octets));
    let Some(mode) = (0..8).find(|_| flux.lire(1) == 1) else {
        // Un mode réservé : noir transparent, comme le veut la spécification.
        return [[0; 4]; 16];
    };
    let mode = mode as usize;

    let (sous_ensembles, partition) = match mode {
        0 => (3, flux.lire(4) as usize),
        2 => (3, flux.lire(6) as usize),
        1 | 3 | 7 => (2, flux.lire(6) as usize),
        _ => (1, 0),
    };
    let (rotation, selection) = match mode {
        4 => (flux.lire(2), flux.lire(1)),
        5 => (flux.lire(2), 0),
        _ => (0, 0),
    };

    let extremites = sous_ensembles * 2;
    let mut e = [[0u32; 4]; 6];
    for canal in 0..3 {
        for extremite in e.iter_mut().take(extremites) {
            extremite[canal] = flux.lire(BITS_COULEUR[mode]);
        }
    }
    if BITS_ALPHA[mode] > 0 {
        for extremite in e.iter_mut().take(extremites) {
            extremite[3] = flux.lire(BITS_ALPHA[mode]);
        }
    }

    let avec_bit_p = BIT_P_PAR_EXTREMITE[mode] || mode == 1;
    if avec_bit_p {
        for extremite in e.iter_mut().take(extremites) {
            for valeur in extremite.iter_mut() {
                *valeur <<= 1;
            }
        }
        if mode == 1 {
            // Un bit P par sous-ensemble, partagé par ses deux extrémités.
            let (p0, p1) = (flux.lire(1), flux.lire(1));
            for (i, extremite) in e.iter_mut().take(4).enumerate() {
                for valeur in extremite.iter_mut().take(3) {
                    *valeur |= if i < 2 { p0 } else { p1 };
                }
            }
        } else {
            for extremite in e.iter_mut().take(extremites) {
                let p = flux.lire(1);
                for valeur in extremite.iter_mut() {
                    *valeur |= p;
                }
            }
        }
    }
    let p = u32::from(BIT_P_PAR_EXTREMITE[mode]);
    let bits_couleur = BITS_COULEUR[mode] + if mode == 1 { 1 } else { p };
    let bits_alpha = if BITS_ALPHA[mode] > 0 {
        BITS_ALPHA[mode] + p
    } else {
        0
    };
    for extremite in e.iter_mut().take(extremites) {
        for valeur in extremite.iter_mut().take(3) {
            *valeur = etendre(*valeur, bits_couleur);
        }
        extremite[3] = etendre(extremite[3], bits_alpha);
    }

    let sous_ensemble = |pixel: usize| -> usize {
        match sous_ensembles {
            2 => ((PARTITIONS_2[partition] >> (2 * pixel)) & 3) as usize,
            3 => ((PARTITIONS_3[partition] >> (2 * pixel)) & 3) as usize,
            _ => 0,
        }
    };
    let est_ancre = |pixel: usize| -> bool {
        pixel == 0
            || match sous_ensembles {
                2 => pixel == usize::from(ANCRES_2[partition]),
                3 => ANCRES_3[partition].contains(&(pixel as u8)),
                _ => false,
            }
    };

    let bits_index = match mode {
        0 | 1 => 3,
        6 => 4,
        _ => 2,
    };
    let bits_index2 = match mode {
        4 => 3,
        5 => 2,
        _ => 0,
    };
    // Un index de référence perd son bit fort, toujours nul.
    let mut index = [0u32; 16];
    for (pixel, i) in index.iter_mut().enumerate() {
        *i = flux.lire(bits_index - u32::from(est_ancre(pixel)));
    }
    let mut index2 = [0u32; 16];
    if bits_index2 > 0 {
        for (pixel, i) in index2.iter_mut().enumerate() {
            *i = flux.lire(bits_index2 - u32::from(pixel == 0));
        }
    }

    std::array::from_fn(|pixel| {
        let s = sous_ensemble(pixel);
        let (a, b) = (e[s * 2], e[s * 2 + 1]);
        let (poids_couleur, poids_alpha) = if bits_index2 == 0 {
            let w = poids(bits_index)[index[pixel] as usize];
            (w, w)
        } else if selection == 0 {
            (
                poids(bits_index)[index[pixel] as usize],
                poids(bits_index2)[index2[pixel] as usize],
            )
        } else {
            (
                poids(bits_index2)[index2[pixel] as usize],
                poids(bits_index)[index[pixel] as usize],
            )
        };
        let mut c = [
            interpoler(a[0], b[0], poids_couleur),
            interpoler(a[1], b[1], poids_couleur),
            interpoler(a[2], b[2], poids_couleur),
            interpoler(a[3], b[3], poids_alpha),
        ];
        match rotation {
            1 => c.swap(3, 0),
            2 => c.swap(3, 1),
            3 => c.swap(3, 2),
            _ => {}
        }
        c
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn un_bloc_de_mode_6_uni_se_decode() {
        // Mode 6 : un bit à 1 en position 6, puis deux extrémités RGBA de
        // sept bits, leurs bits P et des index de quatre bits (trois pour le
        // premier). Les deux extrémités valent 127 et le bit P 1 : blanc.
        let mut v: u128 = 1 << 6;
        let mut position = 7;
        let mut ecrire = |valeur: u128, bits: u32| {
            v |= valeur << position;
            position += bits;
        };
        for _ in 0..8 {
            ecrire(127, 7);
        }
        ecrire(1, 1);
        ecrire(1, 1);
        let pixels = decoder_bloc(&v.to_le_bytes());
        assert!(pixels.iter().all(|p| *p == [255, 255, 255, 255]));
    }

    #[test]
    fn un_mode_reserve_rend_du_noir_transparent() {
        assert_eq!(decoder_bloc(&[0; 16]), [[0; 4]; 16]);
    }
}
