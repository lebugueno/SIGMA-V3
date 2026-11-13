import { PowerSyncDatabase } from "@powersync/react-native";
import { sigmaSchema } from "./schema";

let powerSync: PowerSyncDatabase | undefined;

export function getPowerSyncDatabase(): PowerSyncDatabase {
  powerSync ??= new PowerSyncDatabase({
    schema: sigmaSchema,
    database: { dbFilename: "sigma.db" }
  });
  return powerSync;
}
