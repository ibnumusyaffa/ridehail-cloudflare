import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // maplibre v6 loads its worker relative to its own module; pre-bundling breaks that URL
  optimizeDeps: { exclude: ["maplibre-gl"] },
  server: { port: Number(process.env.PORT ?? 5173), strictPort: true },
});
