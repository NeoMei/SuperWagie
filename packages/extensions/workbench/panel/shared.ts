import { t, workbenchLocale } from './i18n.ts';

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
  --wb-hand:"HanziPen SC","Hannotate SC","HanziPenSC-W3","HannotateSC-W5","Kaiti SC","STKaiti","KaiTi","Segoe Print","Bradley Hand",cursive;
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
.greeting{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:32px;align-items:baseline}
.greeting-copy{min-width:0}
.greeting h1{font-family:var(--wb-serif);font-size:30px;line-height:1.3;letter-spacing:-.02em;font-weight:600;margin:0 0 8px;max-width:24em}
.greeting-copy p{margin:0;color:var(--wb-muted);font-size:13px}
.soup{justify-self:end;min-width:0;text-align:right}
.soup-line{display:block;margin:0;font-family:var(--wb-hand);line-height:1.55;text-wrap:pretty;text-align:right}
.soup-quote{font-size:clamp(18px,1.35vw,22px);letter-spacing:.01em;color:var(--oc-fg)}
.soup-sign{margin-left:.55em;font-size:11px;color:var(--wb-muted);white-space:nowrap}
.soup-name{font-size:13px;letter-spacing:.04em;color:var(--oc-fg)}
.soup-wordmark{margin-left:4px;font-size:11px;color:var(--wb-muted)}
.soup-logo{display:inline-block;width:18px;height:18px;margin-left:5px;object-fit:contain;border-radius:4px;vertical-align:middle}
.composer{background:var(--wb-surface);border:1px solid var(--wb-border);border-radius:var(--wb-radius);padding:16px 18px;display:flex;flex-direction:column;gap:12px;min-height:140px}
.composer-label{font-size:12px;font-weight:600;color:var(--wb-muted);letter-spacing:.01em}
.composer input{width:100%;flex:1 1 auto;min-height:44px;border:1px solid var(--wb-border);border-radius:10px;padding:0 14px;font-size:15px;background:var(--wb-panel);outline:none}
.composer input:hover{border-color:var(--wb-faint)}
.composer input:focus{border-color:var(--wb-accent);background:var(--wb-surface)}
.composer input::placeholder{color:var(--wb-muted)}
.composer-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.primary{background:var(--wb-accent);color:var(--oc-primary-fg,var(--oc-bg));border:0;border-radius:10px;padding:9px 18px;font-size:13px;font-weight:600;cursor:pointer}
.primary:hover{filter:brightness(1.06)}
.chip{background:transparent;border:1px solid var(--wb-border);color:var(--wb-muted);border-radius:999px;padding:6px 12px;font-size:13px;cursor:pointer;white-space:nowrap}
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
.panel{background:var(--wb-panel);border-radius:var(--wb-radius);padding:18px;display:flex;flex-direction:column;gap:12px;min-width:0}
.side > .panel:first-child:not(.cal-expanded){height:140px;justify-content:space-between}
.panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.panel-head h2{margin:0;font-size:14px;font-weight:600}
.panel-meta{display:flex;align-items:center;justify-content:flex-end;gap:8px;min-width:0;color:var(--wb-muted);font-size:12px}
.cal-clock{font-family:var(--oc-mono);font-size:13px;font-weight:600;letter-spacing:.04em;color:var(--oc-fg);font-variant-numeric:tabular-nums}
.cal-weather{font-size:11px;white-space:nowrap}
.cal-nav{display:flex;align-items:center;gap:6px}
.count-chip{background:var(--wb-surface);border:1px solid var(--wb-border);border-radius:999px;padding:1px 8px;font-size:12px;color:var(--wb-muted)}
.rows{display:flex;flex-direction:column;gap:7px}
.task{display:flex;align-items:center;gap:10px;background:var(--wb-surface);border:1px solid var(--wb-border);border-radius:11px;padding:10px 12px;min-height:56px;cursor:pointer;text-align:left;width:100%}
.task:hover{border-color:var(--wb-faint)}
.task.done .title{color:var(--wb-faint);text-decoration:line-through}
.box{width:18px;height:18px;border:1.5px solid var(--wb-faint);border-radius:5px;flex:none;background:transparent;cursor:pointer;display:grid;place-items:center;padding:0;position:relative}
.box[data-done="true"]{background:var(--wb-accent);border-color:var(--wb-accent)}
.box[data-done="true"]::after{content:"";width:8px;height:4px;border-left:1.5px solid var(--oc-bg);border-bottom:1.5px solid var(--oc-bg);transform:rotate(-45deg) translate(0,-1px)}
.box::before{content:"";position:absolute;inset:-8px}
.title{font-size:13.5px;min-width:0}
.meta-line{display:flex;gap:6px;align-items:center;color:var(--wb-muted);font-size:11.5px;margin-top:2px;flex-wrap:wrap}
.due{color:var(--wb-accent)}
.due.late{color:var(--wb-negative)}
.origin{color:var(--wb-faint)}
.filter-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0}
.filter-group{display:inline-flex;align-items:center;gap:7px;min-width:0}
.filter-group.grow{flex:1 1 220px}
.filter-label{font-size:12px;color:var(--wb-muted);white-space:nowrap}
.filter-row .seg{flex-wrap:nowrap}
.filter-row input{flex:1;width:100%;height:30px;border:1px solid var(--wb-border);border-radius:10px;padding:0 12px;background:var(--wb-surface);font-size:13px;color:var(--oc-fg);outline:none}
.filter-row input:focus{border-color:var(--wb-accent)}
.filter-row input::placeholder{color:var(--wb-muted)}
.seg{display:inline-flex;align-items:center;gap:2px;padding:2px;background:var(--wb-panel);border:1px solid transparent;border-radius:10px;flex-wrap:wrap}
.seg button{border:0;background:none;padding:4px 8px;border-radius:8px;font-size:12px;color:var(--wb-muted);cursor:pointer;white-space:nowrap}
.seg button:hover{color:var(--oc-fg)}
.seg button[aria-pressed='true']{background:var(--wb-surface);color:var(--oc-fg);box-shadow:0 1px 2px rgba(0,0,0,.06)}
.toolbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-width:0;flex:1 1 220px}
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
.field-pair{display:flex;gap:6px}
.field-pair input{min-width:0}
.field-pair input[type='time']{flex:0 0 112px;padding-left:6px;padding-right:6px}
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
.tag{font-size:11px;line-height:1;border:1px solid var(--wb-border);border-radius:999px;padding:2px 7px;color:var(--wb-accent)}
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
.deliverables .panel-head{align-items:center}
.deliverables .panel-head .chip{padding:2px 8px;font-size:11px}
.deliverables .rows{display:grid;grid-template-columns:repeat(auto-fill,minmax(178px,1fr));gap:12px}
.deliverable-card{min-width:0;padding:8px;border-radius:10px;background:var(--wb-surface);cursor:pointer;display:flex;flex-direction:column;gap:8px;transition:background .15s ease}
.deliverable-card:hover{background:color-mix(in srgb,var(--wb-accent) 7%,var(--wb-surface))}
.deliverable-card:focus-visible{outline:2px solid var(--wb-accent);outline-offset:2px}
.deliverable-thumb{position:relative;aspect-ratio:16/10;border-radius:7px;overflow:hidden;background:var(--wb-panel);display:flex;align-items:center;justify-content:center}
.deliverable-image{width:100%;height:100%;object-fit:contain;object-position:top center;background:#fff}
.deliverable-image[hidden],.deliverable-fallback[hidden]{display:none}
.deliverable-fallback{width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:linear-gradient(145deg,color-mix(in srgb,var(--wb-accent) 9%,var(--wb-panel)),var(--wb-panel))}
.deliverable-fallback-label{font-size:11px;color:var(--wb-muted)}
.deliverable-body{min-width:0}
.deliverable .title{font-size:12.5px;font-weight:500;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.deliverable .meta-line{margin-top:3px;font-size:10.5px;color:var(--wb-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.deliverable-kind{display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:34px;height:20px;padding:0 5px;border-radius:5px;background:var(--wb-panel);color:var(--wb-muted);font:600 9px/1 var(--oc-font);letter-spacing:.04em}
.deliverable-kind[data-kind="docx"],.deliverable-kind[data-kind="pdf"]{color:var(--wb-accent);background:color-mix(in srgb,var(--wb-accent) 10%,transparent)}
.deliverable-kind[data-kind="pptx"]{color:#b06a1f;background:color-mix(in srgb,#d97706 12%,transparent)}
.deliverable-kind[data-kind="mp4"]{color:#7c5cbf;background:color-mix(in srgb,#7c5cbf 12%,transparent)}
.deliverable-kind[data-kind="html"],.deliverable-kind[data-kind="htm"]{color:#2f7d6d;background:color-mix(in srgb,#2f7d6d 12%,transparent)}
.deliverable-copy{position:absolute;top:6px;right:6px;border:0;border-radius:5px;background:color-mix(in srgb,var(--wb-panel) 88%,transparent);color:var(--wb-muted);font-size:10px;line-height:1;padding:5px 6px;cursor:pointer;opacity:0;transition:opacity .15s ease}
.deliverable-card:hover .deliverable-copy,.deliverable-card:focus-within .deliverable-copy{opacity:1}
.deliverable-copy:hover{color:var(--wb-accent)}
@media(max-width:720px){.deliverables .rows{grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:9px}}
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
  .greeting{grid-template-columns:1fr;gap:16px}
  .greeting h1{font-size:28px}
  .soup{justify-self:start;text-align:left}
  .soup-line{text-align:left}
}
@media(max-width:520px){
  .composer{padding:12px}
  .chip{padding:5px 9px;font-size:12px}
  .composer-row{gap:8px}

  .counts{grid-template-columns:1fr 1fr}
  .greeting h1{font-size:24px}
  .editor-row{grid-template-columns:1fr}
}
.notes-row{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(320px,1fr);gap:16px;align-items:start}
.notes-panel{position:sticky;top:18px}
.task-search{width:170px;height:30px;flex:none;border:1px solid var(--wb-border);border-radius:9px;padding:0 10px;background:var(--wb-surface);font-size:12.5px;outline:none}
.task-search:focus{border-color:var(--wb-accent)}
.task-search::placeholder{color:var(--wb-muted)}
.note-composer{position:relative;display:flex;flex-direction:column;gap:6px;padding:12px 12px 10px;border-radius:6px;background:color-mix(in srgb,#f0d488 26%,var(--wb-surface));border:1px solid color-mix(in srgb,#f0d488 42%,var(--wb-border));box-shadow:0 2px 6px rgba(0,0,0,.05);transform:rotate(-.5deg)}
.note-composer::before{content:'';position:absolute;top:-6px;left:50%;width:46px;height:12px;transform:translateX(-50%) rotate(-2.5deg);background:color-mix(in srgb,var(--oc-fg) 9%,transparent);border-radius:1px;pointer-events:none}
.note-composer textarea{width:100%;min-height:58px;max-height:150px;resize:vertical;border:0;outline:none;background:transparent;font-family:var(--wb-hand);font-size:15px;line-height:1.55;color:var(--oc-fg);padding:0}
.note-composer textarea::placeholder{font-family:var(--oc-font);color:var(--wb-faint)}
.note-composer-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.note-hint{font-size:10.5px;color:var(--wb-faint)}
.note-stick{border:0;border-radius:999px;padding:5px 13px;background:var(--wb-accent);color:var(--oc-primary-fg,var(--oc-bg));font-size:12px;font-weight:600;cursor:pointer}
.note-stick:hover{filter:brightness(1.06)}
.note-stick:disabled{opacity:.6;cursor:default}
.notes-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:12px;align-items:start;max-height:min(48vh,480px);overflow-y:auto;padding:8px 6px 6px;margin:-8px -6px 0;scrollbar-width:thin}
.notes-list::-webkit-scrollbar{width:8px}
.notes-list::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--oc-fg) 18%,transparent);border-radius:999px}
.notes-list::-webkit-scrollbar-track{background:transparent}
.notes-list .empty{grid-column:1/-1}
.note{position:relative;display:flex;flex-direction:column;gap:6px;min-height:104px;padding:12px 12px 9px;border-radius:5px;background:color-mix(in srgb,var(--note-tint,#f0d488) 32%,var(--wb-surface));border:1px solid color-mix(in srgb,var(--note-tint,#f0d488) 46%,var(--wb-border));box-shadow:0 2px 6px rgba(0,0,0,.06);transform:rotate(var(--note-tilt,-.8deg));transition:transform .15s ease,box-shadow .15s ease}
.note:nth-child(3n+2){--note-tilt:.9deg}
.note:nth-child(3n){--note-tilt:-.3deg}
.note:hover{transform:rotate(0) translateY(-1px);box-shadow:0 6px 16px rgba(0,0,0,.1)}
.note::before{content:'';position:absolute;top:-6px;left:50%;width:42px;height:11px;transform:translateX(-50%) rotate(-2deg);background:color-mix(in srgb,var(--oc-fg) 8%,transparent);border-radius:1px;pointer-events:none}
.note-copy{min-width:0;display:flex;flex-direction:column;gap:6px;flex:1 1 auto}
.note-body{font-family:var(--wb-hand);font-size:14px;line-height:1.55;white-space:pre-wrap;overflow:hidden;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;padding-right:10px}
.note-meta{font-size:10px;color:var(--wb-faint);margin-top:auto;letter-spacing:.02em}
.note-del{position:absolute;top:3px;right:4px;border:0;background:transparent;color:color-mix(in srgb,var(--oc-fg) 40%,transparent);font-size:14px;line-height:1;cursor:pointer;padding:2px 4px;opacity:0;transition:opacity .12s ease}
.note:hover .note-del,.note:focus-within .note-del{opacity:1}
.note-del:hover{color:var(--wb-negative)}
.note-toggle{border:0;background:transparent;color:var(--wb-muted);font-size:11.5px;padding:2px 6px;border-radius:6px;cursor:pointer}
.note-toggle:hover{background:var(--wb-surface);color:var(--oc-fg)}
.note-pile-board{position:relative;width:100%;height:172px;cursor:pointer;border-radius:10px;outline:none}
.note-pile-board:focus-visible{outline:2px solid var(--wb-accent);outline-offset:2px}
.notes-panel.is-collapsed{padding-bottom:14px;gap:10px}
.note-pile-card{position:absolute;top:10px;left:50%;width:calc(50% - 6px);height:132px;overflow:hidden;transition:transform .16s ease,box-shadow .16s ease;box-shadow:0 3px 9px rgba(0,0,0,.08)}
.note-pile-card:nth-child(1){z-index:3;transform:translateX(-50%) rotate(-1.8deg)}
.note-pile-card:nth-child(2){z-index:2;transform:translateX(calc(-50% + 22px)) translateY(14px) rotate(3.6deg)}
.note-pile-card:nth-child(3){z-index:1;transform:translateX(calc(-50% - 22px)) translateY(30px) rotate(-4.8deg)}
.note-pile-board:hover .note-pile-card:nth-child(1){transform:translateX(-50%) translateY(-3px) rotate(-1.8deg)}
.note-pile-board:hover .note-pile-card:nth-child(2){transform:translateX(calc(-50% + 28px)) translateY(18px) rotate(4.4deg)}
.note-pile-board:hover .note-pile-card:nth-child(3){transform:translateX(calc(-50% - 28px)) translateY(36px) rotate(-5.6deg)}
.note-pile-card .note-body{-webkit-line-clamp:3}
.note-pile-count{position:absolute;right:8px;bottom:6px;z-index:4;background:var(--wb-panel);border:1px solid var(--wb-border);border-radius:999px;padding:1px 7px;font-size:10.5px;color:var(--wb-muted)}
.note-pile-empty{position:relative;z-index:1;margin-top:16px;padding:16px 12px;border-radius:5px;border:1px dashed var(--wb-border);color:var(--wb-muted);font-size:12px;background:var(--wb-surface)}
:root[data-oc-theme="dark"] .note{background:color-mix(in srgb,var(--note-tint,#f0d488) 14%,var(--wb-surface));border-color:color-mix(in srgb,var(--note-tint,#f0d488) 22%,var(--wb-border))}
:root[data-oc-theme="dark"] .note-composer{background:color-mix(in srgb,#f0d488 12%,var(--wb-surface));border-color:color-mix(in srgb,#f0d488 18%,var(--wb-border))}
@media (max-width: 1100px){
  .notes-row{grid-template-columns:minmax(0,1fr)}
  .notes-panel{position:static}
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
  return new Date(`${iso}T00:00:00`).toLocaleDateString(workbenchLocale(), { month: 'short', day: 'numeric' });
};

export const relativeDay = (iso: string, today: string): string => {
  if (!iso) return '';
  if (iso === today) return t('todayRelative');
  const start = new Date(`${today}T00:00:00`);
  const due = new Date(`${iso}T00:00:00`);
  const days = Math.round((due.getTime() - start.getTime()) / 86_400_000);
  if (days === 1) return t('tomorrow');
  if (days === -1) return t('yesterday');
  return formatDate(iso);
};
