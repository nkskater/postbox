import type { FolderNode, RequestNode } from "../types";
import type { DocumentationSnapshot } from "./model";
import { generateSnippet } from "../convert/codegen";

export const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
export interface DocumentationPage {
  title: string;
  visibility: "private" | "public" | "preview" | "team";
  revision: number;
  id?: string;
  queryVersion?: number;
  versions?: { version: number; label: string }[];
  details?: string;
  nonce: string;
}
export function renderDocumentation(snapshot: DocumentationSnapshot, page: DocumentationPage): string {
  const e = escapeHtml;
  const rows = (items: { key: string; value: string; enabled: boolean; description?: string }[]) =>
    items.length
      ? `<table><thead><tr><th>Name</th><th>Value</th><th>Description</th></tr></thead><tbody>${items.map((item) => `<tr><td>${e(item.key)}${item.enabled ? "" : " (disabled)"}</td><td><code>${e(item.value)}</code></td><td>${e(item.description)}</td></tr>`).join("")}</tbody></table>`
      : '<p class="muted">None declared.</p>';
  const endpoints: string[] = [];
  const folders: string[] = [];
  const walk = (folder: FolderNode, path: string[] = []) => {
    const chain = [...path, folder.name];
    if (path.length && folder.description)
      folders.push(
        `<section><h2>${e(chain.join(" / "))}</h2><p class="description">${e(folder.description)}</p></section>`,
      );
    for (const node of folder.children) {
      if (node.kind === "folder") {
        walk(node, chain);
        continue;
      }
      const request: RequestNode = node;
      const input = {
        method: request.method,
        url: request.url,
        headers: request.headers.filter((h) => h.enabled).map((h) => [h.key, h.value] as [string, string]),
        body: request.body,
      };
      const snippets = (
        [
          ["curl", "cURL"],
          ["fetch", "JavaScript fetch"],
        ] as const
      )
        .map(([language, title]) => {
          let snippet: string;
          try {
            snippet = generateSnippet(language, input);
          } catch {
            snippet = "Snippet unavailable for this body mode.";
          }
          return `<details><summary>${title}</summary><pre>${e(snippet)}</pre><button class="copy" type="button">Copy snippet</button></details>`;
        })
        .join("");
      endpoints.push(
        `<article class="endpoint"><p class="muted">${e(chain.join(" / "))}</p><h2><span class="method">${e(request.method)}</span> ${e(request.name)}</h2><pre>${e(request.url)}</pre><p class="description">${e(request.description)}</p><p>Authentication: <strong>${e(snapshot.authTypes[request.id] ?? "none")}</strong> · credentials omitted</p><h3>Query parameters</h3>${rows(request.params)}<h3>Headers</h3>${rows(request.headers)}<h3>Body</h3><pre>${e(request.body.mode === "raw" ? request.body.raw : JSON.stringify(request.body, null, 2))}</pre><h3>Code snippets</h3>${snippets}<h3>Response examples</h3>${(request.examples ?? []).map((example) => `<details><summary>${e(example.name)} · ${example.status} ${e(example.statusText)}</summary>${rows(example.headers)}${example.bodyOmitted ? "<p>Body omitted (binary or unavailable).</p>" : `<pre>${e(example.body)}</pre>`}${example.truncated ? "<p>Example is truncated.</p>" : ""}</details>`).join("") || '<p class="muted">No saved examples.</p>'}</article>`,
      );
    }
  };
  walk(snapshot.root);
  const id = page.id ? encodeURIComponent(page.id) : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(page.title)}</title><style nonce="${e(page.nonce)}">:root{color-scheme:light dark}body{font:15px/1.6 system-ui;margin:0;background:#111318;color:#eef0f5}main{max-width:1050px;margin:auto;padding:28px}header,article,section{border:1px solid #343945;border-radius:10px;padding:22px;margin-bottom:18px}h1,h2,h3{line-height:1.3}.method{color:#7dd3ad}p.description{white-space:pre-wrap}.muted{color:#aeb6c7}pre{background:#1c2029;padding:14px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}table{border-collapse:collapse;width:100%;overflow-wrap:anywhere}td,th{text-align:left;border-bottom:1px solid #343945;padding:8px}input,select,button,a.button{font:inherit;border:1px solid #667184;border-radius:6px;padding:8px;background:#252c39;color:#eef0f5}a{color:#9dccff}button{cursor:pointer}details{margin:12px 0}summary{cursor:pointer}#search{width:100%;box-sizing:border-box;margin:16px 0}.actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}[hidden]{display:none!important}footer{margin:24px 0;color:#aeb6c7}</style></head><body><main><header><p>${e(page.visibility)} documentation · revision ${page.revision} · read only</p><h1>${e(page.title)}</h1><p class="description">${e(snapshot.root.description)}</p><p class="description">${e(page.details ?? "")}</p>${page.versions ? `<nav aria-label="Catalog versions">${page.versions.map((v) => `<a href="?format=html&amp;version=${v.version}">${e(v.label)}</a>`).join(" · ")}</nav>` : ""}<div class="actions">${id ? `<a class="button" href="?format=collection${page.queryVersion ? `&amp;version=${page.queryVersion}` : ""}" download="collection.json">Download collection</a><button id="import-start" type="button">Import into Postbox</button>` : "<p>Preview of saved collection data. Publish to enable sharing and import.</p>"}</div><div id="import-controls" hidden><label>Destination workspace <select id="workspace"></select></label> <button id="import-confirm" type="button">Import collection</button></div><p id="status" role="status"></p><input id="search" type="search" aria-label="Search endpoints" placeholder="Search endpoints, methods, URLs or descriptions"><p id="count">${endpoints.length} endpoints</p></header><section><h2>Variables</h2>${snapshot.variables.length ? `<table><thead><tr><th>Name</th><th>Type</th><th>State</th></tr></thead><tbody>${snapshot.variables.map((v) => `<tr><td><code>{{${e(v.key)}}}</code></td><td>${e(v.type)}</td><td>${v.enabled ? "enabled" : "disabled"}</td></tr>`).join("")}</tbody></table><p>Configure values in your own environment after import.</p>` : "<p>No collection variables declared.</p>"}</section>${folders.join("")}${endpoints.join("")}<p id="empty" hidden>No endpoints match this search.</p><footer>${snapshot.omissions.map(e).join("<br>")}<p>Import creates a new sanitized collection; credentials and scripts must be configured separately.</p></footer></main><script nonce="${e(page.nonce)}">
const status=document.getElementById('status');document.getElementById('search').addEventListener('input',event=>{const query=event.target.value.toLowerCase();let count=0;document.querySelectorAll('.endpoint').forEach(node=>{node.hidden=!node.textContent.toLowerCase().includes(query);if(!node.hidden)count++;});document.getElementById('count').textContent=count+' endpoints';document.getElementById('empty').hidden=count!==0;});document.querySelectorAll('.copy').forEach(button=>button.addEventListener('click',()=>navigator.clipboard.writeText(button.previousElementSibling.textContent).then(()=>{status.textContent='Snippet copied';}).catch(()=>{status.textContent='Select and copy the snippet text.';})));
const start=document.getElementById('import-start');if(start)start.addEventListener('click',async()=>{try{const response=await fetch('/api/workspaces');if(response.status===401){status.textContent='Sign in to this Postbox instance to import. ';const link=document.createElement('a');link.href='/login?next='+encodeURIComponent(location.pathname+location.search);link.textContent='Sign in';status.append(link);return;}if(!response.ok)throw new Error('Could not load workspaces');const workspaces=await response.json();const select=document.getElementById('workspace');select.replaceChildren();for(const workspace of workspaces){const option=document.createElement('option');option.value=workspace.id;option.textContent=workspace.name;select.append(option);}document.getElementById('import-controls').hidden=false;status.textContent='Select a workspace where you have write access, then import.';}catch(error){status.textContent=error.message;}});const confirm=document.getElementById('import-confirm');if(confirm)confirm.addEventListener('click',async()=>{confirm.disabled=true;try{const response=await fetch(location.pathname+'/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspaceId:document.getElementById('workspace').value${page.queryVersion ? `,version:${page.queryVersion}` : ""}})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Import failed');status.textContent='Imported as a new collection. Open Postbox to configure credentials and variables.';}catch(error){status.textContent=error.message;}finally{confirm.disabled=false;}});
</script></body></html>`;
}
