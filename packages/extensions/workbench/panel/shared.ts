/** Presentation helpers and styles shared by the workbench page and its rail panel. */

const css = `
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--oc-bg);color:var(--oc-fg);font-family:var(--oc-font);font-size:14px;line-height:1.55}
body{overflow-wrap:anywhere}
button,input,textarea,select{font:inherit;color:inherit}
[hidden]{display:none!important}
.wb{max-width:1180px;margin:0 auto;padding:24px;display:flex;flex-direction:column;gap:20px}
.wb-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap}
.wb-head h1{margin:0;font-size:26px;letter-spacing:-.03em;font-weight:650}
.wb-sub{color:var(--oc-muted);font-size:12px}
.tabs{display:flex;gap:4px;background:color-mix(in srgb,var(--oc-fg) 5%,transparent);padding:3px;border-radius:9px}
.tabs button{border:0;background:transparent;padding:6px 14px;border-radius:7px;cursor:pointer;color:var(--oc-muted)}
.tabs button[aria-pressed="true"]{background:var(--oc-bg);color:var(--oc-fg);box-shadow:0 1px 2px rgb(0 0 0 / .08)}
.bento{display:grid;gap:14px;grid-template-columns:repeat(12,minmax(0,1fr))}
.tile{grid-column:span 12;min-width:0;border:1px solid var(--oc-border);border-radius:var(--oc-radius);padding:16px;background:var(--oc-bg);display:flex;flex-direction:column;gap:12px}
.tile h2{margin:0;font-size:13px;font-weight:600;letter-spacing:-.01em}
.tile .count{font-size:28px;font-weight:600;letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.start{grid-column:span 12;background:var(--oc-fg);color:var(--oc-bg);border-color:transparent;gap:14px}
.start h2{color:inherit;opacity:.8;font-weight:500}
.start input{width:100%;padding:10px 12px;border-radius:9px;border:1px solid color-mix(in srgb,var(--oc-bg) 30%,transparent);background:color-mix(in srgb,var(--oc-bg) 8%,transparent);color:inherit}
.start input::placeholder{color:color-mix(in srgb,var(--oc-bg) 55%,transparent)}
.start .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.start .ghost{border:1px solid color-mix(in srgb,var(--oc-bg) 30%,transparent);background:transparent;color:inherit;padding:7px 12px;border-radius:8px;cursor:pointer}
.start .primary{background:var(--oc-bg);color:var(--oc-fg);border:0;padding:7px 14px;border-radius:8px;cursor:pointer;font-weight:600}
.start select{background:color-mix(in srgb,var(--oc-bg) 10%,transparent);color:inherit;border:1px solid color-mix(in srgb,var(--oc-bg) 32%,transparent);border-radius:8px;padding:7px 9px}
.start select option{background:var(--oc-bg);color:var(--oc-fg)}
.list{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.task{display:flex;align-items:flex-start;gap:9px;padding:8px 6px;border-radius:7px;cursor:pointer;border:0;background:transparent;text-align:left;width:100%}
.task:hover{background:color-mix(in srgb,var(--oc-fg) 5%,transparent)}
.box{flex:none;width:15px;height:15px;border:1.5px solid color-mix(in srgb,var(--oc-fg) 35%,transparent);border-radius:4px;margin-top:2px;display:grid;place-items:center;background:transparent;cursor:pointer;padding:0;position:relative}
.box::after{content:'';position:absolute;inset:-8px}
.box[data-done="true"]{background:var(--oc-primary);border-color:var(--oc-primary);color:var(--oc-bg)}
.task-title{min-width:0;flex:1}
.task-meta{display:flex;gap:8px;flex-wrap:wrap;color:var(--oc-muted);font-size:11px;margin-top:2px}
.badge{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border-radius:999px;font-size:11px;background:color-mix(in srgb,var(--oc-fg) 8%,transparent);color:var(--oc-muted)}
.badge.due{color:var(--oc-primary);background:color-mix(in srgb,var(--oc-primary) 14%,transparent)}
.badge.late{color:var(--oc-error);background:color-mix(in srgb,var(--oc-error) 14%,transparent)}
.empty{padding:22px 8px;text-align:center;color:var(--oc-muted);font-size:12px}
.tasks{display:grid;gap:16px;grid-template-columns:minmax(0,1fr)}
.toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.toolbar select,.toolbar input{padding:6px 9px;border:1px solid var(--oc-border);border-radius:7px;background:var(--oc-bg)}
.detail{border:1px solid var(--oc-border);border-radius:var(--oc-radius);padding:18px;display:flex;flex-direction:column;gap:14px}
.detail h2{margin:0;font-size:18px;letter-spacing:-.02em}
.field{display:flex;flex-direction:column;gap:5px}
.field label{font-size:11px;color:var(--oc-muted)}
.field input,.field select,.field textarea{padding:7px 9px;border:1px solid var(--oc-border);border-radius:7px;background:var(--oc-bg);width:100%}
.field textarea{min-height:84px;resize:vertical}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.btn{padding:7px 12px;border-radius:8px;border:1px solid var(--oc-border);background:var(--oc-bg);cursor:pointer}
.btn.primary{background:var(--oc-primary);border-color:var(--oc-primary);color:var(--oc-bg);font-weight:600}
.btn:disabled{opacity:.5;cursor:default}
.section-label{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--oc-muted)}
.notice{padding:9px 11px;border-radius:8px;font-size:12px;background:var(--oc-muted-surface);color:var(--oc-muted)}
.notice[data-tone="error"]{background:color-mix(in srgb,var(--oc-error) 12%,transparent);color:var(--oc-error)}
.notice[data-tone="warn"]{background:color-mix(in srgb,var(--oc-warning) 14%,transparent);color:var(--oc-warning)}
.mono{font-family:var(--oc-mono);font-size:11px;color:var(--oc-muted)}
.rail{padding:12px;display:flex;flex-direction:column;gap:10px;font-size:13px}
.rail h2{margin:0;font-size:12px;font-weight:600}
.rail .task{padding:5px 4px}
.rail .more{font-size:11px;color:var(--oc-muted);cursor:pointer;background:none;border:0;padding:4px;text-align:left}
@media(min-width:720px){
  .start{grid-column:span 7}
  .today{grid-column:span 5}
  .half{grid-column:span 6}
  .third{grid-column:span 4}
  .tasks{grid-template-columns:minmax(0,1.05fr) minmax(300px,.95fr)}
}
`;

export const installStyles = (): void => {
  if (document.getElementById('wb-style')) return;
  const style = document.createElement('style');
  style.id = 'wb-style';
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
  show: (text: string, tone?: 'info' | 'warn' | 'error') => void;
  clear: () => void;
  element: HTMLElement;
}

export const notice = (parent?: Element): Notice => {
  const node = el('div', 'notice');
  node.hidden = true;
  if (parent) parent.append(node);
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
    },
  };
};

export const formatDate = (iso: string): string => {
  if (!iso) return '';
  const [year, month, day] = iso.split('-');
  return `${Number(month)}月${Number(day)}日`;
};

export const relativeDay = (iso: string, today: string): string => {
  if (!iso) return '';
  if (iso === today) return '今天';
  const start = new Date(`${today}T00:00:00`);
  const due = new Date(`${iso}T00:00:00`);
  const days = Math.round((due.getTime() - start.getTime()) / 86_400_000);
  if (days === 1) return '明天';
  if (days === -1) return '昨天';
  return formatDate(iso);
};
