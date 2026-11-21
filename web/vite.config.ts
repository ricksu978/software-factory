// The SPA's Vite build (redesign step 8a, 2026-11-07 design §04): `npm run build` runs it through scripts/build-spa.ts
// after the type check, and writes web/dist, which the BFF serves (src/bff/spa.ts). "@/" is web/src, as shadcn/ui's
// components.json names it.
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { join } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": join(import.meta.dirname, "src") } },
  build: { outDir: "dist", emptyOutDir: true },
});
