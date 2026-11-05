import {DatabaseSync} from "node:sqlite";

import {z} from "zod";

import {
  memberStatuses,
  type StoredManagedApiKey,
} from "../core/installation-identity.js";
import type {
  OAuthAuthorizationCode,
  OAuthClient,
  OAuthGrant,
  OAuthGrantRotation,
  OAuthRepository,
} from "../core/oauth.js";

const clientRowSchema = z.object({
  created_at: z.string(),
  id: z.string(),
  name: z.string(),
  redirect_uris_json: z.string(),
});
const codeRowSchema = z.object({
  client_id: z.string(),
  code_challenge: z.string(),
  code_digest: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  member_id: z.string(),
  redirect_uri: z.string(),
});
const grantRowSchema = z.object({
  api_key_id: z.string(),
  client_id: z.string(),
  id: z.string(),
  expires_at: z.string(),
  member_id: z.string(),
  previous_refresh_digest: z.string().nullable(),
  refresh_digest: z.string(),
  refreshed_at: z.string(),
});
const countRowSchema = z.object({count: z.number()});

/** OAuth state stored in the installation's SQLite identity database. */
export class SqliteOAuthRepository implements OAuthRepository {
  readonly #database: DatabaseSync;
  readonly #installationId: string;

  constructor(databasePath: string, installationId: string) {
    this.#database = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      open: true,
      timeout: 5_000,
    });
    this.#installationId = installationId;
  }

  close(): void {
    this.#database.close();
  }

  connectGrant = async (
    grant: OAuthGrant,
    key: StoredManagedApiKey,
    connectedAt: string,
  ): Promise<boolean> =>
    this.#transaction(() => {
      if (!this.#memberIsActive(grant.memberId)) return false;
      this.#database.prepare(`
        UPDATE managed_api_keys
        SET revoked_at = COALESCE(revoked_at, ?)
        WHERE installation_id = ? AND id IN (
          SELECT api_key_id FROM oauth_grants
          WHERE installation_id = ? AND client_id = ? AND member_id = ?
        )
      `).run(
        connectedAt,
        this.#installationId,
        this.#installationId,
        grant.clientId,
        grant.memberId,
      );
      this.#database.prepare(`
        DELETE FROM oauth_grants
        WHERE installation_id = ? AND client_id = ? AND member_id = ?
      `).run(this.#installationId, grant.clientId, grant.memberId);
      this.#database.prepare(`
        INSERT INTO managed_api_keys (
          id, installation_id, name, prefix, secret_digest, principal_id,
          principal_kind, capabilities_json, authorized_by_principal_id,
          created_at, expires_at, revoked_at, rotated_from_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `).run(
        key.id,
        key.installationId,
        key.name,
        key.prefix,
        key.secretDigest,
        key.principalId,
        key.principalKind,
        JSON.stringify(key.capabilities),
        key.authorizedByPrincipalId,
        key.createdAt,
        key.expiresAt,
      );
      this.#database.prepare(`
        INSERT INTO oauth_grants (
          installation_id, id, client_id, member_id, api_key_id, refresh_digest,
          previous_refresh_digest, created_at, refreshed_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      `).run(
        this.#installationId,
        grant.id,
        grant.clientId,
        grant.memberId,
        grant.apiKeyId,
        grant.refreshDigest,
        connectedAt,
        grant.refreshedAt,
        grant.expiresAt,
      );
      return true;
    });

  consumeCode = async (
    codeDigest: string,
    now: string,
  ): Promise<OAuthAuthorizationCode | null> => {
    const row = this.#database.prepare(`
      DELETE FROM oauth_authorization_codes
      WHERE installation_id = ? AND code_digest = ?
      RETURNING *
    `).get(this.#installationId, codeDigest);
    if (row === undefined) return null;
    const code = codeRowSchema.parse(row);
    if (code.expires_at <= now) return null;
    return {
      clientId: code.client_id,
      codeChallenge: code.code_challenge,
      codeDigest: code.code_digest,
      createdAt: code.created_at,
      expiresAt: code.expires_at,
      memberId: code.member_id,
      redirectUri: code.redirect_uri,
    };
  };

  createCode = async (code: OAuthAuthorizationCode): Promise<void> => {
    this.#database.prepare(`
      INSERT INTO oauth_authorization_codes (
        installation_id, code_digest, client_id, member_id, redirect_uri,
        code_challenge, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      this.#installationId,
      code.codeDigest,
      code.clientId,
      code.memberId,
      code.redirectUri,
      code.codeChallenge,
      code.createdAt,
      code.expiresAt,
    );
  };

  findClient = async (clientId: string): Promise<OAuthClient | null> => {
    const row = this.#database.prepare(`
      SELECT id, name, redirect_uris_json, created_at FROM oauth_clients
      WHERE installation_id = ? AND id = ?
    `).get(this.#installationId, clientId);
    if (row === undefined) return null;
    const client = clientRowSchema.parse(row);
    return {
      createdAt: client.created_at,
      id: client.id,
      name: client.name,
      redirectUris: z.array(z.string()).parse(JSON.parse(client.redirect_uris_json)),
    };
  };

  findGrantByRefreshDigest = async (
    digest: string,
  ): Promise<OAuthGrant | null> => {
    const row = this.#database.prepare(`
      SELECT id, client_id, member_id, api_key_id, refresh_digest,
        previous_refresh_digest, refreshed_at, expires_at
      FROM oauth_grants
      WHERE installation_id = ?
        AND (refresh_digest = ? OR previous_refresh_digest = ?)
    `).get(this.#installationId, digest, digest);
    if (row === undefined) return null;
    const grant = grantRowSchema.parse(row);
    return {
      apiKeyId: grant.api_key_id,
      clientId: grant.client_id,
      id: grant.id,
      expiresAt: grant.expires_at,
      memberId: grant.member_id,
      previousRefreshDigest: grant.previous_refresh_digest,
      refreshDigest: grant.refresh_digest,
      refreshedAt: grant.refreshed_at,
    };
  };

  hasLiveGrant = async (
    clientId: string,
    memberId: string,
    now: string,
  ): Promise<boolean> => {
    const row = this.#database.prepare(`
      SELECT COUNT(*) AS count
      FROM oauth_grants AS grants
      JOIN managed_api_keys AS keys
        ON keys.installation_id = grants.installation_id
        AND keys.id = grants.api_key_id
      WHERE grants.installation_id = ? AND grants.client_id = ?
        AND grants.member_id = ? AND grants.expires_at > ?
        AND keys.revoked_at IS NULL
    `).get(this.#installationId, clientId, memberId, now);
    return countRowSchema.parse(row).count > 0;
  };

  registerClient = async (
    client: OAuthClient,
    staleBefore: string,
    maximumClients: number,
  ): Promise<boolean> =>
    this.#transaction(() => {
      this.#database.prepare(`
        DELETE FROM oauth_clients
        WHERE installation_id = ? AND created_at < ? AND id NOT IN (
          SELECT client_id FROM oauth_grants WHERE installation_id = ?
        )
      `).run(this.#installationId, staleBefore, this.#installationId);
      const state = countRowSchema.parse(this.#database.prepare(`
        SELECT COUNT(*) AS count FROM oauth_clients WHERE installation_id = ?
      `).get(this.#installationId));
      if (state.count >= maximumClients) return false;
      this.#database.prepare(`
        INSERT INTO oauth_clients (
          installation_id, id, name, redirect_uris_json, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        this.#installationId,
        client.id,
        client.name,
        JSON.stringify(client.redirectUris),
        client.createdAt,
      );
      return true;
    });

  revokeConnection = async (
    grantId: string,
    memberId: string,
    revokedAt: string,
  ): Promise<boolean> =>
    this.#transaction(() => {
      const removed = this.#database.prepare(`
        DELETE FROM oauth_grants
        WHERE installation_id = ? AND id = ? AND member_id = ?
        RETURNING api_key_id
      `).get(this.#installationId, grantId, memberId);
      if (removed === undefined) return false;
      const {api_key_id: apiKeyId} = z.object({api_key_id: z.string()}).parse(removed);
      this.#database.prepare(`
        UPDATE managed_api_keys SET revoked_at = COALESCE(revoked_at, ?)
        WHERE installation_id = ? AND id = ?
      `).run(revokedAt, this.#installationId, apiKeyId);
      return true;
    });

  rotateGrant = async (rotation: OAuthGrantRotation): Promise<boolean> =>
    this.#transaction(() => {
      if (!this.#memberIsActive(rotation.memberId)) return false;
      const grant = this.#database.prepare(`
        UPDATE oauth_grants
        SET previous_refresh_digest = refresh_digest, refresh_digest = ?,
          refreshed_at = ?
        WHERE installation_id = ? AND id = ? AND refresh_digest = ?
          AND EXISTS (
            SELECT 1 FROM managed_api_keys
            WHERE installation_id = ? AND id = ? AND revoked_at IS NULL
          )
      `).run(
        rotation.refreshDigest,
        rotation.refreshedAt,
        this.#installationId,
        rotation.grantId,
        rotation.expectedRefreshDigest,
        this.#installationId,
        rotation.apiKeyId,
      );
      if (grant.changes === 0) return false;
      this.#database.prepare(`
        UPDATE managed_api_keys
        SET prefix = ?, secret_digest = ?, expires_at = ?
        WHERE installation_id = ? AND id = ?
      `).run(
        rotation.keyPrefix,
        rotation.keySecretDigest,
        rotation.keyExpiresAt,
        this.#installationId,
        rotation.apiKeyId,
      );
      return true;
    });

  #memberIsActive(memberId: string): boolean {
    return this.#database.prepare(`
      SELECT 1 FROM installation_members
      WHERE installation_id = ? AND id = ? AND status = ?
    `).get(this.#installationId, memberId, memberStatuses.active) !== undefined;
  }

  #transaction<A>(run: () => A): A {
    this.#database.exec("BEGIN IMMEDIATE;");
    try {
      const result = run();
      this.#database.exec("COMMIT;");
      return result;
    } catch (cause) {
      this.#database.exec("ROLLBACK;");
      throw cause;
    }
  }
}
