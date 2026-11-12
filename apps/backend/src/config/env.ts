import "dotenv/config";
import { z } from "zod";

const EnvironmentSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  MONGODB_URI: z.string().min(1),
  JWT_SECRET: z.string().min(32, "JWT_SECRET debe tener al menos 32 caracteres"),
  POWERSYNC_URL: z.string().url().optional(),
  POWERSYNC_PRIVATE_KEY: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),
  SEED_PASSWORD: z.string().min(12).optional()
});

const result = EnvironmentSchema.safeParse(process.env);
if (!result.success) {
  throw new Error(`Configuración de entorno inválida: ${result.error.message}`);
}

export const env = result.data;
