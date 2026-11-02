import {createServer, type Server} from "node:http";

import {exportJWK, generateKeyPair, type JWK} from "jose";
import {Predicate} from "effect";

export const realmPath = "/realms/artifact";
export const providerUserEmail = "administrator@example.test";
export const providerSubject = "9f1d2c3b-0000-4000-8000-artifactserver";

export interface ProviderBoundary {
  readonly issuer: string;
  close(): Promise<void>;
  setKeysStatus(status: number): void;
  setUserInfoStatus(status: number): void;
  userInfoRequests(): number;
}

export async function startProviderBoundary(options: {
  readonly jwk: JWK;
}): Promise<ProviderBoundary> {
  let keysStatus = 200;
  let userInfoRequestCount = 0;
  let userInfoStatus = 200;
  let issuer = "";
  const provider = createServer((request, response) => {
    if (request.url === `${realmPath}/.well-known/openid-configuration`) {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(discoveryDocument(issuer)));
      return;
    }
    if (request.url === `${realmPath}/protocol/openid-connect/certs`) {
      if (keysStatus !== 200) {
        response.statusCode = keysStatus;
        response.end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({keys: [options.jwk]}));
      return;
    }
    if (request.url === `${realmPath}/protocol/openid-connect/userinfo`) {
      userInfoRequestCount += 1;
      if (userInfoStatus !== 200) {
        response.statusCode = userInfoStatus;
        response.end();
        return;
      }
      if (request.headers.authorization?.startsWith("Bearer ") !== true) {
        response.statusCode = 401;
        response.end();
        return;
      }
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({
        email: providerUserEmail,
        email_verified: true,
        family_name: "Administrator",
        given_name: "Artifact",
        sub: providerSubject,
      }));
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await listen(provider);
  const address = provider.address();
  if (address === null || Predicate.isString(address)) {
    throw new Error("The OIDC test boundary did not bind a TCP port.");
  }
  issuer = `http://127.0.0.1:${address.port}${realmPath}`;
  return {
    close: () => close(provider),
    issuer,
    setKeysStatus: (status) => {
      keysStatus = status;
    },
    setUserInfoStatus: (status) => {
      userInfoStatus = status;
    },
    userInfoRequests: () => userInfoRequestCount,
  };
}

export async function exportedJwk(keyId: string): Promise<JWK> {
  const keys = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(keys.publicKey);
  return {...publicJwk, alg: "RS256", kid: keyId, use: "sig"};
}

export function discoveryDocument(issuer: string) {
  return {
    authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
    code_challenge_methods_supported: ["S256"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    issuer,
    jwks_uri: `${issuer}/protocol/openid-connect/certs`,
    registration_endpoint: `${issuer}/clients-registrations/openid-connect`,
    response_types_supported: ["code"],
    scopes_supported: ["openid", "profile", "email"],
    token_endpoint: `${issuer}/protocol/openid-connect/token`,
    userinfo_endpoint: `${issuer}/protocol/openid-connect/userinfo`,
  };
}

type DiscoveryDocument = ReturnType<typeof discoveryDocument>;

export function documentResponse(document: DiscoveryDocument): Response {
  return new Response(JSON.stringify(document), {
    headers: {"Content-Type": "application/json"},
    status: 200,
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}
