import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";

export default defineConfig({
  plugins: [
    react(),
    ...(!process.env.WEB_PREVIEW
      ? [
          electron({
            main: {
              entry: "electron/main.ts",
              vite: { build: { rollupOptions: { external: ["electron"] } } },
            },
            preload: { input: "electron/preload.ts" },
          }),
        ]
      : []),
  ],
});
