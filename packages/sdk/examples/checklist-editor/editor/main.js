(()=>{var S="openchamber.sdk",g=1;var ze=`
:root {
  /* Quiet at rest like the app's own thumbs; hover gives a clear grab target. */
  --oc-scrollbar-thumb: color-mix(in srgb, var(--oc-muted, currentColor) 18%, transparent);
  --oc-scrollbar-thumb-hover: color-mix(in srgb, var(--oc-muted, currentColor) 36%, transparent);
  scrollbar-gutter: stable;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
:hover, [data-oc-scrolling] {
  scrollbar-color: var(--oc-scrollbar-thumb) transparent;
}
/* Chromium's standard scrollbar properties otherwise override its pseudo-elements. */
@supports selector(::-webkit-scrollbar) {
  *, :hover, [data-oc-scrolling] { scrollbar-width: auto; scrollbar-color: auto; }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
    min-width: 24px;
    min-height: 24px;
  }
  :hover::-webkit-scrollbar-thumb, [data-oc-scrolling]::-webkit-scrollbar-thumb { background: var(--oc-scrollbar-thumb); }
  ::-webkit-scrollbar-thumb:hover { background: var(--oc-scrollbar-thumb-hover); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (forced-colors: active) {
  *, :hover, [data-oc-scrolling] { scrollbar-color: auto; }
  ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;function Ke(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let s=new WeakMap;e.addEventListener("scroll",(l)=>{let d=l.target===e?r:l.target;if(!(d instanceof Element))return;if(!d.hasAttribute("data-oc-scrolling"))d.setAttribute("data-oc-scrolling","");let m=s.get(d);if(m!==void 0)clearTimeout(m);s.set(d,setTimeout(()=>{s.delete(d),d.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var Fo=`(${Ke.toString()})(document);`;var Je=128,Ye=65536;var be=128;var _e=65536;var Jt=/^[a-z][a-z0-9-]{0,39}$/;var jt=(e)=>Object(e)===e&&!Array.isArray(e),Qe=(e,r)=>Object.keys(e).every((s)=>r.includes(s)),zt=(e)=>String(e)===e&&e.length>=1&&e.length<=60,Kt=(e)=>String(e)===e&&e.length>=1&&e.length<=80,Yt=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let s of e){if(!jt(s)||!Jt.test(s.id)||!zt(s.label))return!1;if(s.disabled!==void 0&&s.disabled!==!0&&s.disabled!==!1)return!1;if(r.has(s.id))return!1;if(r.add(s.id),s.kind==="button"){if(!Qe(s,["kind","id","label","disabled"]))return!1;continue}if(s.kind!=="select"||!Qe(s,["kind","id","label","value","options","disabled"]))return!1;if(!Kt(s.value)||!Array.isArray(s.options)||s.options.length<1||s.options.length>16)return!1;let l=new Set;for(let d of s.options){if(!jt(d)||!Qe(d,["value","label"])||!Kt(d.value)||!zt(d.label)||l.has(d.value))return!1;l.add(d.value)}if(!l.has(s.value))return!1}return!0};var Te=20000000,xe=256;var Ze=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,Qt=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let s=0;s<e.bytes.byteLength;s+=1)if(e.bytes[s]!==r.bytes[s])return!1;return!0},ve=(e)=>{let r=e,s=e;return{observe:(l)=>{let d=l!==s;return s=l,{edited:d,dirty:l!==r}},markSaved:(l)=>(r=l,s!==l)}};var Zt=/^[A-Za-z0-9_-]{1,80}$/;var eo=["left","right","top","bottom"];var to=(e,r=0,s={remaining:16000})=>{if(--s.remaining<0||r>=32)return!1;if(e===null)return!0;let l=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let d of l)if(!to(d,r+1,s))return!1;return!0},et=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(et);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(et)}return String(e)===e||Number.isFinite(e)},tt=(e)=>{try{if(String(e.id)!==e.id||!Zt.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!eo.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!to(e.data)||!et(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var ro=["file","directory","other","missing"],rt=(e)=>Boolean(e&&"sessionId"in e),st=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var so=/^[0-9a-f]{7,64}$/i,nt=(e)=>so.test(e),Re=500,Oe=32000,no=16000,io=128,ao=200,lo=2000,co=16000,uo=80,po=200,So=16000;var go=2000;var it=20000,Ce=1024,Ae=2000000;var ke=64000,Ge=8000,at=4000;var lt=960000;var mo=999,Eo=1e4,de=500,ho=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],fo=["stopped","starting","ready","failed"],Xo=new Set(ho),yo=(e)=>Xo.has(e),bo=(e)=>e&&yo(e)?e:"HOST_REJECTED",ee=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(ee);if(Object(e)===e)return Object.values(e).every(ee);return!1},_o=(e)=>ee(e)&&JSON.stringify(e).length<=So,oo=(e)=>e?.trim().slice(0,po)??"",te=(e)=>{let r=e.id.trim().slice(0,io),s=e.title.trim().slice(0,ao),l=e.url.trim().slice(0,lo),d=e.text?.trim().slice(0,co),m=e.author?.trim().slice(0,uo),f=e.kind==="pull"?"pull":"issue",E={providerId:e.providerId.trim(),id:r,title:s||r,url:l,kind:f};if(d)E.text=d;if(m)E.author=m;if(f==="pull"){let A=oo(e.branches?.head),w=oo(e.branches?.base);if(A&&w)E.branches={head:A,base:w}}if(_o(e.data))E.data=e.data;return E},ct=(e)=>{let r=te(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},ut=(e)=>{let r={text:e.text.trim().slice(0,no)};if(e.send)r.send=!0;return r},pt=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(mo,Math.max(0,Math.round(e)))},dt=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(Eo,Math.max(0,Math.ceil(e)))};var oe=(e)=>e.length>0&&e.length<=Ce&&!e.includes("\x00")&&!e.includes("\\");var Pe=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>go)return!1;return!e.split("/").some((s)=>s==="."||s==="..")},Vo=new Set(fo),St=(e)=>Boolean(e&&"status"in e&&Vo.has(String(e.status))&&!("body"in e)),Me=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),gt=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),mt=(e)=>Boolean(e&&"written"in e&&e.written===!0),Et=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),$o=new Set(ro),ht=(e)=>Boolean(e&&"kind"in e&&"size"in e&&$o.has(String(e.kind))&&Number.isFinite(e.size)),To=(e)=>Boolean(e&&"dataUrl"in e&&(e.dataUrl===null||String(e.dataUrl)===e.dataUrl)),ft=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),qo=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late"]),Wo=(e)=>Object(e)===e?e:null,ot=(e)=>String(e)===e&&e.length>0,jo=(e)=>{if(!ot(e.id))return null;if(e.ok===!0){let r={channel:S,v:g,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&ot(e.error))return{channel:S,v:g,type:"result",id:e.id,ok:!1,error:e.error,code:bo(ot(e.code)?e.code:void 0)};return null},yt=(e)=>{let r=Wo(e);if(!r||r.channel!==S||r.v!==g)return null;if(r.type==="result")return jo(r);if(!qo.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var xo=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),zo=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class i extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var vo=()=>Promise.reject(new i("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),we=()=>Promise.reject(new i("BAD_PATH",`File path must be 1 to ${Ce} characters without NUL or backslash.`)),Ie=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new i("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},p=(e)=>(e.value+=1,`oc-${e.value}`),bt=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new i("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let s=e.acceptSource??((t)=>t===r.parent),l=e.requestTimeoutMs??it,d=new Set,m=new Set,f=new Set,E=new Set,A=new Set,w=new Set,ne=new Set,Se=new Set,ge=new Set,J=new Set,Ve=[],ie=null,ae=null,me=new Set,Ee=new Set,le=null,ce=null,$e=!1,Y=new Map,Q=new Map,Z=new Map,H=!1,u={value:0},c=null,D=null,ue=!1,pe=!1,Ut=null,Lt=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},I=(t)=>{r.parent.postMessage(t,"*")},Nt=()=>{if(H||r.parent===r||J.size===0||c?.features?.lateGenerateResults!==!0)return;I({channel:S,v:g,type:"generate-late-listen"})},x=(t,o)=>{for(let n of t)try{n(o)}catch(a){console.error(a)}},Ht=(t)=>{if(!(t instanceof MessageEvent))return;if(!s(t.source))return;let o=yt(t.data);if(!o)return;if(o.type==="workspace"){let a=Q.get(o.payload.subscriptionId);if(a)x([a],o.payload.snapshot);return}if(o.type==="shells"){let a=Z.get(o.payload.subscriptionId);if(a)x([a],o.payload.snapshot);return}if(o.type==="ready"){if(c=o.payload,D=Lt(o.payload.session),x(d,o.payload),x(m,o.payload.directory),x(f,o.payload.session),D)x(E,D);x(A,o.payload.connection),x(w,o.payload.settings),x(ne,o.payload.item),Nt();return}if(o.type==="generate-late"){if(J.size===0)Ve.push(o.payload);else x(J,o.payload);return}if(o.type==="directory"){if(c)c={...c,directory:o.payload.directory};x(m,o.payload.directory);return}if(o.type==="session"){if(c)c={...c,session:o.payload.session};if(!o.payload.session)D=null;else if(D?.sessionId!==o.payload.session.id)D=Lt(o.payload.session);x(f,o.payload.session);return}if(o.type==="session-lifecycle"){D=o.payload,x(E,o.payload);return}if(o.type==="connection"){if(c)c={...c,connection:o.payload.connection};x(A,o.payload.connection);return}if(o.type==="settings"){if(c)c={...c,settings:o.payload.settings};x(w,o.payload.settings);return}if(o.type==="item"){if(c)c={...c,item:o.payload.item};x(ne,o.payload.item);return}if(o.type==="status-control-event"){x(Se,o.payload);return}if(o.type==="popover-closed"){x(ge,o.payload);return}if(o.type==="action"){let a=(h)=>{if(!H)I({channel:S,v:g,type:"action-result",id:o.id,payload:h})},b=ae;if(!b){a({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>b(o.payload)).then(()=>a({ok:!0}),(h)=>{let O=(h instanceof Error?h.message:String(h)).trim();a({ok:!1,error:(O||"Action failed.").slice(0,de)})});return}if(o.type==="file-open"){let a=o.payload;if(ce&&Qt(ce,a))return;ce=a,x(me,o.payload);return}if(o.type==="file-saved"){x(Ee,o.payload.version);return}if(o.type==="file-snapshot"){let a=(O)=>{if(!H)I({channel:S,v:g,type:"file-snapshot-result",id:o.id,payload:O})},b=(O)=>a({error:(O.trim()||"Could not read the edited file.").slice(0,de)}),h=le;if(!h){b("This extension does not edit files.");return}Promise.resolve().then(()=>h(o.payload.purpose)).then((O)=>{if(Ze(O)>Te){b(`The file is over ${Te} ${"bytes"in O?"bytes":"characters"}.`);return}if(O.version.length>xe){b(`The snapshot version is over ${xe} characters.`);return}a({snapshot:"bytes"in O?{bytes:O.bytes,version:O.version}:{content:O.content,version:O.version}})},(O)=>b(O instanceof Error?O.message:String(O)));return}if(o.type==="resolve"){let a=(h)=>{I({channel:S,v:g,type:"resolve-result",id:o.id,payload:h})},b=ie;if(!b){a({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>b(o.payload)).then((h)=>a({item:h?te(h):null}),(h)=>{let O=(h instanceof Error?h.message:String(h)).trim();a({error:(O||"Command failed.").slice(0,de)})});return}let n=Y.get(o.id);if(!n)return;if(clearTimeout(n.timer),Y.delete(o.id),o.ok){n.resolve(o.payload);return}n.reject(new i(o.code,o.error))};r.addEventListener("message",Ht),I({channel:S,v:g,type:"hello"});let P=(t,o=l)=>{if(H||r.parent===r)return Promise.reject(new i("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((n,a)=>{let b=setTimeout(()=>{Y.delete(t.id),a(new i("HOST_TIMEOUT","Host did not answer in time."))},o);Y.set(t.id,{resolve:n,reject:a,timer:b}),I(t)})},y=(t)=>P(t).then(()=>{return}),R={channel:S,v:g},qe=(t)=>{if(!H&&r.parent!==r)I(t)},Dt=()=>qe({...R,type:"file-save"}),Ft=(t)=>{if(!xo(t)||!zo(t))return;t.preventDefault(),Dt()},Bt=(t)=>{if(!xo(t)||t.key!=="Escape"||c?.surface!=="popover"||!c.popover)return;t.preventDefault(),qt(c.popover.id,"escape").catch(()=>{return})},he=()=>{let t=c?.surface==="popover"?c.popover:void 0;if(!t)return;let o=ue||pe;if(Ut===o)return;Ut=o,Wt(t.id,o).catch(()=>{return})},fe=()=>{if(c?.surface!=="popover"||ue)return;ue=!0,he()},Xt=(t)=>{if(c?.surface!=="popover"||t.relatedTarget!==null||!ue)return;ue=!1,he()},Vt=()=>{if(c?.surface!=="popover"||pe)return;pe=!0,he()},$t=()=>{if(c?.surface!=="popover"||!pe)return;pe=!1,he()},N=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new i("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},We=async(t)=>{if(t.kind!=="projects")N(t.projectId);let o=await P({...R,type:"workspace-read",id:p(u),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new i("HOST_REJECTED","Host did not return workspace data.");return o},je=async(t,o)=>{if(t.kind!=="projects")N(t.projectId);let n=p(u);Q.set(n,o);try{await y({...R,type:"workspace-subscribe",id:p(u),payload:{subscriptionId:n,query:t}})}catch(a){if(Q.delete(n),!H)I({...R,type:"workspace-unsubscribe",id:p(u),payload:{subscriptionId:n}});throw a}return()=>{if(!Q.delete(n)||H)return;I({...R,type:"workspace-unsubscribe",id:p(u),payload:{subscriptionId:n}})}},Do=async(t,o)=>{if(t.kind==="session")N(t.sessionId);if(t.kind==="project")N(t.projectId);let n=p(u);Z.set(n,o);try{await y({...R,type:"shells-subscribe",id:p(u),payload:{subscriptionId:n,scope:t}})}catch(a){if(Z.delete(n),!H)I({...R,type:"shells-unsubscribe",id:p(u),payload:{subscriptionId:n}});throw a}return()=>{if(!Z.delete(n)||H)return;I({...R,type:"shells-unsubscribe",id:p(u),payload:{subscriptionId:n}})}},ye=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>Je))throw new i("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!ee(t.value))throw new i("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>Ye)throw new i("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&c?.features?.deviceStorage!==!0)throw new i("UNSUPPORTED","This host does not support device storage.");let o=await P({...R,type:"storage",id:p(u),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new i("HOST_REJECTED","Host did not return storage data.");return o},qt=(t,o)=>c?.features?.popovers!==!0&&!(c?.surface==="popover"&&c.popover?.id===t)?Promise.reject(new i("UNSUPPORTED","This host does not support popovers.")):y({...R,type:"popover-close",id:p(u),payload:o?{id:t,reason:o}:{id:t}}),Wt=(t,o)=>c?.features?.popovers!==!0&&!(c?.surface==="popover"&&c.popover?.id===t)?Promise.reject(new i("UNSUPPORTED","This host does not support popovers.")):y({...R,type:"popover-anchor",id:p(u),payload:{id:t,active:o}});return r.addEventListener("keydown",Bt,!0),r.addEventListener("pointerover",fe),r.addEventListener("pointermove",fe),r.addEventListener("pointerout",Xt),r.addEventListener("focus",Vt),r.addEventListener("blur",$t),{onAction:(t)=>(ae=t,()=>{if(ae===t)ae=null}),listProjects:async()=>{let t=await We({kind:"projects"});if(t.kind!=="projects")throw new i("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await We({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new i("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await We({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new i("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>je({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>je({kind:"worktrees",projectId:t},(n)=>{if(n.kind==="worktrees")o(n)}),onSessions:(t,o)=>je({kind:"sessions",projectId:t},(n)=>{if(n.kind==="sessions")o(n)}),onRunningShells:(t,o)=>Do(t,o),readShellOutput:async(t,o)=>{N(t,be);let n=o?.cursor;if(n!==void 0&&(!Number.isInteger(n)||n<0))throw new i("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let a=o?.tailBytes;if(a!==void 0&&(!Number.isInteger(a)||a<1||a>_e))throw new i("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${_e}.`);let h=await P({...R,type:"shell-output",id:p(u),payload:{shellId:t,cursor:n,tailBytes:a}});if(!h||typeof h.output!=="string"||!Number.isFinite(h.cursor))throw new i("HOST_REJECTED","Host did not return shell output.");return h},stopShell:async(t)=>{if(N(t,be),(await P({...R,type:"shell-stop",id:p(u),payload:{shellId:t}}))?.stopped!==!0)throw new i("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{N(t),await y({...R,type:"open-session",id:p(u),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let n=Ie(o),a={op:"get",key:t};if(n)a.scope=n;let b=await ye(a);return b.op==="get"&&b.found?b.value:void 0},set:async(t,o,n)=>{let a=Ie(n),b={op:"set",key:t,value:o};if(a)b.scope=a;await ye(b)},delete:async(t,o)=>{let n=Ie(o),a={op:"delete",key:t};if(n)a.scope=n;await ye(a)},keys:async(t)=>{let o=Ie(t),n={op:"keys"};if(o)n.scope=o;let a=await ye(n);if(a.op!=="keys")throw new i("HOST_REJECTED","Expected storage keys.");return a.keys}},onReady:(t)=>{if(d.add(t),c)t(c);return()=>{d.delete(t)}},onDirectory:(t)=>{if(m.add(t),c)t(c.directory);return()=>{m.delete(t)}},onSession:(t)=>{if(f.add(t),c)t(c.session);return()=>{f.delete(t)}},onSessionLifecycle:(t)=>{if(E.add(t),D)t(D);return()=>{E.delete(t)}},onConnection:(t)=>{if(A.add(t),c)t(c.connection);return()=>{A.delete(t)}},onSettings:(t)=>{if(w.add(t),c)t(c.settings);return()=>{w.delete(t)}},onItem:(t)=>{if(ne.add(t),c)t(c.item);return()=>{ne.delete(t)}},onStatusControl:(t)=>(Se.add(t),()=>{Se.delete(t)}),onPopoverClosed:(t)=>(ge.add(t),()=>{ge.delete(t)}),setStatusControls:(t)=>{if(c?.features?.statusControls!==!0)return Promise.reject(new i("UNSUPPORTED","This host does not support status controls."));if(!Yt(t))return Promise.reject(new i("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return y({...R,type:"status-controls",id:p(u),payload:{controls:t}})},openPopover:(t)=>{if(c?.features?.popovers!==!0)return Promise.reject(new i("UNSUPPORTED","This host does not support popovers."));if(!tt(t))return Promise.reject(new i("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return y({...R,type:"popover-open",id:p(u),payload:t})},closePopover:qt,setPopoverAnchorActive:Wt,onResolve:(t)=>(ie=t,()=>{if(ie===t)ie=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>Re)return Promise.reject(new i("HOST_REJECTED",`Toast message must contain 1 to ${Re} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>Oe))return Promise.reject(new i("HOST_REJECTED",`Toast copy text must contain 1 to ${Oe} characters.`));return y({channel:S,v:g,type:"toast",id:p(u),payload:{...t,message:o}})},openUrl:(t)=>y({channel:S,v:g,type:"open-url",id:p(u),payload:{url:t}}),openCommit:(t)=>nt(t)?y({channel:S,v:g,type:"open-commit",id:p(u),payload:{sha:t}}):Promise.reject(new i("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),openSurface:(t)=>y({channel:S,v:g,type:"open-surface",id:p(u),payload:{surfaceId:t}}),openProjectDialog:()=>{if(c?.features?.projectDialog!==!0)return Promise.reject(new i("UNSUPPORTED","This host cannot open the project dialog."));return y({channel:S,v:g,type:"open-project-dialog",id:p(u)})},openPage:(t,o)=>y({channel:S,v:g,type:"open-page",id:p(u),payload:o?{pageId:t,intent:o}:{pageId:t}}),previewFile:(t)=>{let o=String(t??"").trim();if(!o||o.length>1024||o.startsWith("/")||o.startsWith("~/")||/^[A-Za-z]:/.test(o)||o.includes("\x00")||o.split("/").includes(".."))return Promise.reject(new i("BAD_PATH","Preview path must be relative to the open project."));return y({channel:S,v:g,type:"preview-file",id:p(u),payload:{path:o}})},openFile:(t)=>{let o=String(t??"").trim();if(!o||o.length>1024||o.includes("\x00")||o.split("/").includes(".."))return Promise.reject(new i("BAD_PATH","File path is malformed."));return y({channel:S,v:g,type:"open-file",id:p(u),payload:{path:o}})},thumbnailFile:async(t)=>{let o=String(t??"").trim();if(!o||o.length>1024||o.includes("\x00")||o.split("/").includes(".."))throw new i("BAD_PATH","File path is malformed.");let n=await P({channel:S,v:g,type:"thumbnail-file",id:p(u),payload:{path:o}});if(!To(n))throw new i("HOST_REJECTED","Host did not return a thumbnail.");return n.dataUrl},writeClipboard:(t)=>y({channel:S,v:g,type:"clipboard-write",id:p(u),payload:{text:t}}),compose:(t)=>y({channel:S,v:g,type:"compose",id:p(u),payload:t}),attach:(t)=>y({channel:S,v:g,type:"attach",id:p(u),payload:te(t)}),startSession:async(t)=>{if(t.projectId!==void 0)N(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")N(o.directory);else{if(o.name!==void 0)N(o.name,200);if(o.baseBranch!==void 0)N(o.baseBranch,200)}let n=await P({channel:S,v:g,type:"start-session",id:p(u),payload:ct(t)},e.requestTimeoutMs??180000);if(!rt(n))throw new i("HOST_REJECTED","Host did not return a session.");return n},prompt:(t)=>P({channel:S,v:g,type:"prompt",id:p(u),payload:ut(t)}).then((o)=>{if(!st(o))throw new i("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>y({channel:S,v:g,type:"session-link",id:p(u),payload:te(t)}),close:()=>y({channel:S,v:g,type:"close",id:p(u)}),oauthStart:()=>y({channel:S,v:g,type:"oauth-start",id:p(u)}),oauthDisconnect:()=>y({channel:S,v:g,type:"oauth-disconnect",id:p(u)}),request:(t)=>(Pe(t.path)?P({channel:S,v:g,type:"request",id:p(u),payload:t}):vo()).then((o)=>{if(!Me(o))throw new i("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(Pe(t.path)?P({channel:S,v:g,type:"service-request",id:p(u),payload:t}):vo()).then((o)=>{if(!Me(o))throw new i("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>P({channel:S,v:g,type:"service-status",id:p(u)}).then((t)=>{if(!St(t))throw new i("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(oe(t)?P({channel:S,v:g,type:"file-read",id:p(u),payload:{path:t}}):we()).then((o)=>{if(!gt(o))throw new i("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!oe(t))return we();if(o.length>Ae)return Promise.reject(new i("FILE_TOO_LARGE",`Content is over ${Ae} characters.`));return P({channel:S,v:g,type:"file-write",id:p(u),payload:{path:t,content:o}}).then((n)=>{if(!mt(n))throw new i("HOST_REJECTED","Host did not confirm the write.");return n})},listDir:(t)=>(oe(t)?P({channel:S,v:g,type:"file-list",id:p(u),payload:{path:t}}):we()).then((o)=>{if(!Et(o))throw new i("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(oe(t)?P({channel:S,v:g,type:"file-stat",id:p(u),payload:{path:t}}):we()).then((o)=>{if(!ht(o))throw new i("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),n=t.system?.trim();if(o.length===0||o.length>ke)return Promise.reject(new i("HOST_REJECTED",`Prompt must be 1 to ${ke} characters.`));if(n!==void 0&&(n.length===0||n.length>Ge))return Promise.reject(new i("HOST_REJECTED",`System prompt must be 1 to ${Ge} characters.`));let a=t.maxOutputTokens===void 0?void 0:Math.min(at,Math.max(1,Math.floor(t.maxOutputTokens)));if(a!==void 0&&!Number.isFinite(a))return Promise.reject(new i("HOST_REJECTED","maxOutputTokens must be a number."));let b={prompt:o};if(n!==void 0)b.system=n;if(a!==void 0)b.maxOutputTokens=a;return P({channel:S,v:g,type:"generate",id:p(u),payload:b},e.requestTimeoutMs??lt).then((h)=>{if(!ft(h))throw new i("HOST_REJECTED","Host did not return generated text.");return h})},onLateGenerateResult:(t)=>{J.add(t);for(let o of Ve.splice(0))x([t],o);return Nt(),()=>{J.delete(t)}},setBadge:(t)=>y({channel:S,v:g,type:"badge",id:p(u),payload:{count:pt(t)}}),setHeight:(t)=>y({channel:S,v:g,type:"resize",id:p(u),payload:{height:dt(t)}}),onFileOpen:(t)=>{if(me.add(t),!$e)$e=!0,r.addEventListener("keydown",Ft,!0);if(ce)t(ce);return()=>{me.delete(t)}},onFileSnapshot:(t)=>(le=t,()=>{if(le===t)le=null}),onFileSaved:(t)=>(Ee.add(t),()=>{Ee.delete(t)}),reportFileChange:(t)=>qe({...R,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:Dt,reportFileUnsupported:()=>qe({...R,type:"file-unsupported"}),dispose:()=>{for(let t of Q.keys())I({...R,type:"workspace-unsubscribe",id:p(u),payload:{subscriptionId:t}});Q.clear();for(let t of Z.keys())I({...R,type:"shells-unsubscribe",id:p(u),payload:{subscriptionId:t}});if(Z.clear(),H=!0,ie=null,ae=null,le=null,me.clear(),Ee.clear(),$e)r.removeEventListener("keydown",Ft,!0);r.removeEventListener("message",Ht),r.removeEventListener("keydown",Bt,!0),r.removeEventListener("pointerover",fe),r.removeEventListener("pointermove",fe),r.removeEventListener("pointerout",Xt),r.removeEventListener("focus",Vt),r.removeEventListener("blur",$t);for(let t of Y.values())clearTimeout(t.timer),t.reject(new i("HOST_UNAVAILABLE","Host client was disposed."));Y.clear(),d.clear(),m.clear(),f.clear(),E.clear(),A.clear(),w.clear(),ne.clear(),Se.clear(),ge.clear(),J.clear(),Ve.length=0}}};var Ro=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var Gr=new Set(Ro);var Oo=["none","agent","user"];var Mr=new Set(Oo);var Ko=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],Jo=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],Co=(e,r)=>{r.style.colorScheme=e.mode;for(let[s,l]of Ko)r.style.setProperty(s,e.tokens[l]);for(let[s,l,d]of Jo){let m=e.tokens[d]??"";r.style.setProperty(s,m),r.style.setProperty(l,m)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size","0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},_t=(e,r)=>{if(Co(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var Yo={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},T=(e,r)=>`var(--${e}, var(--oc-${Yo[e]}, ${r}))`,B=T("surface-background","transparent"),Le=T("surface-elevated","transparent"),re=T("surface-elevated-foreground","inherit"),L=T("surface-foreground","inherit"),_=T("surface-muted-foreground","gray"),Qo=T("surface-muted","transparent"),X=T("interactive-border","currentColor"),M=T("interactive-hover","transparent"),j=T("interactive-active","transparent"),Tt=T("interactive-selection","transparent"),xt=T("interactive-selection-foreground","inherit"),F=T("primary","currentColor"),vt=T("primary-text","inherit"),Rt=T("error-text","inherit"),Zo=T("font-sans","inherit"),Ot=T("font-mono","monospace"),Mo=T("radius","9px"),Ct=`calc(${Mo} - 2px)`,Ao=`calc(${Mo} - 4px)`,v=(e,r,s="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${s})`,ko=`background-image: linear-gradient(${M}, ${M});`,At=(e)=>`box-shadow: inset 0 0 0 1px ${e}, var(--oc-sdk-field-lift);`,kt="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",Go="box-shadow: var(--oc-sdk-lit);",Po=`inset 0 1px 0 0 ${v(L,1.5)}, 0 1px 1px 0 rgb(0 0 0 / 0.28), 0 2px 3px -2px rgb(0 0 0 / 0.2)`,er=`
:root {
  --oc-sdk-edge: ${v(L,10)};
  --oc-sdk-field-bg: ${Le};
  --oc-sdk-raised-bg: ${B};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 2px 0 rgb(0 0 0 / 0.06);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.45), 0 1px 2px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.1);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.8), inset 0 0 0 1px rgb(0 0 0 / 0.04), 0 1px 2px -0.5px rgb(0 0 0 / 0.08), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.08);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${v(L,6)};
  --oc-sdk-field-bg: ${v(B,50,Le)};
  --oc-sdk-raised-bg: ${Le};
  --oc-sdk-field-lift: ${Po};
  --oc-sdk-raised-lift: ${Po};
  --oc-sdk-lit: inset 0 1px 0 0 ${v(L,1.5)}, 0 1px 1px 0 rgb(0 0 0 / 0.28), 0 2px 3px -2px rgb(0 0 0 / 0.2);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.36);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.06), inset 0 0 0 1px rgb(255 255 255 / 0.08), 0 1px 1px -0.5px rgb(0 0 0 / 0.22), 0 3px 3px -1.5px rgb(0 0 0 / 0.2), 0 6px 6px -3px rgb(0 0 0 / 0.16);
}`,Ue=(e)=>{let r=T(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${T(`${e}-text`,"inherit")}; }`},tr=`
.oc-sdk { box-sizing: border-box; font-size: 0.875rem; line-height: 1.45; }
.oc-sdk *, .oc-sdk *::before, .oc-sdk *::after { box-sizing: border-box; }
/* :where() keeps the reset at zero specificity so every primitive class below overrides it. */
:where(.oc-sdk) :where(button, input, textarea), :where(button.oc-sdk, input.oc-sdk, textarea.oc-sdk) { font: inherit; color: inherit; margin: 0; }
:where(.oc-sdk) :where(button), :where(button.oc-sdk) { cursor: pointer; background: none; border: 0; padding: 0; }
.oc-sdk button:disabled, button.oc-sdk:disabled, .oc-sdk[aria-disabled="true"], .oc-sdk [aria-disabled="true"] { opacity: .5; pointer-events: none; }

.oc-sdk-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 32px; padding: 0 12px; border: 1px solid transparent; font-size: 0.875rem; font-weight: 500; line-height: 1; white-space: nowrap; }
.oc-sdk-btn[data-size="sm"] { gap: 6px; height: 28px; padding: 0 10px; font-size: 0.8125rem; }
.oc-sdk-btn[data-size="xs"] { gap: 4px; height: 24px; padding: 0 8px; font-size: 0.75rem; }
.oc-sdk-btn[data-loading="true"] { opacity: .5; pointer-events: none; }
.oc-sdk-btn > .oc-sdk-spinner-ring { width: 14px; height: 14px; }

.oc-sdk-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-field-label { font-size: 0.8125rem; font-weight: 500; }
.oc-sdk-field-note { font-size: 0.75rem; }
.oc-sdk-input { display: block; width: 100%; min-width: 0; height: 32px; padding: 0 10px; border: 0; font-size: 0.875rem; line-height: 1.45; appearance: none; }
textarea.oc-sdk-input { height: auto; padding: 8px 10px; resize: vertical; }

.oc-sdk-search { position: relative; min-width: 0; }
.oc-sdk-search .oc-sdk-input { padding-left: 34px; padding-right: 34px; }
.oc-sdk-search-icon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); pointer-events: none; }
.oc-sdk-search-clear { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); display: none; align-items: center; justify-content: center; width: 24px; height: 24px; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-clear { display: inline-flex; }

.oc-sdk-select { position: relative; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-trigger { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; width: auto; max-width: 100%; min-width: 0; height: 28px; padding: 0 10px; border: 1px solid transparent; font-size: 0.8125rem; text-align: left; }
.oc-sdk-trigger-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-trigger-chevron { flex: 0 0 auto; }
.oc-sdk-popup { position: fixed; z-index: 50; display: flex; flex-direction: column; gap: 2px; min-width: 160px; max-width: calc(100vw - 16px); max-height: min(320px, calc(100vh - 16px)); overflow: auto; padding: 4px; border: 1px solid transparent; }
.oc-sdk-popup-search { flex: 0 0 auto; padding: 2px 2px 4px; }
.oc-sdk-popup-search .oc-sdk-input { height: 28px; font-size: 0.8125rem; }
.oc-sdk-option { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; font-size: 0.8125rem; text-align: left; }
.oc-sdk-option-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-option-hint { flex: 0 0 auto; font-size: 0.75rem; }
.oc-sdk-option-check { flex: 0 0 auto; display: inline-flex; width: 14px; visibility: hidden; }
.oc-sdk-option[aria-selected="true"] > .oc-sdk-option-check { visibility: visible; }
.oc-sdk-popup-empty { padding: 8px; font-size: 0.8125rem; }

.oc-sdk-check { display: inline-flex; align-items: flex-start; gap: 8px; width: 100%; text-align: left; }
.oc-sdk-check-box { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; margin-top: 3px; border: 1px solid transparent; }
.oc-sdk-check-box > svg { display: none; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box > svg { display: block; }
.oc-sdk-check-thumb { flex: 0 0 auto; position: relative; width: 36px; height: 20px; }
.oc-sdk-check-thumb::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; }
.oc-sdk-check-text { display: flex; flex-direction: column; min-width: 0; }
.oc-sdk-check-label { font-size: 0.875rem; }
.oc-sdk-check-desc { font-size: 0.75rem; }

.oc-sdk-tabs { display: inline-flex; gap: 2px; padding: 2px; max-width: 100%; overflow: auto; }
.oc-sdk-tab { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid transparent; font-size: 0.8125rem; font-weight: 500; white-space: nowrap; }
.oc-sdk-tab-count { font-size: 0.75rem; font-variant-numeric: tabular-nums; }

.oc-sdk-badge { display: inline-flex; align-items: center; padding: 1px 6px; font-size: 11px; font-weight: 500; line-height: 16px; white-space: nowrap; }

.oc-sdk-list { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.oc-sdk-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; text-align: left; }
.oc-sdk-row-lead { flex: 0 0 auto; width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.75rem; }
.oc-sdk-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.oc-sdk-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-row-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.75rem; }
.oc-sdk-row-meta { flex: 0 0 auto; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.oc-sdk-list-empty { padding: 16px 8px; text-align: center; font-size: 0.8125rem; }

.oc-sdk-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 40px 16px; text-align: center; }
.oc-sdk-empty-title { margin: 0; font-size: 0.8125rem; font-weight: 600; }
.oc-sdk-empty-body { margin: 0; max-width: 32rem; font-size: 0.8125rem; }
.oc-sdk-empty-action { margin-top: 12px; }

@keyframes oc-sdk-spin { to { transform: rotate(360deg); } }
.oc-sdk-spinner { display: inline-flex; align-items: center; gap: 8px; font-size: 0.8125rem; }
.oc-sdk-spinner-ring { width: 16px; height: 16px; border: 2px solid transparent; animation: oc-sdk-spin .8s linear infinite; }
.oc-sdk-spinner[data-size="sm"] .oc-sdk-spinner-ring { width: 12px; height: 12px; }

.oc-sdk-banner { display: flex; align-items: flex-start; gap: 12px; padding: 8px 12px; border: 1px solid transparent; }
.oc-sdk-banner-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.oc-sdk-banner-title { font-size: 0.8125rem; font-weight: 500; }
.oc-sdk-banner-body { font-size: 0.8125rem; }
.oc-sdk-banner-action { flex: 0 0 auto; }

.oc-sdk-separator { display: flex; align-items: center; gap: 8px; width: 100%; margin: 8px 0; font-size: 0.75rem; }
.oc-sdk-separator::before, .oc-sdk-separator::after { content: ""; flex: 1 1 auto; height: 1px; }
.oc-sdk-separator[data-labeled="false"]::after { display: none; }
.oc-sdk-popup > .oc-sdk-separator { margin: 4px 0; }

.oc-sdk-progress { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-progress-label { display: flex; justify-content: space-between; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.oc-sdk-progress-track { height: 6px; overflow: hidden; }
.oc-sdk-progress-fill { height: 100%; transform-origin: left; transition: transform 200ms ease-out; }

.oc-sdk-menu { position: relative; display: inline-flex; }

.oc-sdk-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.oc-sdk-text img { display: block; max-width: 100%; margin: 8px 0; }
`,wo=`${er}
.oc-sdk { color: ${L}; font-family: ${Zo}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${ko} }
.oc-sdk-mono { font-family: ${Ot}; }
.oc-sdk-muted { color: ${_}; }
${Ue("success")}${Ue("warning")}${Ue("error")}${Ue("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${F}; --oc-sdk-tone-text: ${vt}; }

.oc-sdk-btn { border-radius: ${Ct}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${Ao}; }
.oc-sdk-btn[data-variant="default"] { color: ${vt}; background: ${v(F,10,B)}; border-color: ${v(F,12)}; ${Go} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${v(F,16,B)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${v(F,22,B)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${Qo}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${j}, ${j}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${re}; ${kt} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${j}, ${j}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${M}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${j}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${T("status-error","red")}; color: ${Rt}; background: ${v("var(--oc-sdk-tone)",7,B)}; border-color: ${v("var(--oc-sdk-tone)",12)}; ${Go} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${v("var(--oc-sdk-tone)",9,B)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${v("var(--oc-sdk-tone)",11,B)}; box-shadow: none; }

.oc-sdk-field-note { color: ${_}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${Rt}; }
.oc-sdk-input { border-radius: ${Ct}; background: var(--oc-sdk-field-bg); color: ${re}; ${At("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${_}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${At(v(L,26))} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${At(T("status-error","red"))} }
.oc-sdk-input[data-mono="true"] { font-family: ${Ot}; }

.oc-sdk-search-icon { color: ${_}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${F}; }
.oc-sdk-search-clear { border-radius: ${Ao}; color: ${_}; }
.oc-sdk-search-clear:hover { background: ${M}; color: ${L}; }

.oc-sdk-trigger { border-radius: ${Ct}; background: var(--oc-sdk-raised-bg); color: ${re}; ${kt} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${j}, ${j}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${_}; }
.oc-sdk-trigger-chevron { color: ${_}; }
/* The app's dropdown light: lit top, hairline rings and a layered shadow. Its outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${re}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${Le}; background-clip: padding-box; color: ${re}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${M}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${Tt}; color: ${xt}; }
.oc-sdk-option-check { color: ${L}; }
.oc-sdk-option[data-destructive="true"] { color: ${Rt}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${v(T("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${_}; }
.oc-sdk-popup-empty { color: ${_}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${X}; border-radius: 4px; color: ${L}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${v(L,60,X)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${X}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${B}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${F}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${ko} }
.oc-sdk-check-desc { color: ${_}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${v(L,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${_}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${L}; }
.oc-sdk-tab[aria-selected="true"] { color: ${xt}; background: ${Tt}; border-color: ${X}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${re}; background: var(--oc-sdk-raised-bg); ${kt} }
.oc-sdk-tab-count { color: ${_}; }

.oc-sdk-badge { border-radius: 9999px; background: ${M}; color: ${_}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${v("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${M}; }
.oc-sdk-row[aria-selected="true"] { background: ${Tt}; color: ${xt}; }
.oc-sdk-row-lead { font-family: ${Ot}; color: ${_}; }
.oc-sdk-row-sub { color: ${_}; }
.oc-sdk-row-meta { color: ${_}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${_}; }

.oc-sdk-empty-body { color: ${_}; }

.oc-sdk-spinner { color: ${_}; }
.oc-sdk-spinner-ring { border-color: ${X}; border-top-color: ${F}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${v("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${_}; }

.oc-sdk-separator { color: ${_}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${v(X,40)}; }

.oc-sdk-progress-label { color: ${_}; }
.oc-sdk-progress-track { border-radius: 9999px; background: ${X}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${F}); }

.oc-sdk-text a { color: ${vt}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${v(X,60)}; }
`,k=`
${ze}
${tr}
${wo}`;var Io="oc-sdk-ui-style";var G=(e)=>{let r=document.getElementById(Io);if(r instanceof HTMLStyleElement){if(r.textContent!==e)r.textContent=e;return}Ke(document);let s=document.createElement("style");s.id=Io,s.textContent=e,document.head.appendChild(s)},C=(e,r)=>{let s=document.createElement(e);if(r)s.className=r;return s},V=(e)=>{let r=C("button",e);return r.type="button",r},U=(e,r)=>{let s=r??"";if(e.textContent!==s)e.textContent=s};var or=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},q=(e,r)=>{G(k);let s=r,l=V("oc-sdk oc-sdk-btn"),d=or(),m=document.createElement("span");l.append(m),e.append(l);let f=()=>{if(l.dataset.variant=s.variant??"default",l.dataset.size=s.size??"default",l.disabled=Boolean(s.disabled)||Boolean(s.loading),l.dataset.loading=s.loading?"true":"false",l.setAttribute("aria-busy",s.loading?"true":"false"),s.loading&&d.parentNode!==l)l.prepend(d);else if(!s.loading&&d.parentNode===l)d.remove();U(m,s.label)},E=()=>{if(s.disabled||s.loading)return;s.onClick()};return l.addEventListener("click",E),f(),{update:(A)=>{s={...s,...A},f()},dispose:()=>{l.removeEventListener("click",E),l.remove()}}};var Pt=(e,r)=>{G(k);let s=r,l=C("div","oc-sdk oc-sdk-empty"),d=C("h2","oc-sdk-empty-title"),m=C("p","oc-sdk-empty-body"),f=C("div","oc-sdk-empty-action");l.append(d,m,f),e.append(l);let E=null,A=()=>{if(U(d,s.title),U(m,s.body),m.hidden=!s.body,f.hidden=!s.action,!s.action){E?.dispose(),E=null;return}let w={label:s.action.label,onClick:s.action.onClick};if(E)E.update(w);else E=q(f,{...w,variant:"outline",size:"sm"})};return A(),{update:(w)=>{s={...s,...w},A()},dispose:()=>{E?.dispose(),E=null,l.remove()}}};var ar=/^(\s*[-*+] )\[( |x|X)\] ?(.*)$/,Uo=(e)=>e.split(`
`).map((r)=>{let s=ar.exec(r);return s?{kind:"item",prefix:s[1]??"- ",done:s[2]!==" ",text:s[3]??""}:{kind:"text",text:r}}),Lo=(e)=>e.map((r)=>r.kind==="text"?r.text:`${r.prefix}[${r.done?"x":" "}] ${r.text}`).join(`
`),Be=(e)=>{let r=2166136261;for(let s=0;s<e.length;s+=1)r^=e.charCodeAt(s),r=Math.imul(r,16777619);return`${e.length}:${(r>>>0).toString(16)}`},No=(e,r)=>{let s=-1,l="- ";e.forEach((E,A)=>{if(E.kind!=="item")return;s=A,l=E.prefix});let d={kind:"item",prefix:l,done:!1,text:r};if(s>=0)return[...e.slice(0,s+1),d,...e.slice(s+1)];return[...e.at(-1)?.kind==="text"&&e.at(-1)?.text===""?e.slice(0,-1):[...e],d,{kind:"text",text:""}]};var K=bt(),z=document.querySelector("#root");if(!z)throw Error("Missing root");var Ho=document.createElement("style");Ho.textContent=`
  html, body { margin: 0; height: 100%; background: var(--oc-bg); color: var(--oc-fg); font-family: var(--oc-font); font-size: 13px; }
  #root { box-sizing: border-box; height: 100%; overflow: auto; padding: 16px 20px; }
  .note { margin: 2px 0; color: var(--oc-muted); white-space: pre-wrap; min-height: 1em; }
  .item { display: flex; align-items: center; gap: 8px; margin: 2px 0; }
  .item input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: var(--oc-primary); }
  .item input[type="text"] { flex: 1; min-width: 0; border: 1px solid transparent; border-radius: var(--oc-radius); padding: 4px 6px;
    background: transparent; color: inherit; font: inherit; }
  .item input[type="text"]:hover { border-color: var(--oc-border); }
  .item input[type="text"]:focus { outline: none; border-color: var(--oc-focus); background: var(--oc-elevated); }
  .item.done input[type="text"] { color: var(--oc-muted); text-decoration: line-through; }
  .item .remove { visibility: hidden; }
  .item:hover .remove, .item:focus-within .remove { visibility: visible; }
  .actions { margin-top: 12px; }
`;document.head.append(Ho);K.onReady((e)=>_t(e,document.documentElement));var W=[],se=!1,wt=ve(null),It=()=>Lo(W),Xe=()=>{K.reportFileChange(wt.observe(Be(It())))},Mt=()=>{if(z.replaceChildren(),!W.some((r)=>r.kind==="item")&&se){Pt(z,{title:"No items",body:"This checklist is empty."});return}if(W.forEach((r,s)=>{if(r.kind==="text"){let f=document.createElement("p");f.className="note",f.textContent=r.text,z.append(f);return}let l=document.createElement("div");l.className=r.done?"item done":"item";let d=document.createElement("input");d.type="checkbox",d.checked=r.done,d.disabled=se,d.addEventListener("change",()=>{r.done=d.checked,l.className=r.done?"item done":"item",Xe()});let m=document.createElement("input");if(m.type="text",m.value=r.text,m.readOnly=se,m.setAttribute("aria-label","Item"),m.addEventListener("input",()=>{r.text=m.value,Xe()}),l.append(d,m),!se){let f=document.createElement("span");f.className="remove",q(f,{label:"Remove",variant:"ghost",size:"xs",onClick:()=>{W=W.filter((E,A)=>A!==s),Xe(),Mt()}}),l.append(f)}z.append(l)}),se)return;let e=document.createElement("div");e.className="actions",q(e,{label:"Add item",variant:"secondary",size:"sm",onClick:()=>{W=No(W,""),Xe(),Mt();let r=z.querySelectorAll('.item input[type="text"]');r.item(r.length-1)?.focus()}}),z.append(e)};K.onFileOpen((e)=>{if(e.encoding!=="text"){K.reportFileUnsupported();return}W=Uo(e.content),se=e.readOnly,wt=ve(Be(It())),Mt()});K.onFileSnapshot(()=>{let e=It();return{content:e,version:Be(e)}});K.onFileSaved((e)=>{K.reportFileChange({dirty:wt.markSaved(e),edited:!1})});})();
