import { Hono } from "hono";
import { cors } from "hono/cors";
import { adminRouter } from "./admin.js";
import { handleProxy } from "./proxy.js";

const app = new Hono({ strict: false });

app.use("*", cors({
  origin: (origin) => origin,
  allowMethods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "Accept", "Accept-Encoding", "Connection", "Cache-Control"],
  exposeHeaders: ["Content-Length", "Content-Type"],
  credentials: true,
  maxAge: 86400,
}));

adminRouter(app);

app.post("/v1/chat/completions", handleProxy);
app.get("/v1/models", async (c) => {
  return c.json({
    object: "list",
    data: [{
      id: "openai",
      object: "model",
      created: 1677610602,
      owned_by: "api-gateway"
    }]
  });
});

app.on(["GET", "POST", "PUT", "DELETE"], "/v1/*", async (c) => {
  return c.json({ error: "Endpoint not supported yet or invalid path" }, 404);
});

export default app;
