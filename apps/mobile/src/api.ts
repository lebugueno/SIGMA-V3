import { Platform } from "react-native";
import { SigmaApiClient } from "@sigma/api-client";

const defaultApiUrl =
  Platform.OS === "android" ? "http://10.0.2.2:3000" : "http://localhost:3000";

export const api = new SigmaApiClient({
  baseUrl: process.env.EXPO_PUBLIC_API_URL ?? defaultApiUrl
});
