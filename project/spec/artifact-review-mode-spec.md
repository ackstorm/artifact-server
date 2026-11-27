# Artifact Review mode

**Status:** Implemented with local behavior evidence; equivalent live deployment evidence pending.
**Owner:** Artifact core and web application
**Companion documents:** [Product specification](./artifact-server-product-spec.html), [Media previews](./media-preview-spec.md), [Artifact comments](./artifact-comments-spec.md), [Conformance ledger](./conformance.yml)

## Outcome

Review shows every HTML and Markdown artifact as the page it is. Games, 3D scenes, forms and keyboard input work, and text can be selected and copied. Commenting is a separate mode the reviewer turns on when they want it.

## Rule

Review opens every artifact in **View**. **Comment** is a per-viewer choice: the toggle, the Escape shortcut, or a Review link with `mode=comment`. No artifact, version or manifest stores a Review mode.

## Artifact metadata

Publication, management and reads accept and return no Review mode. HTTP upload commit, MCP `artifact_commit_upload` and CLI `publish` have no mode input, and there is no operation that changes one. Stored artifact actions of kind `change_review_mode` remain readable in history.

## Browser contract

The initial mode is `comment` for an exact `mode=comment` query value and `view` otherwise. Any other value, including `annotate` and `interact`, opens View.

Review URL construction retains a valid mode override when changing artifact, version, file, or focus view, and browser history restores the mode associated with its URL. Once the reviewer changes mode with the toggle or Escape, data refresh and selected-version loading cannot overwrite that choice. Selecting a comment thread while in View switches to Comment and selects it.

**View** renders the document in a plain `sandbox="allow-scripts"` frame with no annotation layer. Fragment links follow [HTML fragment navigation](./artifact-comments-spec.md#html-fragment-navigation).

**Comment** renders the document with the annotation viewer. Reviewers pin elements and comment on selected text. A plain click follows a link, opening a non-fragment destination in a new tab, and Ctrl/Cmd-click pins a link for a comment.

Neither mode alters authentication, access settings, the frame sandbox, stored content, or native media presentation.

## Conformance

| ID | Contract |
| --- | --- |
| `ART-012` | Publication, management, and reads accept and return no Review mode, and no operation changes one. |
| `PRV-006` | Open in View as a plain page, switch to Comment through link, toggle, Escape, or thread selection, retain URL overrides through navigation and history, and preserve manual choices during refresh and version loading. |

Requirements are `behavior_verified` with passing local evidence. A local run cannot establish live behavior on every supported deployment.
