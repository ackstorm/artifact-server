# Review mode

Review opens every HTML artifact in **View** mode. **Comment** mode is a per-viewer toggle. The mode is not stored on the artifact: publication, management, and reads neither accept nor return one.

## View

View shows the page exactly as published, with no annotation layer over it. Clicks, keyboard input, scrolling, and text selection reach the page, so games, 3D scenes, prototypes, and copying text work as they do outside Review.

## Comment

Comment mode adds the annotation layer:

- Click an element to pin a comment to it.
- Select text to comment on the selection.
- A plain click on a link follows it. Ctrl-click (Cmd-click on macOS) pins a comment to the link instead.

Switch modes with the toggle in the Review toolbar or with Escape. The choice belongs to the viewer and that visit only; it never changes the artifact.

## Open a link in a mode

Add `mode=comment` or `mode=view` to a Review URL. For example, add `&mode=comment` to the returned `links.review` URL, which already has query parameters. Without a valid `mode` parameter, Review opens in View. An invalid value is ignored.

Mode selection changes HTML Review interaction only. It does not change artifact access, sandboxing, raw-content links, or the presentation of image and video previews.
