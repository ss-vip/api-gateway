import { serve } from "@hono/node-server";
import app, { shutdownDb } from "./src/index.js";

const PORT = parseInt(process.env.PORT || "7860", 10);
const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log("[gateway] running on :" + info.port + " (" + process.pid + ")");
  console.log("[routes] /health | /admin | /v1/chat/completions");
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error("[port] " + PORT + " in use");
  } else {
    console.error("[port] " + e.message);
  }
  process.exit(1);
});

function gracefulShutdown(sig) {
  console.log("[exit] " + sig);
  shutdownDb();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
