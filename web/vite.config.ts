import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * Two build outputs from one source tree.
 *
 *  - `web/dist` is the standalone workbench a person can host.
 *  - `extension/dist/pages/workbench.html` is the same app, loaded from inside
 *    the extension. The only difference is the storage adapter, which is chosen
 *    at runtime by feature detection, so no code has to fork.
 */
export default defineConfig(({ mode }) => {
  const forExtension = mode === "extension";
  return {
    root: here,
    base: forExtension ? "/pages/" : "/",
    plugins: [react()],
    resolve: {
      alias: {
        "@quill/core": resolve(here, "../packages/core/src/index.ts"),
        "@quill/design": resolve(here, "../packages/design"),
      },
    },
    build: {
      outDir: forExtension ? resolve(here, "../extension/dist/pages") : resolve(here, "dist"),
      emptyOutDir: !forExtension,
      target: "chrome116",
      sourcemap: true,
      rollupOptions: forExtension
        ? {
            // The extension needs one HTML entry and relative asset paths.
            input: resolve(here, "index.html"),
            output: {
              entryFileNames: "workbench.js",
              chunkFileNames: "workbench-[name].js",
              /*
               * Chunk and asset names must stay distinct. An earlier version
               * forced every asset to `workbench[extname]`, which collided the
               * moment a second asset appeared (the PDF worker and the mammoth
               * chunk both wanted `workbench.js`). Prefixed `[name]` keeps them
               * apart while still marking the extension build as ours.
               */
              assetFileNames: "workbench-[name][extname]",
            },
          }
        : undefined,
    },
    server: { port: 5173, open: false },
  };
});
