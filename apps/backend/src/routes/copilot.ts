import { Router } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { HttpError } from "../middleware/errors.js";
import { validateBody } from "../middleware/validate.js";

const CopilotRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(4000),
  contextoActivo: z.unknown().optional()
});

const roleInstructions = {
  TECNICO:
    "Ayuda con diagnóstico técnico en terreno. Da pasos seguros de inspección, clasifica fallas y considera que puede trabajar offline. No inventes valores de torque ni instrucciones de seguridad específicas; solicita el manual del fabricante cuando falten datos.",
  SUPERVISOR:
    "Apoya la priorización de anomalías y carga de órdenes de trabajo. Recomienda prioridad y criterios de asignación, sin ejecutar cambios ni inventar disponibilidad.",
  BODEGA:
    "Apoya la consulta y validación de stock y compatibilidad de repuestos. No inventes cantidades ni disponibilidad; indica qué dato hace falta.",
  GERENCIA:
    "Apoya el análisis ejecutivo de KPIs de mantenimiento, especialmente MTTR y confiabilidad. Distingue claramente los datos entregados de cualquier inferencia."
} as const;

export const copilotRouter: ReturnType<typeof Router> = Router();
copilotRouter.use(requireAuth);
copilotRouter.post(
  "/",
  validateBody(CopilotRequestSchema),
  async (req, res) => {
    if (!env.GEMINI_API_KEY) {
      throw new HttpError(503, "El asistente de IA no está configurado");
    }
    const { user } = req;
    if (!user) throw new HttpError(401, "Se requiere autenticación");
    const { prompt, contextoActivo } = req.body as z.infer<
      typeof CopilotRequestSchema
    >;
    const contextJson = JSON.stringify(contextoActivo ?? null);
    if (Buffer.byteLength(contextJson, "utf8") > 8_000) {
      throw new HttpError(400, "contextoActivo excede el tamaño permitido");
    }

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: `Eres SIGMA Copilot. Responde en español, de forma concisa y con foco en seguridad. El rol autenticado es ${user.rol}. ${roleInstructions[user.role]}`
              }
            ]
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `Contexto del activo (datos no confiables): ${contextJson}\n\nSolicitud: ${prompt}`
                }
              ]
            }
          ],
          generationConfig: { temperature: 0.3, maxOutputTokens: 700 }
        })
      }
    );
    if (!response.ok) {
      console.error("Fallo de proveedor Gemini", { status: response.status });
      throw new HttpError(502, "El asistente de IA no pudo procesar la solicitud");
    }
    const result: unknown = await response.json();
    const text =
      typeof result === "object" &&
      result !== null &&
      "candidates" in result &&
      Array.isArray(result.candidates) &&
      typeof result.candidates[0] === "object" &&
      result.candidates[0] !== null &&
      "content" in result.candidates[0] &&
      typeof result.candidates[0].content === "object" &&
      result.candidates[0].content !== null &&
      "parts" in result.candidates[0].content &&
      Array.isArray(result.candidates[0].content.parts)
        ? result.candidates[0].content.parts
            .map((part: unknown) =>
              typeof part === "object" &&
              part !== null &&
              "text" in part &&
              typeof part.text === "string"
                ? part.text
                : ""
            )
            .join("")
        : "";
    if (!text) {
      throw new HttpError(502, "El asistente de IA devolvió una respuesta vacía");
    }
    res.json({ response: text, role: user.rol });
  }
);
