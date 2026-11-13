import { PowerSyncDatabase } from "@powersync/react-native";
import { sigmaSchema } from "./schema";

export const powerSync = new PowerSyncDatabase({
  schema: sigmaSchema,
  database: { dbFilename: "sigma.db" }
});
