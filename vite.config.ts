import react from "@vitejs/plugin-react";
import { defineConfig } from "vite-plus";

const config = {
  plugins: [react() as never],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
};

export default defineConfig(config);
