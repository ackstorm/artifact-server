# Command-line interface

Agents normally publish through the [Artifact Server Skill](../skills/artifact-server/SKILL.md) or [MCP](./mcp.md). Use the CLI when you want to publish directly or run operator commands from a terminal.

A packaged release will provide the `artifactserver` command. Its download, verification, and `PATH` setup commands will be added on release day. Until then, run the examples from a source checkout by replacing `artifactserver` with `pnpm artifactserver`.

## Publish an artifact

Publish one finished file or a complete directory:

```sh
artifactserver publish ./report.pdf
artifactserver publish ./dist --signed-in --name "Product prototype" --tag prototype
```

Review opens every artifact in View mode, so people can click and use an HTML prototype immediately. Reviewers switch to Comment mode to pin comments, and a Review link with `mode=comment` opens in Comment mode. See [Review mode](./review-mode.md).

New artifacts are private: only the publisher opens them, and only the publisher sees them in lists. Members and Public artifacts also appear in a colleague's Shared with me when the owner lists them or the colleague opens the link. `--signed-in` sets the Members level: any member with the link opens the artifact. `--public` lets anyone with the link open it without signing in. The two flags conflict.

Publication returns JSON with three browser links:

| Link | Purpose |
| --- | --- |
| `links.review` | Opens the exact version full screen with comments. Share this link first. |
| `links.artifact` | Opens the stable link that follows the current version. |
| `links.version` | Opens the immutable raw version without the Artifact Server interface. |

## Use a remote server

Sign in once, save a named profile, and use it when publishing:

```sh
artifactserver auth login https://artifacts.example.com --name team
artifactserver publish ./dist --profile team
```

This works on any installation with OIDC login, whichever provider it uses. The
first login asks you to approve the CLI in the browser. To connect over SSH or
from a remote workspace, forward the loopback port the CLI prints, or use
`--api-key-stdin`.

## Publish another version

Provide the artifact ID and expected current version:

```sh
artifactserver publish ./dist \
  --artifact art_example \
  --expected-version ver_example
```

The expected version prevents an old client from replacing a newer current pointer.

Run `artifactserver --help` or `artifactserver <command> --help` for the complete command reference.
