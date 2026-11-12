import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { errorHandler, HttpError } from "./middleware/errors.js";
import { anomaliesRouter } from "./routes/anomalies.js";
import { authRouter } from "./routes/auth.js";
import { copilotRouter } from "./routes/copilot.js";
import { powerSyncRouter } from "./routes/powersync.js";
import { workOrdersRouter } from "./routes/work-orders.js";

const allowedOrigins = new Set(
  env.CORS_ORIGIN.split(",").map((origin) => origin.trim())
);

export const app: Express = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }
      callback(new HttpError(403, "Origen no permitido por CORS"));
    }
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});
app.use("/api/auth", authRouter);
app.use("/api/anomalias", anomaliesRouter);
app.use("/api/ordenes-trabajo", workOrdersRouter);
app.use("/api/powersync", powerSyncRouter);
app.use("/api/ai/copilot", copilotRouter);
app.use((_req, res) => {
  res.status(404).json({ error: "Ruta no encontrada" });
});
app.use(errorHandler);
