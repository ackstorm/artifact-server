/** Trusted presentation for the generated document, matching the Review palette. */
export function markdownDocumentStyle(isLight: boolean): string {
  const color = isLight ? {
    background: "oklch(0.995 0.002 250)", foreground: "oklch(0.2 0.01 250)",
    muted: "oklch(0.5 0.012 250)", border: "oklch(0.9 0.005 250)",
    code: "oklch(0.96 0.004 250)", link: "oklch(0.24 0.01 250)",
  } : {
    background: "oklch(0.17 0.006 250)", foreground: "oklch(0.95 0.004 250)",
    muted: "oklch(0.72 0.01 250)", border: "oklch(1 0 0 / 10%)",
    code: "oklch(0.26 0.008 250)", link: "oklch(0.93 0.004 250)",
  };
  return `
:root {
  color-scheme: ${isLight ? "light" : "dark"};
  background: ${color.background};
  color: ${color.foreground};
  font-family: "Atkinson Hyperlegible Next", system-ui, sans-serif;
  font-size: 16px;
  line-height: 1.65;
}
* { box-sizing: border-box; }
body { margin: 0; }
main {
  max-width: 900px;
  margin: 0 auto;
  padding: 32px 36px 80px;
  overflow-wrap: anywhere;
}
h1, h2, h3, h4, h5, h6 {
  line-height: 1.25;
  margin: 1.6em 0 .6em;
  font-weight: 650;
}
h1 { font-size: 2em; }
h2 {
  font-size: 1.5em;
  border-bottom: 1px solid ${color.border};
  padding-bottom: .35em;
}
main > :first-child { margin-top: 0; }
p, ul, ol, blockquote, pre, table, figure { margin: 1em 0; }
a { color: ${color.link}; text-underline-offset: 3px; }
img { max-width: 100%; height: auto; }
pre {
  overflow: auto;
  padding: 16px;
  border: 1px solid ${color.border};
  border-radius: 6px;
  background: ${color.code};
}
code {
  font-family: "Atkinson Hyperlegible Mono", ui-monospace, monospace;
  font-size: .875em;
}
p code, li code, td code {
  background: ${color.code};
  padding: .15em .35em;
  border-radius: 3px;
}
pre code { background: transparent; }
blockquote {
  border-left: 3px solid ${color.border};
  padding: 0 1em;
  color: ${color.muted};
}
table {
  display: block;
  max-width: 100%;
  overflow: auto;
  border-collapse: collapse;
}
th, td { border: 1px solid ${color.border}; padding: 8px 12px; text-align: left; }
th { background: ${color.code}; }
hr { border: 0; border-top: 1px solid ${color.border}; margin: 2em 0; }
.render-notice { color: ${color.muted}; font-size: .875em; }
.markdown-diagram { overflow: auto; text-align: center; padding: 12px; }
.markdown-diagram svg { max-width: 100%; height: auto; }
input[type=checkbox] { margin-right: .4em; }
@media (max-width: 600px) {
  main { padding: 20px 18px 48px; }
  h1 { font-size: 1.7em; }
}
`;
}
