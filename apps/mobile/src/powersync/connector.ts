import type {
  AbstractPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials
} from "@powersync/react-native";
import type { SigmaApiClient } from "@sigma/api-client";

export class SigmaPowerSyncConnector implements PowerSyncBackendConnector {
  constructor(private readonly api: SigmaApiClient) {}

  async fetchCredentials(): Promise<PowerSyncCredentials> {
    const credentials = await this.api.getPowerSyncToken();
    return {
      endpoint: credentials.endpoint,
      token: credentials.token
    };
  }

  async uploadData(database: AbstractPowerSyncDatabase): Promise<void> {
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) return;

    await this.api.uploadCrud(
      transaction.crud.map((entry) => {
        const data = entry.opData ?? {};
        return {
          client_mutation_id:
            typeof data.client_mutation_id === "string"
              ? data.client_mutation_id
              : `${entry.table}:${entry.id}:${entry.clientId}`,
          op: entry.op,
          table: entry.table,
          id: entry.id,
          data
        };
      })
    );
    await transaction.complete();
    for (const entry of transaction.crud) {
      const clientMutationId = entry.opData?.client_mutation_id;
      if (entry.table === "anomalias" && typeof clientMutationId === "string") {
        await database.execute(
          "UPDATE anomalias_locales SET sync_status = 'SYNCED' WHERE client_mutation_id = ?",
          [clientMutationId]
        );
      }
    }
  }
}
