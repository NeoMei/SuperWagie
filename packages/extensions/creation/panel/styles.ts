const css = `
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--oc-bg);color:var(--oc-fg);font-family:var(--oc-font);font-size:14px;line-height:1.5}
body{overflow-wrap:anywhere}
button,input,textarea{font:inherit;color:inherit}
:root{
  --cr-panel:color-mix(in srgb,var(--oc-fg) 4%,var(--oc-bg));
  --cr-border:color-mix(in srgb,var(--oc-fg) 13%,transparent);
  --cr-rule:color-mix(in srgb,var(--oc-fg) 8%,transparent);
  --cr-muted:color-mix(in srgb,var(--oc-fg) 62%,var(--oc-bg));
  --cr-faint:color-mix(in srgb,var(--oc-fg) 42%,var(--oc-bg));
  --cr-accent:var(--oc-primary,#146b63);
  --cr-radius:16px;
}
:root[data-oc-theme="dark"]{--cr-border:color-mix(in srgb,var(--oc-fg) 16%,transparent)}
.cr{padding:14px 12px 20px;display:flex;flex-direction:column;gap:12px;min-height:100%}
.cr h2{font-family:"Songti SC","Noto Serif SC",Georgia,serif;font-size:17px;font-weight:600;margin:0;letter-spacing:-.01em}
.cr-sub{color:var(--cr-muted);font-size:12px;margin:0}
.cr-wizard{display:flex;flex-direction:column;gap:12px;flex:1;min-height:0}
.cr-progress{display:flex;flex-direction:column;gap:6px}
.cr-progress-track{height:3px;border-radius:999px;background:var(--cr-rule);overflow:hidden}
.cr-progress-fill{height:100%;background:var(--cr-accent);transition:width .2s ease}
.cr-progress-steps{display:flex;flex-wrap:wrap;gap:6px 10px;list-style:none;margin:0;padding:0}
.cr-progress-steps li{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--cr-faint);white-space:nowrap}
.cr-progress-steps b{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;border:1px solid var(--cr-border);font-size:10px;font-weight:600}
.cr-progress-steps li[data-state="done"]{color:var(--cr-muted)}
.cr-progress-steps li[data-state="done"] b{background:var(--cr-accent);border-color:var(--cr-accent);color:var(--oc-primary-fg,var(--oc-bg))}
.cr-progress-steps li[data-state="now"]{color:var(--oc-fg);font-weight:600}
.cr-progress-steps li[data-state="now"] b{border-color:var(--cr-accent);color:var(--cr-accent)}
.cr-wizard-actions{padding-top:4px;margin-top:auto}
.cr-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.cr-kind{display:flex;flex-direction:column;gap:8px}
.cr-card{background:var(--cr-panel);border:0;border-radius:var(--cr-radius);padding:12px 14px;text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:2px}
.cr-card:hover{background:color-mix(in srgb,var(--oc-fg) 7%,var(--oc-bg))}
.cr-card b{font-size:14px;font-weight:600}
.cr-card span{font-size:12px;color:var(--cr-muted)}
.cr-steps{display:flex;flex-wrap:wrap;gap:4px;list-style:none;padding:0;margin:0;font-size:11px;color:var(--cr-faint)}
.cr-steps li{padding:2px 6px;border-radius:6px}
.cr-steps li[data-state="done"]{color:var(--cr-muted)}
.cr-steps li[data-state="done"]::before{content:"✓ "}
.cr-steps li[data-state="now"]{background:var(--cr-accent);color:var(--oc-primary-fg,var(--oc-bg));font-weight:600}
.cr-gate{background:var(--cr-panel);border-radius:var(--cr-radius);padding:14px;display:flex;flex-direction:column;gap:10px}
.cr-gate h3{margin:0;font-size:14px;font-weight:600}
.cr-excerpt{font-size:12px;color:var(--cr-muted);margin:0;white-space:pre-wrap;max-height:9.5em;overflow:auto}
.cr-row{display:flex;gap:6px;flex-wrap:wrap}
.cr-primary{background:var(--cr-accent);color:var(--oc-primary-fg,var(--oc-bg));border:0;border-radius:9px;padding:7px 12px;font-size:12px;font-weight:600;cursor:pointer}
.cr-primary:disabled{opacity:.5;cursor:default}
.cr-btn{background:transparent;border:1px solid var(--cr-border);border-radius:9px;padding:6px 10px;font-size:12px;cursor:pointer}
.cr-field{display:flex;flex-direction:column;gap:6px}
.cr-field label{font-size:11px;color:var(--cr-muted)}
.cr-field textarea,.cr-field input{width:100%;border:1px solid var(--cr-border);border-radius:9px;padding:7px 9px;background:var(--oc-bg);outline:none}
.cr-field textarea{min-height:96px;resize:vertical}
.cr-field input:focus,.cr-field textarea:focus{border-color:var(--cr-accent)}
.cr-chips{display:flex;gap:6px;flex-wrap:wrap}
.cr-chip{border:1px solid var(--cr-border);background:transparent;border-radius:999px;padding:5px 10px;font-size:12px;color:var(--cr-muted);cursor:pointer}
.cr-chip[aria-pressed="true"]{border-color:var(--cr-accent);color:var(--oc-fg)}
.cr-meta{font-family:var(--oc-mono);font-size:11px;color:var(--cr-muted);word-break:break-all}
.cr-files{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px;font-family:var(--oc-mono);font-size:11px;color:var(--cr-muted)}
.cr-note{font-size:12px;color:var(--cr-muted);padding:8px 10px;border-radius:9px;background:var(--cr-panel);min-height:34px}
.cr-note[data-tone="error"]{background:color-mix(in srgb,#a5342b 12%,transparent);color:#a5342b}
.cr-details summary{font-size:12px;color:var(--cr-muted);cursor:pointer}
.cr-details pre{font-family:var(--oc-mono);font-size:11px;white-space:pre-wrap;max-height:12em;overflow:auto;background:var(--oc-bg);padding:8px;border-radius:8px}
.cr-details textarea{width:100%;margin-top:8px;min-height:72px;resize:vertical;border:1px solid var(--cr-border);border-radius:8px;padding:7px 9px;background:var(--oc-bg);outline:none}
.cr-details textarea:focus{border-color:var(--cr-accent)}
.cr-article{white-space:pre-wrap;font-size:13px;line-height:1.6;max-height:46vh;overflow:auto;background:var(--oc-bg);border-radius:8px;padding:10px 12px;color:var(--cr-muted)}
.cr-sections{display:flex;flex-direction:column;gap:6px;max-height:46vh;overflow:auto}
.cr-section{background:var(--oc-bg);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:3px}
.cr-section b{font-size:12px;font-weight:600;color:var(--oc-fg)}
.cr-section-text{margin:0;font-size:12px;line-height:1.55;color:var(--cr-muted);white-space:pre-wrap}
:root[data-surface="page"] .cr{max-width:760px;margin:0 auto;padding:44px 24px 64px;gap:16px}
:root[data-surface="page"] .cr h2{font-size:22px}
@media(max-width:360px){.cr{padding:10px 8px 16px}}
`;

export const installStyles = (): void => {
  if (document.getElementById('creation-style')) return;
  const style = document.createElement('style');
  style.id = 'creation-style';
  style.textContent = css;
  document.head.append(style);
};

export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

export interface Notice {
  show: (text: string, tone?: 'info' | 'error') => void;
  clear: () => void;
  element: HTMLElement;
}

export const notice = (): Notice => {
  const node = el('div', 'cr-note');
  return {
    element: node,
    show: (text, tone = 'info') => {
      node.hidden = false;
      node.textContent = text;
      node.dataset.tone = tone;
    },
    clear: () => {
      node.hidden = true;
      node.textContent = '';
      delete node.dataset.tone;
    },
  };
};
