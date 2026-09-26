// Pas de console noire derrière la fenêtre sous Windows en version publiée.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    gw2rp_overlay_lib::run()
}
