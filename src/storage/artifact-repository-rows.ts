import {z} from "zod";

import {principalKinds} from "../core/identity.js";
import {
  accessSettings,
  agentBeaconStates,
  agentDispatchStates,
  commentThreadStates,
  parseStoredAgentCapabilities,
  reviewModes,
  type AgentDispatchRecord,
  type CommentAuthor,
  type CommentReplyRecord,
  type CommentThreadRecord,
  type PageCursor,
} from "../core/model.js";

// Row shapes and row-to-record mappers shared by the SQLite and Postgres artifact repositories.

export const accessSettingSchema = z.enum([
  accessSettings.private,
  accessSettings.accountRequired,
  accessSettings.publicLink,
]);

export const reviewModeSchema = z.enum([reviewModes.annotate, reviewModes.interact]);

export const idempotencyRowSchema = z.object({
  reviewMode: reviewModeSchema,
  accessSetting: accessSettingSchema.nullable(),
  artifactId: z.string(),
  inputDigest: z.string(),
  operation: z.enum([
    "change_access",
    "change_review_mode",
    "change_tags",
    "delete",
    "publish",
    "restore",
  ]),
  tagsJson: z.string().nullable(),
  versionId: z.string(),
});

export const stagedUploadGrantRowSchema = z.object({
  grantDigest: z.string().nullable(),
  principalId: z.string(),
  projectId: z.string(),
});

export const expiredStagedUploadRowSchema = z.object({
  id: z.string(),
  storageToken: z.string(),
});

export const projectRowSchema = z.object({
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  name: z.string(),
});

const commentPrincipalKindSchema = z.enum([
  principalKinds.human,
  principalKinds.service,
]);

const commentThreadStateSchema = z.enum([
  commentThreadStates.open,
  commentThreadStates.resolved,
]);

export const commentThreadRowSchema = z.object({
  anchorJson: z.string().nullable(),
  artifactId: z.string(),
  authorAuthorizedByPrincipalId: z.string().nullable(),
  authorDisplayName: z.string(),
  authorPrincipalId: z.string(),
  authorPrincipalKind: commentPrincipalKindSchema,
  body: z.string(),
  createdAt: z.string(),
  id: z.string(),
  installationId: z.string(),
  path: z.string().nullable(),
  projectId: z.string(),
  replyCount: z.coerce.number().int().nonnegative(),
  resolvedAt: z.string().nullable(),
  resolvedByAuthorizedByPrincipalId: z.string().nullable(),
  resolvedByDisplayName: z.string().nullable(),
  resolvedByPrincipalId: z.string().nullable(),
  resolvedByPrincipalKind: commentPrincipalKindSchema.nullable(),
  state: commentThreadStateSchema,
  updatedAt: z.string(),
  versionId: z.string(),
});

export const commentReplyRowSchema = z.object({
  authorAuthorizedByPrincipalId: z.string().nullable(),
  authorDisplayName: z.string(),
  authorPrincipalId: z.string(),
  authorPrincipalKind: commentPrincipalKindSchema,
  body: z.string(),
  createdAt: z.string(),
  id: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  updatedAt: z.string(),
});

const agentBeaconStateSchema = z.enum([
  agentBeaconStates.idle,
  agentBeaconStates.replying,
  agentBeaconStates.thinking,
]);

export const registeredAgentRowSchema = z.object({
  activityAt: z.string().nullable(),
  activityState: agentBeaconStateSchema.nullable(),
  agentSessionId: z.string().nullable(),
  capabilitiesJson: z.string().nullable(),
  connectionKey: z.string(),
  createdAt: z.string(),
  displayName: z.string(),
  id: z.string(),
  installationId: z.string(),
  kind: z.string(),
  lastSeenAt: z.string(),
  principalId: z.string(),
  workingDirectory: z.string(),
}).transform(({capabilitiesJson, ...agent}) => ({
  ...agent,
  capabilities: parseStoredAgentCapabilities(capabilitiesJson),
}));

export const agentDispatchStateSchema = z.enum([
  agentDispatchStates.addressed,
  agentDispatchStates.canceled,
  agentDispatchStates.claimed,
  agentDispatchStates.delivered,
  agentDispatchStates.failed,
  agentDispatchStates.queued,
]);

export const agentDispatchRowSchema = z.object({
  addressedAt: z.string().nullable(),
  agentDisplayName: z.string(),
  agentId: z.string(),
  canceledAt: z.string().nullable(),
  claimedAt: z.string().nullable(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  failureReason: z.string().nullable(),
  id: z.string(),
  idempotencyKey: z.string(),
  installationId: z.string(),
  leaseExpiresAt: z.string().nullable(),
  note: z.string().nullable(),
  projectId: z.string(),
  senderAuthorizedByPrincipalId: z.string().nullable(),
  senderDisplayName: z.string(),
  senderPrincipalId: z.string(),
  senderPrincipalKind: commentPrincipalKindSchema,
  state: agentDispatchStateSchema,
  threadIdsJson: z.string(),
  updatedAt: z.string(),
});

export const dispatchThreadCheckRowSchema = z.object({
  dispatchId: z.string().nullable(),
  id: z.string(),
  state: commentThreadStateSchema,
});

export const threadIdsSchema = z.array(z.string());

export const latestDispatchTransitionRowSchema = z.object({
  latestAt: z.string().nullable(),
});

export const workingDispatchCandidateRowSchema = z.object({
  id: z.string(),
  threadIdsJson: z.string(),
});

export const clearableThreadRowSchema = z.object({
  dispatchState: agentDispatchStateSchema.nullable(),
  id: z.string(),
  versionId: z.string(),
});

interface PageResult<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: PageCursor | null;
}

function commentAuthorFromRow(
  row: z.infer<typeof commentThreadRowSchema> | z.infer<typeof commentReplyRowSchema>,
): CommentAuthor {
  return {
    authorizedByPrincipalId: row.authorAuthorizedByPrincipalId,
    displayName: row.authorDisplayName,
    principalId: row.authorPrincipalId,
    principalKind: row.authorPrincipalKind,
  };
}

export function commentThreadFromRow(
  row: z.infer<typeof commentThreadRowSchema>,
): CommentThreadRecord {
  return {
    anchor: row.anchorJson === null ? null : JSON.parse(row.anchorJson),
    artifactId: row.artifactId,
    author: commentAuthorFromRow(row),
    body: row.body,
    createdAt: row.createdAt,
    id: row.id,
    installationId: row.installationId,
    path: row.path,
    projectId: row.projectId,
    replyCount: row.replyCount,
    resolvedAt: row.resolvedAt,
    resolvedBy: row.resolvedByPrincipalId === null ||
        row.resolvedByPrincipalKind === null ||
        row.resolvedByDisplayName === null
      ? null
      : {
        authorizedByPrincipalId: row.resolvedByAuthorizedByPrincipalId,
        displayName: row.resolvedByDisplayName,
        principalId: row.resolvedByPrincipalId,
        principalKind: row.resolvedByPrincipalKind,
      },
    state: row.state,
    updatedAt: row.updatedAt,
    versionId: row.versionId,
  };
}

export function commentReplyFromRow(
  row: z.infer<typeof commentReplyRowSchema>,
): CommentReplyRecord {
  return {
    author: commentAuthorFromRow(row),
    body: row.body,
    createdAt: row.createdAt,
    id: row.id,
    projectId: row.projectId,
    threadId: row.threadId,
    updatedAt: row.updatedAt,
  };
}

export function agentDispatchFromRow(
  row: z.infer<typeof agentDispatchRowSchema>,
): AgentDispatchRecord {
  return {
    addressedAt: row.addressedAt,
    agentDisplayName: row.agentDisplayName,
    agentId: row.agentId,
    canceledAt: row.canceledAt,
    claimedAt: row.claimedAt,
    createdAt: row.createdAt,
    deliveredAt: row.deliveredAt,
    failedAt: row.failedAt,
    failureReason: row.failureReason,
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    installationId: row.installationId,
    leaseExpiresAt: row.leaseExpiresAt,
    note: row.note,
    projectId: row.projectId,
    sender: {
      authorizedByPrincipalId: row.senderAuthorizedByPrincipalId,
      displayName: row.senderDisplayName,
      principalId: row.senderPrincipalId,
      principalKind: row.senderPrincipalKind,
    },
    state: row.state,
    threadIds: threadIdsSchema.parse(JSON.parse(row.threadIdsJson)),
    updatedAt: row.updatedAt,
  };
}

export function pageFromRows<Item extends PageCursor>(
  rows: readonly Item[],
  limit: number,
  rankOf: ((item: Item) => number) | null = null,
): PageResult<Item> {
  const items = rows.slice(0, limit);
  const lastItem = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && lastItem !== undefined
      ? rankOf === null
        ? {createdAt: lastItem.createdAt, id: lastItem.id}
        : {createdAt: lastItem.createdAt, id: lastItem.id, rank: rankOf(lastItem)}
      : null,
  };
}
