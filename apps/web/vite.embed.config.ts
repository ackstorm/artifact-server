import {defineConfig} from "vite";

/** The embed runtime, served by every content host under `/.artifactserver/`. */
export default defineConfig({
  build: {
    emptyOutDir: true,
    modulePreload: false,
    outDir: "../../dist/web/embed",
    rollupOptions: {
      input: {
        diagram: new URL("./src/embed/diagram.ts", import.meta.url).pathname,
        embed: new URL("./src/embed/embed.ts", import.meta.url).pathname,
        table: new URL("./src/embed/table.ts", import.meta.url).pathname,
      },
      // Hash-only names stay inside the asset store's safe path alphabet; the server caches chunks/ as immutable.
      output: {assetFileNames: "chunks/[hash][extname]", chunkFileNames: "chunks/[hash].js", entryFileNames: "[name].js"},
    },
    target: "es2022",
  },
  publicDir: false,
});
