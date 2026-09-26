import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Le serveur de développement tourne sur un port fixe : `tauri.conf.json` le
// nomme dans `build.devUrl`, et Tauri n'en cherchera pas un autre.
const PORT = 1420;
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // Les erreurs de compilation s'affichent dans la console, pas par-dessus la
  // fenêtre : un voile d'erreur sur une fenêtre transparente est illisible.
  clearScreen: false,
  server: {
    port: PORT,
    strictPort: true,
    host: host ?? false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // Le dossier Rust se recompile par Tauri, pas par Vite.
      ignored: ["**/src-tauri/**"],
    },
  },
  // Les variables préfixées `TAURI_ENV_*` sont celles que Tauri pose à la
  // compilation : la cible, la plateforme et l'architecture.
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // WebView2 est le moteur sous Windows : c'est lui qui fixe la cible.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: process.env.TAURI_ENV_DEBUG ? false : "esbuild",
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
