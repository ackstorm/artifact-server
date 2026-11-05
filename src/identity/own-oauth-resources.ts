import type {OAuthAuthorizationConfiguration} from "../application/oauth-authorization.js";
import type {
  ApiOAuthResourceConfiguration,
  McpOAuthResourceConfiguration,
} from "../http/create-http-app.js";

const scopes = ["artifactserver", "offline_access"];

export interface OwnOAuthResources {
  readonly apiOAuthResource: ApiOAuthResourceConfiguration;
  readonly mcpOAuthResource: McpOAuthResourceConfiguration;
  readonly oauthAuthorization: OAuthAuthorizationConfiguration;
}

/** Discovery documents naming this server as its clients' authorization server. */
export function ownOAuthResources(
  applicationOrigin: string,
  allowedRedirectUris: readonly string[],
): OwnOAuthResources {
  const issuer = new URL(applicationOrigin).origin;
  return {
    apiOAuthResource: {
      authorizationServers: [issuer],
      resource: new URL("/api", issuer).toString(),
    },
    mcpOAuthResource: {
      authorizationServerMetadata: {
        authorization_endpoint: `${issuer}/oauth/authorize`,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        issuer,
        registration_endpoint: `${issuer}/oauth/register`,
        response_types_supported: ["code"],
        revocation_endpoint: `${issuer}/oauth/revoke`,
        scopes_supported: scopes,
        token_endpoint: `${issuer}/oauth/token`,
        token_endpoint_auth_methods_supported: ["none"],
      },
      resource: new URL("/mcp", issuer).toString(),
      scopes,
    },
    oauthAuthorization: {allowedRedirectUris, applicationOrigin: issuer},
  };
}
