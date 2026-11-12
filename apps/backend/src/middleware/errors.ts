import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: "Solicitud inválida",
      details: error.issues.map(({ path, message }) => ({
        path: path.join("."),
        message
      }))
    });
    return;
  }

  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "TokenExpiredError"
  ) {
    res.status(401).json({ error: "Token expirado" });
    return;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "JsonWebTokenError"
  ) {
    res.status(401).json({ error: "Token inválido" });
    return;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.parse.failed"
  ) {
    res.status(400).json({ error: "El JSON de la solicitud no es válido" });
    return;
  }

  console.error("Error no controlado en API", error);
  res.status(500).json({ error: "Error interno del servidor" });
};
