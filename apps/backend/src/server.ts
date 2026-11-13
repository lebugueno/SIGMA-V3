import mongoose from "mongoose";
import { initializeMongoIndexes } from "@sigma/db-sync";
import { app } from "./app.js";
import { env } from "./config/env.js";

const server = app.listen(env.PORT, () => {
  console.log(`SIGMA backend escuchando en el puerto ${env.PORT}`);
});

try {
  await mongoose.connect(env.MONGODB_URI);
  await initializeMongoIndexes();
  console.log("Conexión a MongoDB establecida");
} catch (error) {
  server.close();
  console.error("No se pudo conectar a MongoDB", error);
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void mongoose.disconnect().finally(() => process.exit(0));
    });
  });
}
