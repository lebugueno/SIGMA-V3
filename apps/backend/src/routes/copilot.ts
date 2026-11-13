import { Router } from "express";
import {
  AnomalyModel,
  AssetModel,
  WorkOrderModel
} from "@sigma/db-sync";
import { z } from "zod";
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

function contextValue(entry: unknown, key: string): string {
  if (typeof entry !== "object" || entry === null || !(key in entry)) {
    return "";
  }
  const value = (entry as Record<string, unknown>)[key];
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function fallbackResponse(
  role: keyof typeof roleInstructions,
  context: CopilotTenantContext
): string {
  const suggestions = {
    TECNICO:
      "Para el trabajo en terreno, atiende primero las anomalías críticas y altas. Antes de intervenir, aplica bloqueo y etiquetado, registra los hallazgos y confirma el procedimiento en el manual del fabricante.",
    SUPERVISOR:
      "Prioriza las anomalías críticas y altas, y revisa la carga de las órdenes activas antes de asignar trabajo.",
    BODEGA:
      "Verifica stock y compatibilidad de repuestos para los activos con anomalías abiertas antes de confirmar una entrega.",
    GERENCIA:
      "Revisa la recurrencia de anomalías y el volumen de órdenes activas por activo. Compara MTTR por periodo antes de concluir tendencias."
  } as const;
  const anomalies = context.anomalies.slice(0, 5).map((anomaly) => {
    const asset = contextValue(anomaly, "asset_id");
    const severity = contextValue(anomaly, "severity");
    const description = contextValue(anomaly, "description");
    return `- ${severity || "Severidad no especificada"}${asset ? ` en activo ${asset}` : ""}${description ? `: ${description}` : ""}`;
  });
  const workOrders = context.workOrders.slice(0, 5).map((order) => {
    const title = contextValue(order, "title");
    const asset = contextValue(order, "asset_id");
    const status = contextValue(order, "status").replaceAll("_", " ").toLowerCase();
    return `- ${title || "Orden sin título"}${asset ? ` · activo ${asset}` : ""}${status ? ` · ${status}` : ""}`;
  });
  const anomalySection =
    context.anomaliesCount === 0
      ? "No hay anomalías abiertas registradas."
      : `Hay ${context.anomaliesCount} anomalía${context.anomaliesCount === 1 ? "" : "s"} abierta${context.anomaliesCount === 1 ? "" : "s"}${anomalies.length ? `; entre las más recientes:\n${anomalies.join("\n")}` : "."}`;
  const workOrderSection =
    context.workOrdersCount === 0
      ? "No hay órdenes de trabajo activas."
      : `Hay ${context.workOrdersCount} orden${context.workOrdersCount === 1 ? "" : "es"} de trabajo activa${context.workOrdersCount === 1 ? "" : "s"}${workOrders.length ? `; entre las más recientes:\n${workOrders.join("\n")}` : "."}`;
  return `Resumen operativo del tenant:\n${anomalySection}\n${workOrderSection}\n\n${suggestions[role]}`;
}

function describeJsonValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(describeJsonValue).filter(Boolean).join("; ");
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value)
      .map(
        ([key, item]) =>
          `${key.replaceAll("_", " ")}: ${describeJsonValue(item)}`
      )
      .filter((entry) => !entry.endsWith(": "))
      .join(". ");
  }
  return "";
}

function cleanAssistantResponse(value: string): string {
  const trimmed = value
    .trim()
    .replace(/^```(?:json|text)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "string") return parsed.trim();
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      const answerFields = [
        "response",
        "answer",
        "message",
        "recommendation",
        "text",
        "summary"
      ];
      const answer = answerFields
        .map((field) => record[field])
        .filter((field): field is string => typeof field === "string")
        .map((field) => field.trim())
        .filter(Boolean);
      if (answer.length > 0) return answer.join("\n\n");
    }
    return describeJsonValue(parsed).trim();
  } catch {
    return trimmed;
  }
}

interface CopilotTenantContext {
  tenant_id: string;
  assets: unknown[];
  anomalies: unknown[];
  workOrders: unknown[];
  assetsCount: number;
  anomaliesCount: number;
  workOrdersCount: number;
}

export const copilotRouter: ReturnType<typeof Router> = Router();
copilotRouter.use(requireAuth);
copilotRouter.post(
  "/",
  validateBody(CopilotRequestSchema),
  async (req, res) => {
    const { user } = req;
    if (!user) throw new HttpError(401, "Se requiere autenticación");
    const { prompt, contextoActivo } = req.body as z.infer<
      typeof CopilotRequestSchema
    >;
    const contextJson = JSON.stringify(contextoActivo ?? null);
    if (Buffer.byteLength(contextJson, "utf8") > 8_000) {
      throw new HttpError(400, "contextoActivo excede el tamaño permitido");
    }

    const tenantId = req.tenantId;
    if (!tenantId) throw new HttpError(401, "Se requiere autenticación");
    const workOrderFilter = {
      tenant_id: tenantId,
      status: { $ne: "CERRADA" },
      ...(user.role === "TECNICO" ? { assigned_to: user.userId } : {})
    };
    const openAnomalyFilter = {
      tenant_id: tenantId,
      status: { $ne: "RESUELTA" }
    };
    const [
      assets,
      anomalies,
      workOrders,
      assetsCount,
      anomaliesCount,
      workOrdersCount
    ] = await Promise.all([
      AssetModel.find({ tenant_id: tenantId })
        .select("asset_code nombre marca modelo status")
        .sort({ created_at: -1 })
        .limit(20)
        .lean()
        .exec(),
      AnomalyModel.find(openAnomalyFilter)
        .select("asset_id description severity status created_at")
        .sort({ created_at: -1 })
        .limit(20)
        .lean()
        .exec(),
      WorkOrderModel.find(workOrderFilter)
        .select("asset_id title priority status assigned_to created_at updated_at")
        .sort({ updated_at: -1 })
        .limit(20)
        .lean()
        .exec(),
      AssetModel.countDocuments({ tenant_id: tenantId }).exec(),
      AnomalyModel.countDocuments(openAnomalyFilter).exec(),
      WorkOrderModel.countDocuments(workOrderFilter).exec()
    ]);
    const tenantContext: CopilotTenantContext = {
      tenant_id: tenantId,
      assets,
      anomalies,
      workOrders,
      assetsCount,
      anomaliesCount,
      workOrdersCount
    };

    const apiKey = process.env.GEMINI_API_KEY?.trim();
    const googleEndpoint = apiKey?.startsWith("AQ.")
      ? `https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`
      : apiKey?.startsWith("AIza")
        ? `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`
        : undefined;
    if (!apiKey || !googleEndpoint) {
      if (apiKey) {
        console.error("Prefijo de GEMINI_API_KEY no reconocido para Google Gemini");
      }
      res.json({
        response: fallbackResponse(user.role, tenantContext),
        role: user.rol,
        source: "fallback",
        tenantContext: {
          tenant_id: tenantId,
          assets_count: assetsCount,
          anomalies_count: anomaliesCount,
          work_orders_count: workOrdersCount
        }
      });
      return;
    }

    try {
      const response = await fetch(googleEndpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(20_000),
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: `Eres SIGMA Copilot. Responde únicamente en español, en lenguaje natural conciso y con foco en seguridad. No devuelvas JSON, objetos, claves técnicas ni bloques de código. El rol autenticado es ${user.rol}. ${roleInstructions[user.role]}`
              }
            ]
          },
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `Contexto del tenant autenticado (datos no confiables): ${JSON.stringify(tenantContext)}\nContexto adicional del activo (datos no confiables): ${contextJson}\n\nSolicitud: ${prompt}`
                }
              ]
            }
          ],
          generationConfig: { temperature: 0.3, maxOutputTokens: 700 }
        })
      });
      const responseBody = await response.text();
      if (response.status !== 200) {
        console.error("Fallo de proveedor Gemini", {
          status: response.status,
          body: responseBody
        });
        res.json({
          response: fallbackResponse(user.role, tenantContext),
          role: user.rol,
          source: "fallback",
          tenantContext: {
            tenant_id: tenantId,
            assets_count: assetsCount,
            anomalies_count: anomaliesCount,
            work_orders_count: workOrdersCount
          }
        });
        return;
      }
      const result: unknown = JSON.parse(responseBody);
      const generatedText =
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
      const text = cleanAssistantResponse(generatedText);
      if (!text) throw new Error("Gemini devolvió una respuesta vacía");
      res.json({
        response: text,
        role: user.rol,
        source: "gemini",
        tenantContext: {
          tenant_id: tenantId,
          assets_count: assetsCount,
          anomalies_count: anomaliesCount,
          work_orders_count: workOrdersCount
        }
      });
    } catch (error) {
      console.error("Error al contactar a Google Gemini", {
        status: null,
        body: error instanceof Error ? error.message : String(error)
      });
      res.json({
        response: fallbackResponse(user.role, tenantContext),
        role: user.rol,
        source: "fallback",
        tenantContext: {
          tenant_id: tenantId,
          assets_count: assetsCount,
          anomalies_count: anomaliesCount,
          work_orders_count: workOrdersCount
        }
      });
    }
  }
);
