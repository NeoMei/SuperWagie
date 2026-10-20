/** Presentation helpers and styles shared by the workbench page and its rail panel. */

const css = `
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--oc-bg);color:var(--oc-fg);font-family:var(--oc-font);font-size:14px;line-height:1.5}
body{overflow-wrap:anywhere}
button,input,textarea,select{font:inherit;color:inherit}
[hidden]{display:none!important}
:root{
  --wb-panel:color-mix(in srgb,var(--oc-fg) 4%,var(--oc-bg));
  --wb-surface:var(--oc-bg);
  --wb-border:color-mix(in srgb,var(--oc-fg) 13%,transparent);
  --wb-rule:color-mix(in srgb,var(--oc-fg) 8%,transparent);
  --wb-muted:color-mix(in srgb,var(--oc-fg) 62%,var(--oc-bg));
  --wb-faint:color-mix(in srgb,var(--oc-fg) 46%,var(--oc-bg));
  --wb-accent:var(--oc-primary,#146b63);
  --wb-accent-soft:color-mix(in srgb,var(--wb-accent) 14%,var(--oc-bg));
  --wb-negative:var(--oc-error-text,#a5342b);
  --wb-serif:"Songti SC","Noto Serif SC","Source Han Serif SC",Georgia,serif;
  --wb-radius:16px;
}
:root[data-oc-theme="dark"]{
  --wb-border:color-mix(in srgb,var(--oc-fg) 16%,transparent);
  --wb-rule:color-mix(in srgb,var(--oc-fg) 10%,transparent);
  --wb-muted:color-mix(in srgb,var(--oc-fg) 66%,var(--oc-bg));
  --wb-faint:color-mix(in srgb,var(--oc-fg) 48%,var(--oc-bg));
}
.wb{max-width:none;margin:0;padding:46px 40px 72px;display:flex;flex-direction:column;gap:28px}
.home{display:flex;flex-direction:column;gap:28px}
.wb{position:relative}
.wb::before{content:'';position:fixed;inset-inline-start:50%;top:59%;transform:translate(-50%,-50%);width:520px;height:520px;background:url('logo.png') center/contain no-repeat;filter:grayscale(1);opacity:.035;pointer-events:none;z-index:0}
.wb > *{position:relative;z-index:1}
.greeting h1{font-family:var(--wb-serif);font-size:30px;line-height:1.3;letter-spacing:-.02em;font-weight:600;margin:0 0 8px;max-width:24em}
.greeting p{margin:0;color:var(--wb-muted);font-size:13px}
.composer{background:var(--wb-surface);border:1px solid var(--wb-border);border-radius:var(--wb-radius);padding:16px 18px;display:flex;flex-direction:column;gap:12px;height:140px}
.composer-label{font-size:12px;font-weight:600;color:var(--wb-muted);letter-spacing:.01em}
.composer input{width:100%;flex:1 1 auto;min-height:44px;border:1px solid var(--wb-border);border-radius:10px;padding:0 14px;font-size:15px;background:var(--wb-panel);outline:none}
.composer input:hover{border-color:var(--wb-faint)}
.composer input:focus{border-color:var(--wb-accent);background:var(--wb-surface)}
.composer input::placeholder{color:var(--wb-muted)}
.composer-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.primary{background:var(--wb-accent);color:var(--oc-primary-fg,var(--oc-bg));border:0;border-radius:10px;padding:9px 18px;font-size:13px;font-weight:600;cursor:pointer}
.primary:hover{filter:brightness(1.06)}
.chip{background:transparent;border:1px solid var(--wb-border);color:var(--wb-muted);border-radius:999px;padding:6px 12px;font-size:13px;cursor:pointer}
.chip:hover{color:var(--oc-fg);border-color:var(--wb-faint)}
.hint{color:var(--wb-muted);font-size:12px;margin-left:2px}
.counts-side{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.counts-side .count{min-height:90px;padding:12px 14px}
.counts-side .count strong{font-size:24px}
.count{background:var(--wb-panel);border-radius:var(--wb-radius);padding:16px 18px;min-height:118px;display:flex;flex-direction:column;justify-content:space-between}
.count span{font-size:13px;color:var(--wb-muted)}
.count strong{font-size:30px;font-weight:400;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.count em{font-style:normal;font-size:12px;color:var(--wb-muted)}
.row-a{display:grid;grid-template-columns:minmax(0,9fr) minmax(240px,3fr);gap:16px;align-items:start}
.side{display:flex;flex-direction:column;gap:16px;min-width:0}
.main-col{display:flex;flex-direction:column;gap:16px;min-width:0}
.panel{background:var(--wb-panel);border-radius:var(--wb-radius);padding:20px;display:flex;flex-direction:column;gap:14px;min-width:0}
.side > .panel:first-child:not(.cal-expanded){height:140px;justify-content:space-between}
.panel-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px}
.panel-head h2{margin:0;font-size:14px;font-weight:600}
.panel-meta{display:flex;align-items:center;gap:8px;color:var(--wb-muted);font-size:12px}
.count-chip{background:var(--wb-surface);border:1px solid var(--wb-border);border-radius:999px;padding:1px 8px;font-size:12px;color:var(--wb-muted)}
.rows{display:flex;flex-direction:column;gap:8px}
.task{display:flex;align-items:center;gap:12px;background:var(--wb-surface);border:1px solid var(--wb-border);border-radius:12px;padding:12px 14px;min-height:63px;cursor:pointer;text-align:left;width:100%}
.task:hover{border-color:var(--wb-faint)}
.task.done .title{color:var(--wb-faint);text-decoration:line-through}
.box{width:18px;height:18px;border:1.5px solid var(--wb-faint);border-radius:5px;flex:none;background:transparent;cursor:pointer;display:grid;place-items:center;padding:0;position:relative}
.box[data-done="true"]{background:var(--wb-accent);border-color:var(--wb-accent)}
.box[data-done="true"]::after{content:"";width:8px;height:4px;border-left:1.5px solid var(--oc-bg);border-bottom:1.5px solid var(--oc-bg);transform:rotate(-45deg) translate(0,-1px)}
.box::before{content:"";position:absolute;inset:-8px}
.title{font-size:14px;min-width:0}
.meta-line{display:flex;gap:8px;align-items:center;color:var(--wb-muted);font-size:12px;margin-top:2px;flex-wrap:wrap}
.due{color:var(--wb-accent)}
.due.late{color:var(--wb-negative)}
.origin{color:var(--wb-faint)}
.toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.toolbar select,.toolbar input{height:30px;padding:0 8px;border:1px solid var(--wb-border);border-radius:8px;background:var(--wb-surface);font-size:12px;color:var(--wb-muted)}
.toolbar input{width:110px}
.empty{padding:18px 8px;text-align:center;color:var(--wb-muted);font-size:12px}
.editor-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.editor-close{border:0;background:transparent;font-size:18px;line-height:1;cursor:pointer;color:var(--wb-muted);padding:2px 6px;border-radius:6px}
.editor-close:hover{background:var(--wb-panel);color:var(--oc-fg)}
.editor{margin:2px 0 6px;padding:16px;border-radius:12px;background:var(--wb-surface);border:1px solid var(--wb-border);display:flex;flex-direction:column;gap:12px}
.editor-row{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
.field{display:flex;flex-direction:column;gap:5px}
.field label{font-size:11px;color:var(--wb-muted)}
.field input,.field select,.field textarea{padding:7px 9px;border:1px solid var(--wb-border);border-radius:8px;background:var(--wb-surface);width:100%}
.field textarea{min-height:72px;resize:vertical}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.btn{padding:6px 11px;border-radius:8px;border:1px solid var(--wb-border);background:var(--wb-surface);cursor:pointer;font-size:12px}
.btn.primary{background:var(--wb-accent);border-color:var(--wb-accent);color:var(--oc-primary-fg,var(--oc-bg));font-weight:600}
.mono{font-family:var(--oc-mono);font-size:11px;color:var(--wb-muted)}
.week{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:4px}
.day{border:1px solid transparent;background:transparent;border-radius:8px;padding:7px 0 8px;display:flex;flex-direction:column;align-items:center;gap:3px;font-size:11px;color:var(--wb-muted);cursor:pointer;position:relative}
.day b{font-size:13px;font-weight:500;color:var(--oc-fg);font-variant-numeric:tabular-nums}
.day.today b{color:var(--wb-accent)}
.day.selected{background:var(--wb-surface);border-color:var(--wb-border)}
.dot{width:4px;height:4px;border-radius:50%;background:var(--wb-accent)}
.dot-off{visibility:hidden}
.day-list{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--wb-rule);padding-top:10px}
.day-list button,.day-list .empty{display:block;width:100%;min-height:26px;padding:4px 2px;font-size:12px;line-height:18px;text-align:left}
.day-list button{border:0;background:none;color:var(--oc-fg);cursor:pointer}
.day-list .empty{color:var(--wb-muted)}
.month{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:2px}
.month .cal-dow{font-size:10px;color:var(--wb-faint);text-align:center;padding:2px 0}
.month .day{padding:3px 0}
.month .day b{font-size:11px}
.sessions .task{min-height:52px;border:0;background:transparent;padding:8px 2px;border-bottom:1px solid var(--wb-rule);border-radius:0}
.sessions .task:last-child{border-bottom:0}
.notice{padding:9px 11px;border-radius:8px;font-size:12px;background:var(--wb-panel);color:var(--wb-muted)}
.notice[data-tone="error"]{background:color-mix(in srgb,var(--wb-negative) 12%,transparent);color:var(--wb-negative)}
.notice[data-tone="warn"]{background:color-mix(in srgb,var(--wb-accent) 12%,transparent);color:var(--wb-muted)}
.section-label{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--wb-muted)}
.rail{padding:12px;display:flex;flex-direction:column;gap:10px;font-size:13px}
.rail h2{margin:0;font-size:12px;font-weight:600}
.rail .task{padding:5px 4px;min-height:0;border:0;background:transparent}
.rail .more{font-size:11px;color:var(--wb-muted);cursor:pointer;background:none;border:0;padding:4px;text-align:left}
@media(max-width:900px){
  .wb{padding:40px 20px 56px}
  .row-a{grid-template-columns:1fr}
  .counts{grid-template-columns:repeat(2,minmax(0,1fr))}
  .greeting h1{font-size:28px}
}
@media(max-width:520px){
  .counts{grid-template-columns:1fr 1fr}
  .greeting h1{font-size:24px}
  .editor-row{grid-template-columns:1fr}
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
