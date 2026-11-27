# Embedded tables and diagrams

Read this before writing a page that shows a table or a diagram.

## Overview page

```html
<!doctype html>
<html>
<body>
  <h1>Q3 review</h1>
  <as-embed src="data/revenue.csv" title="Revenue"></as-embed>
  <as-embed src="diagrams/flow.mmd" title="Release flow"></as-embed>
  <script src="/.artifactserver/embed.js"></script>
</body>
</html>
```

`data/revenue.csv`:

```csv
Region,Q1,Q2
North,120,80
"South, East",95,110
```

`diagrams/flow.mmd`:

```mermaid
flowchart LR
  draft --> review --> publish
```

- `src` is a path relative to the page, inside the same artifact.
- Load the runtime once per page with exactly that `src`.
- Review shows the page as Overview and each embedded table or diagram in its own tab.

## Tables (`*.csv`)

- RFC 4180, UTF-8, comma separated. The first row is the header.
- Write numbers plainly (`1200`, `-3.5`); the table shows the text as written and nothing is computed.
- One record per line, so an `artifact_edit` replace stays local to the row.
- Limits: 1 MiB, 20,000 cells, 256 columns. A file over a limit or with an unclosed quote shows an error instead of a table.

## Diagrams (`*.mmd`)

Mermaid source up to 20,000 characters. These are refused: configuration (`%%{ ... }%%` and `---` front matter), `click`, `classDef`, `style`, and `linkStyle`.

## Warnings

Commits and edits return these in `warnings`; none fails a publication.

- `embed_runtime_missing`: an HTML file has `<as-embed>` and no runtime script. Add the script tag.
- `missing_reference`: an `<as-embed src>` names no file in the version. Fix the path or add the file.
- `diagram_refused`: a `.mmd` file (or Markdown Mermaid fence) uses a refused construct or is too long. Remove it.

## Comments

A comment inside an embed arrives on the embedded file's path. `comment_list` and `comment_get` give `target.embed`: `src` plus `cell` (tables, such as `B4`) or `element` (a diagram node id; absent for the diagram as a whole). Edit that row or diagram line with `artifact_edit`. `dispatch_inbox` bundles show the file as the item's path and carry no cell.
