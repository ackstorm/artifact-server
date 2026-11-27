import {afterEach, beforeEach, describe, expect, test} from "vitest";
import {z} from "zod";

import {
  ApiClient,
  callMcp,
  dispatchCreationSchema,
  mcpFailed,
  type McpReply,
} from "../support/agent-dispatch.js";
import {publishNew, type PublishResponse} from "../support/publishing.js";
import {
  createTestInstallation,
  removeTestInstallation,
  type RunningTestServer,
  startTestServer,
  type TestInstallation,
} from "../support/runtime-harness.js";

const targetSchema = z.object({
  element: z.json().nullable(),
  embed: z.json().nullable(),
  quote: z.string().nullable(),
}).strict();
const pageSchema = z.object({
  items: z.array(z.object({id: z.string(), target: targetSchema}).loose()),
}).loose();
const detailsSchema = z.object({
  thread: z.object({id: z.string(), target: targetSchema}).loose(),
}).loose();
const inboxSchema = z.object({
  agent: z.object({id: z.string()}).loose(),
  claimed: z.object({message: z.string()}).loose().nullable(),
}).loose();
const threadCreationSchema = z.object({thread: z.object({id: z.string()}).loose()}).loose();

type ToolArguments = NonNullable<Parameters<typeof callMcp>[4]["arguments"]>;

const saveAnchor = {
  elementContext: {
    classes: ["btn", "primary"],
    heading: "h2 \"Draft\"",
    id: "save",
    landmark: "main",
    name: "Save draft",
    page: {url: "/drafts"},
    path: "body > main > button#save",
    tag: "button",
    text: "Save draft",
  },
  htmlAnchor: {selector: "#save", tagName: "button"},
  originalText: "Save draft",
};

describe("agent-ready comment feedback", () => {
  let installation: TestInstallation;
  let server: RunningTestServer;
  let client: ApiClient;
  let published: PublishResponse;

  beforeEach(async () => {
    installation = await createTestInstallation();
    server = await startTestServer(installation);
    client = new ApiClient(server, installation.apiToken);
    published = (await publishNew(server, installation, {
      accessSetting: "account_required",
      content: "<!doctype html><main><button id=\"save\">Save draft</button></main>",
      idempotencyKey: "mcp-feedback-publish-artifact",
      name: "Agent feedback",
    })).body;
  });

  afterEach(async () => {
    await server.stop();
    await removeTestInstallation(installation);
  });

  async function openThread(
    anchor: ToolArguments[string] | null,
    body: string,
    idempotencyKey: string,
  ): Promise<string> {
    const payload = anchor === null
      ? {body, path: "index.html"}
      : {anchor, body, path: "index.html"};
    const response = await client.fetch(
      `/api/v1/artifacts/${published.artifact.id}/versions/${published.version.id}/comments?projectId=${published.artifact.projectId}`,
      {body: JSON.stringify(payload), idempotencyKey, method: "POST"},
    );
    expect(response.status).toBe(201);
    return threadCreationSchema.parse(await response.json()).thread.id;
  }

  async function callTool(name: string, toolArguments: ToolArguments) {
    const reply: McpReply = await callMcp(server, installation.apiToken, "tools/call", name, {
      arguments: toolArguments,
      name,
    });
    expect(mcpFailed(reply)).toBe(false);
    return reply.result?.structuredContent;
  }

  async function claimBundle(threadIds: readonly string[], idempotencyKey: string) {
    const listed = inboxSchema.parse(await callTool("dispatch_inbox", {
      agentName: "Feedback agent",
      operation: "list",
    }));
    const response = await client.sendDispatch({
      agentId: listed.agent.id,
      idempotencyKey,
      projectId: published.artifact.projectId,
      threadIds: [...threadIds],
    });
    expect(response.status).toBe(201);
    dispatchCreationSchema.parse(await response.json());
    const claimed = inboxSchema.parse(await callTool("dispatch_inbox", {
      agentName: "Feedback agent",
      operation: "claim",
    }));
    return claimed.claimed?.message ?? "";
  }

  async function targets() {
    const page = pageSchema.parse(await callTool("comment_list", {
      artifactId: published.artifact.id,
    }));
    return new Map(page.items.map((item) => [item.id, item.target]));
  }

  test("MCP-022-B: comment_list, comment_get and a claimed dispatch give the agent the quoted text and the anchored element", async () => {
    const threadId = await openThread(saveAnchor, "Rename the save button.", "mcp-022-b-thread-save");
    const expected = {
      element: {
        classes: ["btn", "primary"],
        heading: "h2 \"Draft\"",
        id: "save",
        landmark: "main",
        name: "Save draft",
        path: "body > main > button#save",
        selector: "#save",
        tag: "button",
        text: "Save draft",
      },
      embed: null,
      quote: "Save draft",
    };
    expect((await targets()).get(threadId)).toEqual(expected);
    const details = detailsSchema.parse(await callTool("comment_get", {
      artifactId: published.artifact.id,
      threadId,
    }));
    expect(details.thread.target).toEqual(expected);
    const message = await claimBundle([threadId], "mcp-022-b-dispatch-save");
    expect(message).toContain("1. [Agent feedback · version 1 · index.html] \"Save draft\"");
    expect(message).toContain("   Element: <button#save.btn.primary> \"Save draft\"");
    expect(message).toContain("   Selector: #save");
    expect(message).toContain("   Path: body > main > button#save");
    expect(message).toContain("   Near: main · heading h2 \"Draft\"");
  });

  test("MCP-022-F: unrecognized and hostile anchors yield no element or sanitized element lines and never block listing or dispatch", async () => {
    const pageNote = await openThread({kind: "page"}, "Whole file note.", "mcp-022-f-thread-page");
    const malformed = await openThread(
      {elementContext: {id: "x", tag: 42}, originalText: "Plain quote"},
      "Malformed context.",
      "mcp-022-f-thread-malformed",
    );
    const hostile = await openThread(
      {elementContext: {name: "Sa‮ve", path: "body >​ main", tag: "div"}, originalText: "q"},
      "Hostile context.",
      "mcp-022-f-thread-hostile",
    );
    const bare = await openThread(null, "No anchor at all.", "mcp-022-f-thread-bare");
    const listed = await targets();
    expect(listed.get(pageNote)).toEqual({element: null, embed: null, quote: null});
    expect(listed.get(malformed)).toEqual({element: null, embed: null, quote: "Plain quote"});
    expect(listed.get(hostile)).toEqual({
      element: {name: "Sa‮ve", path: "body >​ main", tag: "div"},
      embed: null,
      quote: "q",
    });
    expect(listed.get(bare)).toEqual({element: null, embed: null, quote: null});

    const message = await claimBundle([pageNote, malformed, hostile, bare], "mcp-022-f-dispatch-all");
    expect(message.match(/Element: /gu)).toHaveLength(1);
    expect(message).toContain("   Element: <div> \"Save\"");
    expect(message).toContain("   Path: body > main");
    expect(message).not.toMatch(/[‪-‮⁦-⁩​-‏⁠﻿]/u);
  });
});
