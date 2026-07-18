export const themeCss = String.raw`
:root {
  color-scheme: light;
  --background: #ffffff;
  --surface: #ffffff;
  --ink: #2c2c2a;
  --muted: #65645f;
  --faint: #8a8983;
  --line: #e7e5e0;
  --line-strong: #cfccc5;
  --accent: #514d47;
  --code: #f7f6f3;
  --code-line: #e1dfd9;
  --reading-width: 46rem;
  --shell-width: 46rem;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}

* {
  box-sizing: border-box;
}

body {
  min-width: 20rem;
  margin: 0;
  background: var(--background);
  color: var(--ink);
  font-size: 1rem;
  line-height: 1.65;
}

a {
  color: inherit;
}

.skip-link {
  position: fixed;
  z-index: 20;
  top: 0.75rem;
  left: 0.75rem;
  padding: 0.55rem 0.75rem;
  transform: translateY(-160%);
  border: 1px solid var(--ink);
  background: var(--surface);
}

.skip-link:focus {
  transform: translateY(0);
}

:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}

.site-header {
  border-bottom: 1px solid var(--line);
  background: var(--background);
}

.site-header__inner {
  display: flex;
  width: min(calc(100% - 2rem), var(--shell-width));
  min-height: 3.75rem;
  margin: 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.site-brand {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 0.8rem;
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  text-decoration: none;
}

.site-mark {
  display: grid;
  width: 1.4rem;
  flex: 0 0 1.4rem;
  gap: 0.25rem;
}

.site-mark span {
  display: block;
  height: 2px;
  background: currentColor;
}

.site-mark span:nth-child(2) {
  width: 72%;
}

.site-mark span:nth-child(3) {
  width: 44%;
}

.site-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page-shell {
  width: min(calc(100% - 2rem), var(--reading-width));
  margin: 0 auto;
  padding: 2.75rem 0 4.5rem;
}

.breadcrumbs {
  margin-bottom: 2.2rem;
  color: var(--muted);
  font-size: 0.82rem;
}

.breadcrumbs ol {
  display: flex;
  margin: 0;
  padding: 0;
  flex-wrap: wrap;
  gap: 0.35rem;
  list-style: none;
}

.breadcrumbs li:not(:last-child)::after {
  margin-left: 0.35rem;
  color: var(--faint);
  content: "/";
}

.breadcrumbs a {
  text-underline-offset: 0.22em;
}

.page-header {
  margin-bottom: 2.5rem;
}

.eyebrow {
  margin: 0 0 0.65rem;
  color: var(--accent);
  font-size: 0.76rem;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.page-header h1 {
  max-width: 24ch;
  margin: 0;
  font-size: clamp(2rem, 6vw, 2.75rem);
  font-weight: 680;
  letter-spacing: -0.035em;
  line-height: 1.08;
  text-wrap: balance;
}

.page-header .lede {
  max-width: 42rem;
  margin: 1.25rem 0 0;
  color: var(--muted);
  font-size: 1.04rem;
  line-height: 1.7;
}

.page-meta {
  display: flex;
  margin: 1.15rem 0 0;
  padding: 0;
  flex-wrap: wrap;
  gap: 0.35rem 1rem;
  color: var(--faint);
  font-size: 0.78rem;
  list-style: none;
}

.page-toc {
  margin: 2.75rem 0 3rem;
  padding: 1.2rem 0;
  border-top: 1px solid var(--line-strong);
  border-bottom: 1px solid var(--line);
}

.page-toc h2 {
  margin: 0 0 0.7rem;
  font-size: 0.76rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.page-toc ol {
  display: grid;
  margin: 0;
  padding: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.35rem 1.75rem;
  counter-reset: toc;
  list-style: none;
}

.page-toc li {
  min-width: 0;
  counter-increment: toc;
}

.page-toc li::before {
  margin-right: 0.45rem;
  color: var(--faint);
  font-variant-numeric: tabular-nums;
  content: counter(toc, decimal-leading-zero);
}

.page-toc li[data-depth="3"] {
  padding-left: 1rem;
  font-size: 0.9rem;
}

.page-toc a {
  text-decoration-color: transparent;
  text-underline-offset: 0.2em;
}

.page-toc a:hover {
  text-decoration-color: currentColor;
}

.prose {
  color: var(--ink);
  line-height: 1.75;
}

.prose > :first-child {
  margin-top: 0;
}

.prose p,
.prose ul,
.prose ol,
.prose blockquote,
.prose pre,
.prose table {
  margin-top: 1.25rem;
  margin-bottom: 1.25rem;
}

.prose h2,
.prose h3,
.prose h4 {
  color: var(--ink);
  font-weight: 650;
  line-height: 1.25;
  scroll-margin-top: 2rem;
  text-wrap: balance;
}

.prose h2 {
  margin: 3.5rem 0 1rem;
  padding-top: 1rem;
  border-top: 1px solid var(--line);
  font-size: clamp(1.5rem, 4vw, 1.8rem);
  font-weight: 650;
  letter-spacing: -0.02em;
}

.prose h3 {
  margin: 2.5rem 0 0.8rem;
  font-size: 1.2rem;
}

.prose h4 {
  margin: 2rem 0 0.6rem;
  font-size: 1rem;
}

.prose a {
  color: var(--accent);
  text-decoration-thickness: 1px;
  text-underline-offset: 0.18em;
}

.prose strong {
  font-weight: 680;
}

.prose blockquote {
  margin-right: 0;
  margin-left: 0;
  padding: 0.15rem 0 0.15rem 1.15rem;
  border-left: 2px solid var(--accent);
  color: var(--muted);
}

.prose blockquote > :first-child {
  margin-top: 0;
}

.prose blockquote > :last-child {
  margin-bottom: 0;
}

.prose :not(pre) > code {
  padding: 0.12em 0.35em;
  border: 1px solid var(--code-line);
  border-radius: 0.2rem;
  background: var(--code);
  font-size: 0.88em;
}

.code-block,
.prose pre.mermaid {
  overflow-x: auto;
  padding: 1rem 1.1rem;
  border: 1px solid var(--code-line);
  border-radius: 0.25rem;
  background: var(--code);
  font-size: 0.84rem;
  line-height: 1.58;
  tab-size: 2;
}

.code-block code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.hljs-comment,
.hljs-quote {
  color: #77736b;
}

.hljs-keyword,
.hljs-selector-tag,
.hljs-literal,
.hljs-section,
.hljs-link {
  color: #8c3525;
}

.hljs-string,
.hljs-title,
.hljs-name,
.hljs-type,
.hljs-attribute,
.hljs-symbol,
.hljs-bullet,
.hljs-addition,
.hljs-variable,
.hljs-template-tag,
.hljs-template-variable {
  color: #356a50;
}

.hljs-number,
.hljs-meta,
.hljs-built_in,
.hljs-builtin-name,
.hljs-params {
  color: #61509a;
}

.hljs-deletion {
  color: #a12626;
}

.prose table {
  display: block;
  width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.prose th,
.prose td {
  padding: 0.55rem 0.75rem;
  border: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
}

.prose th {
  background: var(--code);
  font-weight: 650;
}

.prose img {
  max-width: 100%;
  height: auto;
}

.prose hr {
  margin: 3rem 0;
  border: 0;
  border-top: 1px solid var(--line);
}

.footnotes {
  margin-top: 4rem;
  padding-top: 1rem;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 0.86rem;
}

.footnotes h2 {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.footnote-backref {
  margin-left: 0.25rem;
  text-decoration: none;
}

.diagram {
  margin: 2rem 0;
  overflow-x: auto;
  text-align: center;
}

.diagram svg {
  max-width: 100%;
  height: auto;
}

.diagram-error {
  margin: 1rem 0 0.35rem;
  color: #872a22;
  font-size: 0.85rem;
  font-weight: 650;
}

.content-list {
  margin: 3rem 0 0;
  padding: 0;
  border-top: 1px solid var(--line-strong);
  list-style: none;
}

.content-list li {
  border-bottom: 1px solid var(--line);
}

.content-list a {
  display: grid;
  padding: 1.15rem 0;
  grid-template-columns: minmax(10rem, 0.75fr) minmax(0, 1.25fr);
  gap: 1.5rem;
  text-decoration: none;
}

.content-list a:hover .content-list__title {
  text-decoration: underline;
  text-underline-offset: 0.2em;
}

.content-list__title {
  font-weight: 650;
  line-height: 1.35;
}

.content-list__summary {
  color: var(--muted);
  font-size: 0.92rem;
  line-height: 1.55;
}

.content-list__meta {
  display: block;
  margin-top: 0.25rem;
  color: var(--faint);
  font-size: 0.74rem;
  font-weight: 500;
}

.page-footer {
  margin-top: 4.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid var(--line-strong);
}

.page-source {
  margin: 0 0 1.5rem;
  color: var(--faint);
  font-size: 0.75rem;
}

.page-source code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.page-source a {
  text-underline-offset: 0.2em;
}

.page-pagination {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 1rem;
}

.page-pagination a {
  display: block;
  min-width: 0;
  text-decoration: none;
}

.page-pagination a:last-child {
  text-align: right;
}

.page-pagination span {
  display: block;
  margin-bottom: 0.18rem;
  color: var(--faint);
  font-size: 0.72rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.page-pagination strong {
  color: var(--accent);
  font-size: 0.92rem;
  font-weight: 600;
}

@media (max-width: 42rem) {
  .page-shell {
    padding-top: 2.1rem;
  }

  .page-header h1 {
    font-size: clamp(1.9rem, 10vw, 2.4rem);
  }

  .page-toc ol,
  .content-list a {
    grid-template-columns: 1fr;
  }

  .content-list a {
    gap: 0.35rem;
  }

  .page-pagination {
    grid-template-columns: 1fr;
  }

  .page-pagination a:last-child {
    text-align: left;
  }
}

@media print {
  .site-header,
  .skip-link,
  .breadcrumbs,
  .page-pagination {
    display: none;
  }

  body {
    background: white;
  }

  .page-shell {
    width: 100%;
    padding: 0;
  }

  .prose a {
    color: inherit;
  }
}
`;

export const mermaidClientSource = String.raw`
import mermaid from "mermaid";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  maxTextSize: 40000,
  suppressErrorRendering: true,
  theme: "neutral"
});

const diagrams = Array.from(document.querySelectorAll("pre[data-inkpath-diagram]"));
for (let index = 0; index < diagrams.length; index += 1) {
  const sourceNode = diagrams[index];
  const source = sourceNode.textContent || "";
  try {
    const rendered = await mermaid.render("inkpath-diagram-" + index, source);
    const figure = document.createElement("figure");
    figure.className = "diagram";
    figure.innerHTML = rendered.svg;
    sourceNode.replaceWith(figure);
    if (rendered.bindFunctions) rendered.bindFunctions(figure);
  } catch (error) {
    const message = document.createElement("p");
    message.className = "diagram-error";
    message.textContent = "Diagram could not be rendered. Its source is shown below.";
    sourceNode.before(message);
  }
}
`;
