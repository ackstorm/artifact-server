import {Effect, Schema} from "effect";
import {SqlClient} from "effect/unstable/sql/SqlClient";
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
import type {PostgresDatabase} from "./postgres-database.js";

const keyIdRowSchema = z.object({api_key_id: z.string()});
const countRowSchema = z.object({count: z.coerce.number()});
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

/** Fails a rotation whose grant update already ran, so the transaction rolls back. */
class OAuthKeyRevoked extends Schema.TaggedError<OAuthKeyRevoked>()(
  "OAuthKeyRevoked",
  {},
) {}

/** Hold the member row against deactivation for the rest of the transaction. */
const lockActiveMember = Effect.fnUntraced(function*(
  sql: SqlClient,
  installationId: string,
  memberId: string,
) {
  const rows = yield* sql`SELECT id FROM installation_members
    WHERE installation_id = ${installationId} AND id = ${memberId}
      AND status = ${memberStatuses.active}
    FOR SHARE`;
  return rows.length > 0;
});

/**
 * OAuth state stored in the installation's Postgres database. Transactions lock
 * rows in member, grant, key order, skipping those they do not touch.
 */
export class PostgresOAuthRepository implements OAuthRepository {
  readonly #database: PostgresDatabase;
  readonly #installationId: string;

  constructor(database: PostgresDatabase, installationId: string) {
    this.#database = database;
    this.#installationId = installationId;
  }

  connectGrant = async (
    grant: OAuthGrant,
    key: StoredManagedApiKey,
    connectedAt: string,
  ): Promise<boolean> => {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen(function*() {
        yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(
          ${`oauth-connect:${installationId}:${grant.clientId}:${grant.memberId}`}, 0
        ))`;
        if (!(yield* lockActiveMember(sql, installationId, grant.memberId))) {
          return false;
        }
        yield* sql`WITH replaced AS (
            DELETE FROM oauth_grants
            WHERE installation_id = ${installationId}
              AND client_id = ${grant.clientId}
              AND member_id = ${grant.memberId}
            RETURNING api_key_id
          )
          UPDATE managed_api_keys
          SET revoked_at = COALESCE(revoked_at, ${connectedAt})
          WHERE installation_id = ${installationId}
            AND id IN (SELECT api_key_id FROM replaced)`;
        yield* sql`INSERT INTO managed_api_keys (
            id, installation_id, name, prefix, secret_digest, principal_id,
            principal_kind, capabilities_json, authorized_by_principal_id,
            created_at, expires_at, revoked_at, rotated_from_id
          ) VALUES (
            ${key.id}, ${key.installationId}, ${key.name}, ${key.prefix},
            ${key.secretDigest}, ${key.principalId}, ${key.principalKind},
            ${JSON.stringify(key.capabilities)}, ${key.authorizedByPrincipalId},
            ${key.createdAt}, ${key.expiresAt}, NULL, NULL
          )`;
        yield* sql`INSERT INTO oauth_grants (
            installation_id, id, client_id, member_id, api_key_id,
            refresh_digest, previous_refresh_digest, created_at,
            refreshed_at, expires_at
          ) VALUES (
            ${installationId}, ${grant.id}, ${grant.clientId}, ${grant.memberId},
            ${grant.apiKeyId}, ${grant.refreshDigest}, NULL,
            ${connectedAt}, ${grant.refreshedAt}, ${grant.expiresAt}
          )`;
        return true;
      }));
    }));
  };

  consumeCode = async (
    codeDigest: string,
    now: string,
  ): Promise<OAuthAuthorizationCode | null> => {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql`DELETE FROM oauth_authorization_codes
        WHERE installation_id = ${installationId} AND code_digest = ${codeDigest}
        RETURNING client_id, code_challenge, code_digest, created_at,
          expires_at, member_id, redirect_uri`;
      const row = rows[0];
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
    }));
  };

  createCode = async (code: OAuthAuthorizationCode): Promise<void> => {
    const installationId = this.#installationId;
    await this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      yield* sql`INSERT INTO oauth_authorization_codes (
          installation_id, code_digest, client_id, member_id, redirect_uri,
          code_challenge, created_at, expires_at
        ) VALUES (
          ${installationId}, ${code.codeDigest}, ${code.clientId}, ${code.memberId},
          ${code.redirectUri}, ${code.codeChallenge}, ${code.createdAt},
          ${code.expiresAt}
        )`;
    }));
  };

  findClient = async (clientId: string): Promise<OAuthClient | null> => {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql`SELECT id, name, redirect_uris_json, created_at
        FROM oauth_clients
        WHERE installation_id = ${installationId} AND id = ${clientId}`;
      const row = rows[0];
      if (row === undefined) return null;
      const client = clientRowSchema.parse(row);
      return {
        createdAt: client.created_at,
        id: client.id,
        name: client.name,
        redirectUris: z.array(z.string()).parse(JSON.parse(client.redirect_uris_json)),
      };
    }));
  };

  findGrantByRefreshDigest = async (
    digest: string,
  ): Promise<OAuthGrant | null> => {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql`SELECT id, client_id, member_id, api_key_id,
          refresh_digest, previous_refresh_digest, refreshed_at, expires_at
        FROM oauth_grants
        WHERE installation_id = ${installationId}
          AND (refresh_digest = ${digest} OR previous_refresh_digest = ${digest})`;
      const row = rows[0];
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
    }));
  };

  hasLiveGrant = async (
    clientId: string,
    memberId: string,
    now: string,
  ): Promise<boolean> => {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      const rows = yield* sql`SELECT COUNT(*) AS count
        FROM oauth_grants AS grants
        JOIN managed_api_keys AS keys
          ON keys.installation_id = grants.installation_id
          AND keys.id = grants.api_key_id
        WHERE grants.installation_id = ${installationId}
          AND grants.client_id = ${clientId}
          AND grants.member_id = ${memberId}
          AND grants.expires_at > ${now}
          AND keys.revoked_at IS NULL`;
      return countRowSchema.parse(rows[0]).count > 0;
    }));
  };

  registerClient = async (
    client: OAuthClient,
    staleBefore: string,
    maximumClients: number,
  ): Promise<boolean> => {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen(function*() {
        yield* sql`DELETE FROM oauth_clients
          WHERE installation_id = ${installationId}
            AND created_at < ${staleBefore}
            AND id NOT IN (
              SELECT client_id FROM oauth_grants
              WHERE installation_id = ${installationId}
            )`;
        const rows = yield* sql`SELECT COUNT(*) AS count FROM oauth_clients
          WHERE installation_id = ${installationId}`;
        if (countRowSchema.parse(rows[0]).count >= maximumClients) return false;
        yield* sql`INSERT INTO oauth_clients (
            installation_id, id, name, redirect_uris_json, created_at
          ) VALUES (
            ${installationId}, ${client.id}, ${client.name},
            ${JSON.stringify(client.redirectUris)}, ${client.createdAt}
          )`;
        return true;
      }));
    }));
  };

  revokeConnection = async (
    grantId: string,
    memberId: string,
    revokedAt: string,
  ): Promise<boolean> => {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen(function*() {
        const removed = yield* sql`DELETE FROM oauth_grants
          WHERE installation_id = ${installationId}
            AND id = ${grantId} AND member_id = ${memberId}
          RETURNING api_key_id`;
        if (removed[0] === undefined) return false;
        const {api_key_id: apiKeyId} = keyIdRowSchema.parse(removed[0]);
        yield* sql`UPDATE managed_api_keys
          SET revoked_at = COALESCE(revoked_at, ${revokedAt})
          WHERE installation_id = ${installationId} AND id = ${apiKeyId}`;
        return true;
      }));
    }));
  };

  rotateGrant = async (rotation: OAuthGrantRotation): Promise<boolean> => {
    const installationId = this.#installationId;
    return this.#database.run(Effect.gen(function*() {
      const sql = yield* SqlClient;
      return yield* sql.withTransaction(Effect.gen(function*() {
        if (!(yield* lockActiveMember(sql, installationId, rotation.memberId))) {
          return false;
        }
        const grant = yield* sql`UPDATE oauth_grants
          SET previous_refresh_digest = refresh_digest,
            refresh_digest = ${rotation.refreshDigest},
            refreshed_at = ${rotation.refreshedAt}
          WHERE installation_id = ${installationId}
            AND id = ${rotation.grantId}
            AND refresh_digest = ${rotation.expectedRefreshDigest}
          RETURNING id`;
        if (grant.length === 0) return false;
        const key = yield* sql`UPDATE managed_api_keys
          SET prefix = ${rotation.keyPrefix},
            secret_digest = ${rotation.keySecretDigest},
            expires_at = ${rotation.keyExpiresAt}
          WHERE installation_id = ${installationId}
            AND id = ${rotation.apiKeyId}
            AND revoked_at IS NULL
          RETURNING id`;
        if (key.length === 0) return yield* new OAuthKeyRevoked();
        return true;
      })).pipe(Effect.catchTag("OAuthKeyRevoked", () => Effect.succeed(false)));
    }));
  };
}
