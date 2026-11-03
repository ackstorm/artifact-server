import {z} from "zod";

import {membershipRoles, principalCapabilities, principalKinds} from "../core/identity.js";
import {memberStatuses} from "../core/installation-identity.js";

// Row shapes shared by the SQLite and Postgres identity repositories.

const membershipRoleSchema = z.enum([
  membershipRoles.administrator,
  membershipRoles.member,
]);

const memberStatusSchema = z.enum([
  memberStatuses.active,
  memberStatuses.inactive,
]);

const principalKindSchema = z.enum([
  principalKinds.human,
  principalKinds.service,
]);

export const principalCapabilitySchema = z.enum([
  principalCapabilities.connectAgents,
  principalCapabilities.createArtifact,
  principalCapabilities.issueContentSession,
  principalCapabilities.manageAnyArtifact,
  principalCapabilities.manageProjects,
  principalCapabilities.publishAnyArtifact,
  principalCapabilities.readArtifacts,
  principalCapabilities.writeComments,
]);

export const memberRowSchema = z.object({
  createdAt: z.string(),
  displayName: z.string(),
  email: z.string(),
  id: z.string(),
  installationId: z.string(),
  role: membershipRoleSchema,
  status: memberStatusSchema,
  updatedAt: z.string(),
});

export const sessionRowSchema = z.object({
  createdAt: z.string(),
  csrfDigest: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  memberCreatedAt: z.string(),
  memberDisplayName: z.string(),
  memberEmail: z.string(),
  memberId: z.string(),
  memberRole: membershipRoleSchema,
  memberStatus: memberStatusSchema,
  memberUpdatedAt: z.string(),
  revokedAt: z.string().nullable(),
  tokenDigest: z.string(),
});

export const apiKeyRowSchema = z.object({
  authorizedByPrincipalId: z.string(),
  capabilitiesJson: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  name: z.string(),
  prefix: z.string(),
  principalId: z.string(),
  principalKind: principalKindSchema,
  revokedAt: z.string().nullable(),
  rotatedFromId: z.string().nullable(),
  secretDigest: z.string(),
});

export const loginAttemptRowSchema = z.object({
  codeVerifier: z.string(),
  createdAt: z.string(),
  expiresAt: z.string(),
  nonce: z.string().nullable(),
  provider: z.string(),
  returnTo: z.string(),
  stateDigest: z.string(),
});
