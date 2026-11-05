import type {StoredManagedApiKey} from "./installation-identity.js";

/** One self-registered public OAuth client. */
export interface OAuthClient {
  readonly createdAt: string;
  readonly id: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
}

/** One single-use authorization code, stored by digest. */
export interface OAuthAuthorizationCode {
  readonly clientId: string;
  readonly codeChallenge: string;
  readonly codeDigest: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly memberId: string;
  readonly redirectUri: string;
}

/** One client's standing authorization to act as one member, fixed-lived from creation. */
export interface OAuthGrant {
  readonly apiKeyId: string;
  readonly clientId: string;
  readonly id: string;
  readonly expiresAt: string;
  readonly memberId: string;
  readonly previousRefreshDigest: string | null;
  readonly refreshDigest: string;
  readonly refreshedAt: string;
}

/** Everything one refresh replaces, applied atomically. */
export interface OAuthGrantRotation {
  readonly apiKeyId: string;
  readonly expectedRefreshDigest: string;
  readonly grantId: string;
  readonly keyExpiresAt: string;
  readonly keyPrefix: string;
  readonly keySecretDigest: string;
  readonly memberId: string;
  readonly refreshDigest: string;
  readonly refreshedAt: string;
}

/** Durable OAuth state for one installation. */
export interface OAuthRepository {
  /**
   * Replace the client's earlier grant for this member and revoke its key.
   * False, with nothing stored, when the member is not active.
   */
  readonly connectGrant: (
    grant: OAuthGrant,
    key: StoredManagedApiKey,
    connectedAt: string,
  ) => Promise<boolean>;
  /** Atomically remove and return one unexpired code. */
  readonly consumeCode: (
    codeDigest: string,
    now: string,
  ) => Promise<OAuthAuthorizationCode | null>;
  readonly createCode: (code: OAuthAuthorizationCode) => Promise<void>;
  readonly findClient: (clientId: string) => Promise<OAuthClient | null>;
  /** Find a grant by its current or previous refresh digest. */
  readonly findGrantByRefreshDigest: (
    digest: string,
  ) => Promise<OAuthGrant | null>;
  readonly hasLiveGrant: (
    clientId: string,
    memberId: string,
    now: string,
  ) => Promise<boolean>;
  /**
   * Insert a client. At the cap, first evict the oldest client with no grant live
   * at client.createdAt, its grants, keys and codes; false when none qualifies.
   */
  readonly registerClient: (
    client: OAuthClient,
    maximumClients: number,
  ) => Promise<boolean>;
  /** Revoke the grant's key and delete the grant; false when not this member's. */
  readonly revokeConnection: (
    grantId: string,
    memberId: string,
    revokedAt: string,
  ) => Promise<boolean>;
  /** Apply one refresh; false when the grant moved, its key is revoked, or its member is not active. */
  readonly rotateGrant: (rotation: OAuthGrantRotation) => Promise<boolean>;
}
