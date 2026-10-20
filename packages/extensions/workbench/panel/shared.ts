/** Presentation helpers and styles shared by the workbench page and its rail panel. */

const css = `
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--oc-bg);color:var(--oc-fg);font-family:var(--oc-font);font-size:14px;line-height:1.55}
body{overflow-wrap:anywhere}
button,input,textarea,select{font:inherit;color:inherit}
[hidden]{display:none!important}
.wb{max-width:1180px;margin:0 auto;padding:28px 24px 40px;display:flex;flex-direction:column;gap:28px}
.wb-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;position:relative}
.head-right{display:flex;align-items:center;gap:10px}
.date-btn{border:1px solid var(--oc-border);background:transparent;border-radius:8px;padding:6px 10px;cursor:pointer;font-size:12px;color:var(--oc-muted)}
.date-btn:hover{color:var(--oc-fg);background:color-mix(in srgb,var(--oc-fg) 5%,transparent)}
.cal-pop{position:absolute;right:0;top:calc(100% + 8px);width:296px;background:var(--oc-bg);border:1px solid var(--oc-border);border-radius:12px;box-shadow:0 14px 36px rgb(0 0 0 / .16);padding:12px;z-index:30;display:flex;flex-direction:column;gap:8px}
.cal-pop-head{display:flex;align-items:center;justify-content:space-between}
.cal-title{font-size:13px;font-weight:600}
.cal-navs{display:flex;gap:2px}
.cal-nav{border:0;background:transparent;border-radius:6px;padding:2px 8px;cursor:pointer;color:var(--oc-muted)}
.cal-nav:hover{background:color-mix(in srgb,var(--oc-fg) 6%,transparent);color:var(--oc-fg)}
.cal-mini{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:2px}
.cal-dow{font-size:10px;color:var(--oc-muted);text-align:center;padding:2px 0}
.cal-day{position:relative;height:30px;border:0;background:transparent;border-radius:6px;font-size:11px;cursor:pointer;color:var(--oc-fg);display:flex;align-items:center;justify-content:center}
.cal-day:hover{background:color-mix(in srgb,var(--oc-fg) 7%,transparent)}
.cal-day.today{color:var(--oc-primary);font-weight:600}
.cal-day.selected{background:color-mix(in srgb,var(--oc-primary) 16%,transparent)}
.cal-dot{position:absolute;bottom:3px;width:4px;height:4px;border-radius:50%;background:var(--oc-primary)}
.cal-blank{height:30px}
.cal-day-list{display:flex;flex-direction:column;gap:2px;max-height:148px;overflow:auto;border-top:1px solid var(--oc-border);padding-top:8px}
.cal-day-item{border:0;background:transparent;text-align:left;padding:5px 6px;border-radius:6px;cursor:pointer;font-size:12px;color:var(--oc-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cal-day-item:hover{background:color-mix(in srgb,var(--oc-fg) 6%,transparent)}
.wb-head h1{margin:0;font-size:26px;letter-spacing:-.03em;font-weight:650}
.wb-sub{color:var(--oc-muted);font-size:12px}
.tabs{display:flex;gap:4px;background:color-mix(in srgb,var(--oc-fg) 5%,transparent);padding:3px;border-radius:9px}
.tabs button{border:0;background:transparent;padding:6px 14px;border-radius:7px;cursor:pointer;color:var(--oc-muted)}
.tabs button[aria-pressed="true"]{background:var(--oc-bg);color:var(--oc-fg);box-shadow:0 1px 2px rgb(0 0 0 / .08)}
.zones{display:flex;flex-direction:column;gap:28px}
.zone{display:flex;flex-direction:column;gap:10px}
.zone-title{margin:0;font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--oc-muted)}
.bento{display:grid;gap:12px;grid-template-columns:repeat(12,minmax(0,1fr));align-items:start}
.tile{grid-column:span 12;min-width:0;border:0;border-radius:12px;padding:16px 18px;background:color-mix(in srgb,var(--oc-fg) 4%,transparent);display:flex;flex-direction:column;gap:10px}
.tile.today{background:color-mix(in srgb,var(--oc-primary) 8%,transparent)}
.d5{grid-column:span 5}
.tile.late{background:color-mix(in srgb,var(--oc-warning) 11%,transparent)}
.tile h2{margin:0;font-size:12px;font-weight:600;letter-spacing:.02em;color:var(--oc-muted)}
.tile h2 .n{font-variant-numeric:tabular-nums;color:var(--oc-fg);margin-left:6px}
.tile .count{font-size:28px;font-weight:600;letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.start{grid-column:span 12;background:var(--oc-fg);color:var(--oc-bg);gap:14px}
.start h2{color:inherit;opacity:.8;font-weight:500}
.start input{width:100%;padding:10px 12px;border-radius:9px;border:1px solid color-mix(in srgb,var(--oc-bg) 30%,transparent);background:color-mix(in srgb,var(--oc-bg) 8%,transparent);color:inherit}
.start input::placeholder{color:color-mix(in srgb,var(--oc-bg) 55%,transparent)}
.start .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.start .ctl-label{font-size:11px;opacity:.65}
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
.detail{border:0;border-radius:12px;padding:18px;background:color-mix(in srgb,var(--oc-fg) 4%,transparent);display:flex;flex-direction:column;gap:14px}
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
.cal-current .rail{padding:12px;display:flex;flex-direction:column;gap:10px;font-size:13px}
.rail h2{margin:0;font-size:12px;font-weight:600}
.rail .task{padding:5px 4px}
.rail .more{font-size:11px;color:var(--oc-muted);cursor:pointer;background:none;border:0;padding:4px;text-align:left}
@media(min-width:720px){
  .start{grid-column:span 7}
  .today{grid-column:span 5}
  .half{grid-column:span 6}
  .third{grid-column:span 4}
  .wide{grid-column:span 8}
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
