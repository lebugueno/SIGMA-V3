import { Platform } from "react-native";
import { SigmaApiClient } from "@sigma/api-client";

const defaultApiUrl =
  Platform.OS === "android" ? "http://10.0.2.2:3000" : "http://localhost:3000";

const configuredApiUrl = process.env.EXPO_PUBLIC_API_URL?.trim();

export const api = new SigmaApiClient({
  baseUrl: configuredApiUrl || defaultApiUrl
});
