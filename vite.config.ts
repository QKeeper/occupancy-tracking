import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

let buildNumber = process.env.BUILD_NUMBER || process.env.GITHUB_RUN_NUMBER || "";
if (!buildNumber) {
  try {
    buildNumber = execSync("git rev-list --count HEAD").toString().trim();
  } catch {
    buildNumber = "1";
  }
}
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "package.json"), "utf8"));
const appVersion = `${pkg.version}.${buildNumber}`;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "redirect-to-production",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const host = (req.headers.host || "").toLowerCase();
          if (!host.includes("localhost") && !host.includes("127.0.0.1") && !host.includes("schedule.ssdk.dev")) {
            const url = req.url || "/";
            const pathname = url.split("?")[0];
            const isInternal =
              pathname.startsWith("/@") ||
              pathname.startsWith("/node_modules") ||
              pathname.startsWith("/src") ||
              pathname.startsWith("/api") ||
              pathname.startsWith("/uploads");
            if (!isInternal && (pathname === "/" || req.headers.accept?.includes("text/html"))) {
              res.statusCode = 302;
              res.setHeader("Location", `https://schedule.ssdk.dev${url}`);
              res.end();
              return;
            }
          }
          next();
        });
      },
    },
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: false,
      },
      "/openapi.json": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
      "/llms.txt": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
      "/uploads": {
        target: "http://127.0.0.1:3001",
        changeOrigin: true,
      },
    },
  },
});
