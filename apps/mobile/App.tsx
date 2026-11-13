import { useEffect, useRef, useState } from "react";
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from "react-native";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { CameraView, useCameraPermissions } from "expo-camera";
import NetInfo from "@react-native-community/netinfo";
import * as SecureStore from "expo-secure-store";
import { hasPermission } from "@sigma/shared";
import type { Anomaly, WorkOrder } from "@sigma/shared";
import type { AuthResponse } from "@sigma/api-client";
import { api } from "./src/api";
import { powerSync } from "./src/powersync/database";
import { SigmaPowerSyncConnector } from "./src/powersync/connector";

type Screen = "assets" | "report" | "orders";
type AssetRow = {
  id: string;
  asset_code: string;
  qr_code: string;
  nombre: string;
  marca?: string;
  modelo?: string;
  status: string;
};
const colors = {
  background: "#111b22",
  surface: "#1d2b34",
  elevated: "#293a43",
  text: "#f4f6f1",
  muted: "#a8b5b7",
  lime: "#c5e85b",
  amber: "#f4b740",
  red: "#e56e54",
  blue: "#82c5df",
  border: "#40515a"
};
const tenantSql = "tenant_id = ?";

export default function App() {
  const [session, setSession] = useState<AuthResponse["user"] | null>(null);
  const [screen, setScreen] = useState<Screen>("assets");
  const [tenantIdInput, setTenantIdInput] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [pendingReports, setPendingReports] = useState(0);
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<AssetRow | null>(null);
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<Anomaly["severity"]>("MEDIA");
  const [photoUri, setPhotoUri] = useState("");
  const [online, setOnline] = useState<boolean | null>(null);
  const [scanning, setScanning] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [busy, setBusy] = useState(false);
  const [copilotAnswer, setCopilotAnswer] = useState("");
  const [copilotPrompt, setCopilotPrompt] = useState("");
  const syncConnected = useRef(false);
  const syncConnecting = useRef(false);

  const canCreateAnomaly = session
    ? hasPermission(session.role, "anomalies", "create")
    : false;

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      setOnline(Boolean(state.isConnected && state.isInternetReachable !== false));
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!session || !online || syncConnected.current) return;
    void connectSync().catch((error: unknown) => {
      console.warn("No se pudo reconectar PowerSync", error);
    });
  }, [session, online]);

  useEffect(() => {
    let active = true;
    async function restoreSession() {
      const token = await SecureStore.getItemAsync("sigma.jwt");
      const rawUser = await SecureStore.getItemAsync("sigma.user");
      if (!token || !rawUser) return;
      try {
        const user = JSON.parse(rawUser) as AuthResponse["user"];
        api.setToken(token);
        if (active) setSession(user);
        try {
          await connectSync();
        } catch (error) {
          console.warn("PowerSync no está disponible; se mantienen datos locales", error);
        }
      } catch (error) {
        console.error("No se pudo restaurar sesión móvil", error);
      }
    }
    void restoreSession();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!session) return;
    let active = true;
    const watchers: Array<AsyncIterator<{ rows?: { _array: unknown[] } }>> = [];
    async function watchQuery<T>(
      sql: string,
      parameters: unknown[],
      onRows: (rows: T[]) => void
    ) {
      const iterator = powerSync.watch(sql, parameters)[Symbol.asyncIterator]();
      watchers.push(iterator);
      try {
        while (active) {
          const result = await iterator.next();
          if (result.done) return;
          onRows((result.value.rows?._array ?? []) as T[]);
        }
      } catch (error) {
        if (active) console.error("No se pudo observar una consulta PowerSync", error);
      }
    }
    void watchQuery<AssetRow>(
      `SELECT id, asset_code, qr_code, nombre, marca, modelo, status FROM activos WHERE ${tenantSql} ORDER BY asset_code`,
      [session.tenant_id],
      setAssets
    );
    void watchQuery<WorkOrder>(
      `SELECT id, tenant_id, anomaly_id, asset_id, title, description, priority, status, assigned_to, created_by, created_at, updated_at FROM ordenes_trabajo WHERE ${tenantSql} AND assigned_to = ? AND status != 'CERRADA' ORDER BY created_at DESC`,
      [session.tenant_id, session.userId],
      setOrders
    );
    void watchQuery<{ count: number }>(
      "SELECT COUNT(*) AS count FROM anomalias_locales WHERE sync_status != 'SYNCED'",
      [],
      (rows) => setPendingReports(rows[0]?.count ?? 0)
    );
    return () => {
      active = false;
      for (const watcher of watchers) void watcher.return?.();
    };
  }, [session]);

  async function connectSync() {
    if (syncConnected.current || syncConnecting.current) return;
    syncConnecting.current = true;
    try {
      const connector = new SigmaPowerSyncConnector(api);
      await powerSync.connect(connector);
      syncConnected.current = true;
    } finally {
      syncConnecting.current = false;
    }
  }

  async function login() {
    setBusy(true);
    try {
      const result = await api.login({
        tenant_id: tenantIdInput.trim(),
        email: email.trim(),
        password
      });
      await SecureStore.setItemAsync("sigma.jwt", result.token);
      await SecureStore.setItemAsync("sigma.user", JSON.stringify(result.user));
      setSession(result.user);
      try {
        await connectSync();
      } catch (error) {
        console.warn("PowerSync no está disponible; se mantiene sesión local", error);
      }
    } catch (error) {
      Alert.alert("No se pudo iniciar sesión", messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    api.setToken(null);
    await SecureStore.deleteItemAsync("sigma.jwt");
    await SecureStore.deleteItemAsync("sigma.user");
    setSession(null);
  }

  async function attachPhoto() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Permiso requerido", "Permite acceso a fotos para adjuntar evidencia.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      quality: 0.8
    });
    if (result.canceled || !result.assets[0]) return;
    const compressed = await ImageManipulator.manipulateAsync(
      result.assets[0].uri,
      [{ resize: { width: 1400 } }],
      { compress: 0.65, format: ImageManipulator.SaveFormat.JPEG }
    );
    setPhotoUri(compressed.uri);
  }

  async function saveAnomaly() {
    if (!session || !selectedAsset || !description.trim()) return;
    const mutationId = createMutationId();
    const createdAt = new Date().toISOString();
    setBusy(true);
    try {
      await powerSync.execute(
        `INSERT INTO anomalias (id, tenant_id, asset_id, reported_by, description, severity, status, created_at, client_mutation_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          mutationId,
          session.tenant_id,
          selectedAsset.id,
          session.userId,
          description.trim(),
          severity,
          "PENDIENTE",
          createdAt,
          mutationId
        ]
      );
      await powerSync.execute(
        "INSERT INTO anomalias_locales (id, client_mutation_id, photo_uri, sync_status) VALUES (?, ?, ?, ?)",
        [mutationId, mutationId, photoUri || null, "LOCAL"]
      );
      setPendingReports((count) => count + 1);
      setDescription("");
      setPhotoUri("");
      Alert.alert(
        "Reporte guardado",
        online
          ? "El reporte quedó guardado en el dispositivo y se enviará mediante PowerSync."
          : "El reporte quedó guardado localmente. PowerSync lo enviará al recuperar conexión."
      );
    } catch (error) {
      Alert.alert("No se pudo guardar el reporte", messageOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function askCopilot() {
    if (!copilotPrompt.trim()) return;
    try {
      const response = await api.copilot({
        prompt: copilotPrompt,
        contextoActivo: selectedAsset
      });
      setCopilotAnswer(response.response);
      setCopilotPrompt("");
    } catch (error) {
      setCopilotAnswer(messageOf(error));
    }
  }

  function onQrScanned(data: string) {
    const found = assets.find(
      (asset) => asset.qr_code === data || asset.asset_code === data
    );
    setScanning(false);
    if (found) {
      setSelectedAsset(found);
      setScreen("report");
    } else {
      Alert.alert("Activo no encontrado", "El QR no coincide con los activos disponibles offline.");
    }
  }

  if (!session) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar barStyle="light-content" />
        <KeyboardAvoidingView style={styles.loginPage} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.logoBox}><Text style={styles.logo}>Σ</Text></View>
          <Text style={styles.eyebrow}>OPERACIONES EN TERRENO</Text>
          <Text style={styles.title}>SIGMA Terreno</Text>
          <Text style={styles.muted}>Ingresa para sincronizar activos y reportes.</Text>
          <TextInput style={styles.input} placeholder="Tenant ID" placeholderTextColor={colors.muted} value={tenantIdInput} onChangeText={setTenantIdInput} autoCapitalize="none" />
          <TextInput style={styles.input} placeholder="Correo" placeholderTextColor={colors.muted} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
          <TextInput style={styles.input} placeholder="Contraseña" placeholderTextColor={colors.muted} value={password} onChangeText={setPassword} secureTextEntry />
          <TouchButton title={busy ? "Conectando…" : "Iniciar sesión"} onPress={() => void login()} disabled={busy || !tenantIdInput || !email || !password} />
          <Text style={styles.loginHint}>Los reportes pueden guardarse sin conexión.</Text>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" />
      {scanning ? (
        <View style={styles.scannerPage}>
          {cameraPermission?.granted ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={({ data }) => onQrScanned(data)}
            />
          ) : (
            <Text style={styles.muted}>Se necesita permiso de cámara para escanear.</Text>
          )}
          <View style={styles.scannerOverlay}><Text style={styles.scannerTitle}>Escanea el QR del activo</Text><View style={styles.scanTarget} /><TouchButton title="Cancelar" onPress={() => setScanning(false)} /></View>
        </View>
      ) : (
        <>
          <View style={styles.header}>
            <View><Text style={styles.headerTitle}>SIGMA <Text style={styles.headerSub}>TERRENO</Text></Text><Text style={styles.headerUser}>{session.nombre} · {session.rol}</Text></View>
            <View style={[styles.networkBadge, online ? styles.online : styles.offline]}><View style={[styles.networkDot, online ? styles.onlineDot : styles.offlineDot]} /><Text style={styles.networkText}>{online ? "ONLINE" : "OFFLINE"}</Text></View>
          </View>
          <View style={styles.tabs}>
            <TabButton label="Activos / QR" active={screen === "assets"} onPress={() => setScreen("assets")} />
            <TabButton label="Reportar" active={screen === "report"} onPress={() => setScreen("report")} />
            <TabButton label="Mis OTs" active={screen === "orders"} onPress={() => setScreen("orders")} />
          </View>
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {screen === "assets" && (
              <>
                <View style={styles.sectionTitleRow}><View><Text style={styles.eyebrow}>CATÁLOGO DESCARGADO</Text><Text style={styles.sectionTitle}>Activos industriales</Text></View><Text style={styles.countBadge}>{assets.length}</Text></View>
                <TouchButton title="Escanear código QR" onPress={async () => { if (!cameraPermission?.granted) { const result = await requestCameraPermission(); if (!result.granted) return; } setScanning(true); }} />
                <Text style={styles.helper}>Selecciona un activo sincronizado para consultar o reportar una anomalía.</Text>
                {pendingReports > 0 && <Text style={styles.queueBadge}>COLA OFFLINE · {pendingReports} pendiente{pendingReports === 1 ? "" : "s"}</Text>}
                <FlatList
                  data={assets}
                  keyExtractor={(item) => item.id}
                  scrollEnabled={false}
                  ListEmptyComponent={<EmptyState text="No hay activos locales. Conéctate para descargar el catálogo." />}
                  renderItem={({ item }) => <TouchableOpacity style={styles.assetCard} onPress={() => { setSelectedAsset(item); setScreen("report"); }}><View style={styles.assetIcon}><Text style={styles.assetIconText}>⌁</Text></View><View style={styles.assetText}><Text style={styles.assetCode}>{item.asset_code}</Text><Text style={styles.assetName}>{item.nombre}</Text><Text style={styles.assetMeta}>{[item.marca, item.modelo].filter(Boolean).join(" · ")}</Text></View><Text style={styles.chevron}>›</Text></TouchableOpacity>}
                />
              </>
            )}
            {screen === "report" && (
              <>
                <Text style={styles.eyebrow}>HU-02 · CAPTURA OFFLINE-FIRST</Text>
                <Text style={styles.sectionTitle}>Reportar anomalía</Text>
                <Text style={styles.helper}>El registro se guarda primero en el dispositivo y se sincroniza cuando hay conexión.</Text>
                <Text style={styles.label}>Activo</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.assetChoices}>
                  {assets.map((asset) => <TouchableOpacity key={asset.id} style={[styles.assetChoice, selectedAsset?.id === asset.id && styles.assetChoiceSelected]} onPress={() => setSelectedAsset(asset)}><Text style={[styles.choiceTitle, selectedAsset?.id === asset.id && styles.choiceTitleSelected]}>{asset.asset_code}</Text><Text style={styles.choiceSubtitle}>{asset.nombre}</Text></TouchableOpacity>)}
                </ScrollView>
                {!assets.length && <EmptyState text="No hay activos sincronizados; el reporte requiere seleccionar un activo válido." />}
                <Text style={styles.label}>Descripción de la falla</Text>
                <TextInput style={[styles.input, styles.descriptionInput]} value={description} onChangeText={setDescription} placeholder="Describe qué observaste…" placeholderTextColor={colors.muted} multiline textAlignVertical="top" />
                <Text style={styles.label}>Severidad</Text>
                <View style={styles.severityChoices}>{(["BAJA", "MEDIA", "ALTA", "CRITICA"] as const).map((value) => <TouchableOpacity key={value} style={[styles.severityChoice, severity === value && styles.severitySelected, { borderColor: severityColor(value) }]} onPress={() => setSeverity(value)}><Text style={[styles.severityText, { color: severityColor(value) }]}>{value}</Text></TouchableOpacity>)}</View>
                <TouchableOpacity style={styles.photoButton} onPress={() => void attachPhoto()}><Text style={styles.photoIcon}>＋</Text><View><Text style={styles.photoTitle}>{photoUri ? "Evidencia adjunta" : "Adjuntar fotografía"}</Text><Text style={styles.photoSubtitle}>{photoUri ? "Imagen comprimida y guardada localmente" : "Se comprime para uso industrial offline"}</Text></View></TouchableOpacity>
                {canCreateAnomaly && <TouchButton title={busy ? "Guardando en el dispositivo…" : "Guardar reporte"} onPress={() => void saveAnomaly()} disabled={busy || !selectedAsset || !description.trim()} />}
              </>
            )}
            {screen === "orders" && (
              <>
                <Text style={styles.eyebrow}>TRABAJO ASIGNADO</Text><Text style={styles.sectionTitle}>Mis órdenes de trabajo</Text>
                <FlatList data={orders} keyExtractor={(item) => item.id} scrollEnabled={false} ListEmptyComponent={<EmptyState text="No hay órdenes asignadas en este dispositivo." />} renderItem={({ item }) => <View style={styles.orderCard}><View style={styles.orderTop}><Text style={styles.orderAsset}>{item.asset_id}</Text><Text style={[styles.orderPriority, { color: severityColor(item.priority) }]}>{item.priority}</Text></View><Text style={styles.orderTitle}>{item.title}</Text><Text style={styles.orderDescription}>{item.description}</Text><Text style={styles.orderStatus}>{item.status.replaceAll("_", " ")}</Text><TouchableOpacity style={styles.quickCopilot} onPress={() => { setSelectedAsset(assets.find((asset) => asset.id === item.asset_id) ?? null); setScreen("report"); }}><Text style={styles.quickCopilotText}>Diagnóstico con SIGMA Copilot →</Text></TouchableOpacity></View>} />
              </>
            )}
            <View style={styles.copilotCard}><Text style={styles.eyebrow}>ASISTENTE DE TERRENO</Text><Text style={styles.copilotHeading}>SIGMA Copilot</Text><Text style={styles.helper}>Diagnóstico técnico adaptado a tu rol.</Text><TextInput style={styles.input} value={copilotPrompt} onChangeText={setCopilotPrompt} placeholder="Pregunta sobre este activo…" placeholderTextColor={colors.muted} /><TouchButton title="Consultar asistente" onPress={() => void askCopilot()} disabled={!copilotPrompt.trim()} />{!!copilotAnswer && <Text style={styles.copilotAnswer}>{copilotAnswer}</Text>}</View>
            <TouchableOpacity style={styles.logout} onPress={() => void logout()}><Text style={styles.logoutText}>Cerrar sesión</Text></TouchableOpacity>
          </ScrollView>
        </>
      )}
    </SafeAreaView>
  );
}

function TouchButton({ title, onPress, disabled = false }: { title: string; onPress: () => void; disabled?: boolean }) {
  return <TouchableOpacity accessibilityRole="button" activeOpacity={0.8} style={[styles.touchButton, disabled && styles.buttonDisabled]} onPress={onPress} disabled={disabled}><Text style={styles.touchButtonText}>{title}</Text></TouchableOpacity>;
}

function TabButton({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return <TouchableOpacity accessibilityRole="tab" accessibilityState={{ selected: active }} style={[styles.tab, active && styles.tabActive]} onPress={onPress}><Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text></TouchableOpacity>;
}

function EmptyState({ text }: { text: string }) {
  return <View style={styles.emptyState}><Text style={styles.emptyText}>{text}</Text></View>;
}

function createMutationId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `sigma-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function severityColor(value: string): string {
  if (value === "ALTA" || value === "CRITICA") return colors.red;
  if (value === "MEDIA") return colors.amber;
  return colors.blue;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Error inesperado";
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  loginPage: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 24,
    gap: 13
  },
  logoBox: {
    width: 58,
    height: 58,
    borderRadius: 16,
    backgroundColor: colors.lime,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8
  },
  logo: { color: colors.background, fontSize: 36, fontWeight: "900" },
  eyebrow: {
    color: colors.lime,
    fontSize: 10,
    fontWeight: "800",
    letterSpacing: 1.4
  },
  title: { color: colors.text, fontSize: 28, fontWeight: "800" },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 20 },
  input: {
    minHeight: 50,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 9,
    backgroundColor: colors.surface,
    color: colors.text,
    paddingHorizontal: 14,
    fontSize: 14
  },
  loginHint: {
    color: colors.muted,
    textAlign: "center",
    fontSize: 11,
    marginTop: 6
  },
  header: {
    minHeight: 76,
    paddingHorizontal: 17,
    paddingVertical: 11,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: colors.border
  },
  headerTitle: { color: colors.text, fontSize: 18, fontWeight: "900" },
  headerSub: { color: colors.lime, fontSize: 10, letterSpacing: 1.6 },
  headerUser: { color: colors.muted, fontSize: 10, marginTop: 4 },
  networkBadge: {
    minHeight: 34,
    paddingHorizontal: 10,
    borderRadius: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 7
  },
  online: { backgroundColor: "#263d2b" },
  offline: { backgroundColor: "#4b302b" },
  networkDot: { width: 8, height: 8, borderRadius: 4 },
  onlineDot: { backgroundColor: colors.lime },
  offlineDot: { backgroundColor: colors.red },
  networkText: { color: colors.text, fontWeight: "800", fontSize: 9 },
  tabs: {
    flexDirection: "row",
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border
  },
  tab: {
    flex: 1,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderBottomWidth: 3,
    borderBottomColor: "transparent"
  },
  tabActive: { borderBottomColor: colors.lime },
  tabText: { color: colors.muted, fontSize: 11, fontWeight: "700" },
  tabTextActive: { color: colors.lime },
  content: { padding: 17, paddingBottom: 34, gap: 13 },
  sectionTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  sectionTitle: { color: colors.text, fontSize: 21, fontWeight: "800", marginTop: 4 },
  countBadge: {
    color: colors.background,
    backgroundColor: colors.lime,
    minWidth: 34,
    height: 30,
    borderRadius: 15,
    textAlign: "center",
    textAlignVertical: "center",
    fontWeight: "900",
    overflow: "hidden",
    paddingTop: 6
  },
  touchButton: {
    minHeight: 52,
    paddingHorizontal: 16,
    borderRadius: 9,
    backgroundColor: colors.lime,
    alignItems: "center",
    justifyContent: "center"
  },
  buttonDisabled: { opacity: 0.48 },
  touchButtonText: { color: colors.background, fontSize: 13, fontWeight: "900" },
  helper: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  queueBadge: {
    alignSelf: "flex-start",
    color: colors.amber,
    backgroundColor: "#453b27",
    paddingVertical: 8,
    paddingHorizontal: 11,
    borderRadius: 6,
    fontSize: 10,
    fontWeight: "900",
    letterSpacing: 0.6
  },
  assetCard: {
    minHeight: 76,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    padding: 12,
    marginTop: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 12
  },
  assetIcon: {
    width: 42,
    height: 42,
    borderRadius: 10,
    backgroundColor: colors.elevated,
    alignItems: "center",
    justifyContent: "center"
  },
  assetIconText: { color: colors.lime, fontSize: 25, fontWeight: "800" },
  assetText: { flex: 1 },
  assetCode: { color: colors.lime, fontSize: 10, fontWeight: "900" },
  assetName: { color: colors.text, fontSize: 13, fontWeight: "700", marginTop: 3 },
  assetMeta: { color: colors.muted, fontSize: 10, marginTop: 3 },
  chevron: { color: colors.muted, fontSize: 25 },
  label: { color: colors.text, fontSize: 12, fontWeight: "800", marginTop: 4 },
  assetChoices: { gap: 9, paddingVertical: 2 },
  assetChoice: {
    minWidth: 128,
    minHeight: 58,
    justifyContent: "center",
    paddingHorizontal: 11,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    backgroundColor: colors.surface
  },
  assetChoiceSelected: { borderColor: colors.lime, backgroundColor: "#303e2b" },
  choiceTitle: { color: colors.muted, fontSize: 11, fontWeight: "900" },
  choiceTitleSelected: { color: colors.lime },
  choiceSubtitle: { color: colors.text, fontSize: 10, marginTop: 4 },
  descriptionInput: { minHeight: 105, paddingTop: 12 },
  severityChoices: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  severityChoice: {
    minHeight: 48,
    minWidth: 72,
    paddingHorizontal: 10,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 8,
    backgroundColor: colors.surface
  },
  severitySelected: { backgroundColor: colors.elevated },
  severityText: { fontSize: 10, fontWeight: "900" },
  photoButton: {
    minHeight: 62,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
    borderRadius: 9,
    padding: 12
  },
  photoIcon: { color: colors.lime, fontSize: 26 },
  photoTitle: { color: colors.text, fontWeight: "800", fontSize: 12 },
  photoSubtitle: { color: colors.muted, fontSize: 10, marginTop: 4 },
  emptyState: {
    padding: 18,
    borderRadius: 9,
    backgroundColor: colors.surface,
    marginTop: 10
  },
  emptyText: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  orderCard: {
    marginTop: 10,
    padding: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface
  },
  orderTop: { flexDirection: "row", justifyContent: "space-between" },
  orderAsset: { color: colors.lime, fontWeight: "900", fontSize: 10 },
  orderPriority: { fontWeight: "900", fontSize: 10 },
  orderTitle: { color: colors.text, fontSize: 14, fontWeight: "800", marginTop: 10 },
  orderDescription: { color: colors.muted, fontSize: 11, marginTop: 5, lineHeight: 17 },
  orderStatus: { color: colors.blue, fontSize: 10, fontWeight: "900", marginTop: 10 },
  quickCopilot: { minHeight: 48, justifyContent: "center", marginTop: 7 },
  quickCopilotText: { color: colors.lime, fontWeight: "800", fontSize: 11 },
  copilotCard: {
    gap: 10,
    marginTop: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    backgroundColor: colors.surface
  },
  copilotHeading: { color: colors.text, fontSize: 17, fontWeight: "900" },
  copilotAnswer: {
    color: colors.text,
    fontSize: 12,
    lineHeight: 19,
    padding: 12,
    backgroundColor: colors.elevated,
    borderRadius: 8
  },
  logout: { minHeight: 48, alignItems: "center", justifyContent: "center" },
  logoutText: { color: colors.muted, fontSize: 11, fontWeight: "700" },
  scannerPage: { flex: 1, backgroundColor: "#000" },
  scannerOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "space-evenly",
    padding: 24,
    backgroundColor: "#0005"
  },
  scannerTitle: { color: "#fff", fontSize: 18, fontWeight: "900" },
  scanTarget: {
    width: 230,
    height: 230,
    borderWidth: 3,
    borderColor: colors.lime,
    borderRadius: 22
  }
});
