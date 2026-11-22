import mongoose from "mongoose";
import { initializeMongoIndexes } from "@sigma/db-sync";
import { app } from "./app.js";
import { env } from "./config/env.js";

const PORT = Number(process.env.PORT) || 3000;

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`SIGMA backend escuchando en el puerto ${PORT}`);
  void initializeDatabase();
});

async function initializeDatabase(): Promise<void> {
  try {
    await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    await initializeMongoIndexes();
    console.log("Conexión a MongoDB establecida");
  } catch (error) {
    console.error("No se pudo conectar a MongoDB o inicializar sus índices", error);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void mongoose.disconnect().finally(() => process.exit(0));
    });
  });
}
