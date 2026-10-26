(()=>{var p="openchamber.sdk",d=1;var Be=`
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
`;function Xe(e){let r=e.documentElement;if(r.hasAttribute("data-oc-scrollbar-activity"))return;r.setAttribute("data-oc-scrollbar-activity","");let s=new WeakMap;e.addEventListener("scroll",(S)=>{let g=S.target===e?r:S.target;if(!(g instanceof Element))return;if(!g.hasAttribute("data-oc-scrolling"))g.setAttribute("data-oc-scrolling","");let m=s.get(g);if(m!==void 0)clearTimeout(m);s.set(g,setTimeout(()=>{s.delete(g),g.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var ko=`(${Xe.toString()})(document);`;var $e=128,Ve=65536;var fe=128;var he=65536;var Bt=/^[a-z][a-z0-9-]{0,39}$/;var Ht=(e)=>Object(e)===e&&!Array.isArray(e),qe=(e,r)=>Object.keys(e).every((s)=>r.includes(s)),Dt=(e)=>String(e)===e&&e.length>=1&&e.length<=60,Ft=(e)=>String(e)===e&&e.length>=1&&e.length<=80,Xt=(e)=>{if(!Array.isArray(e)||e.length>4)return!1;let r=new Set;for(let s of e){if(!Ht(s)||!Bt.test(s.id)||!Dt(s.label))return!1;if(s.disabled!==void 0&&s.disabled!==!0&&s.disabled!==!1)return!1;if(r.has(s.id))return!1;if(r.add(s.id),s.kind==="button"){if(!qe(s,["kind","id","label","disabled"]))return!1;continue}if(s.kind!=="select"||!qe(s,["kind","id","label","value","options","disabled"]))return!1;if(!Ft(s.value)||!Array.isArray(s.options)||s.options.length<1||s.options.length>16)return!1;let S=new Set;for(let g of s.options){if(!Ht(g)||!qe(g,["value","label"])||!Ft(g.value)||!Dt(g.label)||S.has(g.value))return!1;S.add(g.value)}if(!S.has(s.value))return!1}return!0};var ye=20000000,be=256;var je=(e)=>("bytes"in e)?e.bytes.byteLength:e.content.length,$t=(e,r)=>{if(e.path!==r.path||e.readOnly!==r.readOnly)return!1;if(e.encoding==="text"||r.encoding==="text")return e.encoding==="text"&&r.encoding==="text"&&e.content===r.content;if(e.bytes.byteLength!==r.bytes.byteLength)return!1;for(let s=0;s<e.bytes.byteLength;s+=1)if(e.bytes[s]!==r.bytes[s])return!1;return!0};var Vt=/^[A-Za-z0-9_-]{1,80}$/;var qt=["left","right","top","bottom"];var jt=(e,r=0,s={remaining:16000})=>{if(--s.remaining<0||r>=32)return!1;if(e===null)return!0;let S=Array.isArray(e)?e:Object(e)===e?Object.values(e):[];for(let g of S)if(!jt(g,r+1,s))return!1;return!0},We=(e)=>{if(e===null||e===!0||e===!1)return!0;if(Array.isArray(e))return Object.keys(e).every((r)=>/^(0|[1-9]\d*)$/.test(r)&&Number(r)<e.length)&&e.every(We);if(Object(e)===e){let r=Object.getPrototypeOf(e);return(r===null||r===Object.prototype)&&Object.values(e).every(We)}return String(e)===e||Number.isFinite(e)},ze=(e)=>{try{if(String(e.id)!==e.id||!Vt.test(e.id)||!Number.isFinite(e.anchor.x)||Math.abs(e.anchor.x)>1e5||!Number.isFinite(e.anchor.y)||Math.abs(e.anchor.y)>1e5||!Number.isFinite(e.anchor.width)||!Number.isFinite(e.anchor.height)||e.anchor.width<=0||e.anchor.height<=0||e.anchor.width>1e5||e.anchor.height>1e5||!Number.isInteger(e.width)||e.width<160||e.width>640||!Number.isInteger(e.height)||e.height<48||e.height>480||e.side!==void 0&&!qt.includes(e.side)||e.focus!==void 0&&e.focus!==!0&&e.focus!==!1||!jt(e.data)||!We(e.data))return!1;return JSON.stringify(e.data).length<=16000}catch{return!1}};var zt=["file","directory","other","missing"],Je=(e)=>Boolean(e&&"sessionId"in e),Ye=(e)=>Boolean(e&&"sent"in e&&!("sessionId"in e));var Kt=/^[0-9a-f]{7,64}$/i,Qe=(e)=>Kt.test(e),_e=500,Te=32000,Jt=16000,Yt=128,Qt=200,Zt=2000,eo=16000,to=80,oo=200,ro=16000;var so=2000;var Ze=20000,xe=1024,ve=2000000;var Re=64000,Oe=8000,et=4000;var tt=960000;var no=999,io=1e4,ce=500,ao=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],lo=["stopped","starting","ready","failed"],Go=new Set(ao),co=(e)=>Go.has(e),uo=(e)=>e&&co(e)?e:"HOST_REJECTED",Y=(e)=>{if(e===void 0)return!1;if(e===null||e===!0||e===!1)return!0;if(String(e)===e)return!0;if(Number(e)===e)return Number.isFinite(e);if(Array.isArray(e))return e.every(Y);if(Object(e)===e)return Object.values(e).every(Y);return!1},po=(e)=>Y(e)&&JSON.stringify(e).length<=ro,Wt=(e)=>e?.trim().slice(0,oo)??"",Q=(e)=>{let r=e.id.trim().slice(0,Yt),s=e.title.trim().slice(0,Qt),S=e.url.trim().slice(0,Zt),g=e.text?.trim().slice(0,eo),m=e.author?.trim().slice(0,to),C=e.kind==="pull"?"pull":"issue",y={providerId:e.providerId.trim(),id:r,title:s||r,url:S,kind:C};if(g)y.text=g;if(m)y.author=m;if(C==="pull"){let A=Wt(e.branches?.head),w=Wt(e.branches?.base);if(A&&w)y.branches={head:A,base:w}}if(po(e.data))y.data=e.data;return y},ot=(e)=>{let r=Q(e);if(e.projectId)r.projectId=e.projectId;if(e.navigation)r.navigation=e.navigation;if(e.worktree)r.worktree=e.worktree;return r},rt=(e)=>{let r={text:e.text.trim().slice(0,Jt)};if(e.send)r.send=!0;return r},st=(e)=>{if(e===null||!Number.isFinite(e))return null;return Math.min(no,Math.max(0,Math.round(e)))},nt=(e)=>{if(!Number.isFinite(e))return 0;return Math.min(io,Math.max(0,Math.ceil(e)))};var Z=(e)=>e.length>0&&e.length<=xe&&!e.includes("\x00")&&!e.includes("\\");var Ce=(e)=>{if(!e.startsWith("/")||e.includes("\x00")||e.includes("\\")||e.includes("://"))return!1;if(e.length>so)return!1;return!e.split("/").some((s)=>s==="."||s==="..")},Po=new Set(lo),it=(e)=>Boolean(e&&"status"in e&&Po.has(String(e.status))&&!("body"in e)),Ae=(e)=>Boolean(e&&"status"in e&&"body"in e&&Number.isInteger(e.status)),at=(e)=>Boolean(e&&"content"in e&&String(e.content)===e.content),lt=(e)=>Boolean(e&&"written"in e&&e.written===!0),ct=(e)=>Boolean(e&&"entries"in e&&Array.isArray(e.entries)),Mo=new Set(zt),ut=(e)=>Boolean(e&&"kind"in e&&"size"in e&&Mo.has(String(e.kind))&&Number.isFinite(e.size)),So=(e)=>Boolean(e&&"dataUrl"in e&&(e.dataUrl===null||String(e.dataUrl)===e.dataUrl)),pt=(e)=>Boolean(e&&"text"in e&&String(e.text)===e.text&&!("status"in e)),wo=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","status-control-event","popover-closed","file-open","file-snapshot","file-saved","generate-late"]),Io=(e)=>Object(e)===e?e:null,Ke=(e)=>String(e)===e&&e.length>0,Uo=(e)=>{if(!Ke(e.id))return null;if(e.ok===!0){let r={channel:p,v:d,type:"result",id:e.id,ok:!0};if(Object(e.payload)===e.payload)r.payload=e.payload;return r}if(e.ok===!1&&Ke(e.error))return{channel:p,v:d,type:"result",id:e.id,ok:!1,error:e.error,code:uo(Ke(e.code)?e.code:void 0)};return null},dt=(e)=>{let r=Io(e);if(!r||r.channel!==p||r.v!==d)return null;if(r.type==="result")return Uo(r);if(!wo.has(String(r.type))||Object(r.payload)!==r.payload)return null;return r};var go=(e)=>("key"in e)&&("metaKey"in e)&&("ctrlKey"in e),Lo=(e)=>(e.metaKey||e.ctrlKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s";class i extends Error{code;constructor(e,r){super(r);this.name="HostRequestError",this.code=e}}var mo=()=>Promise.reject(new i("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),ke=()=>Promise.reject(new i("BAD_PATH",`File path must be 1 to ${xe} characters without NUL or backslash.`)),Ge=(e)=>{if(e===void 0)return;if(Object(e)!==e||Array.isArray(e)||e.scope!==void 0&&e.scope!=="instance"&&e.scope!=="device")throw new i("HOST_REJECTED",'Storage scope must be "instance" or "device".');return e.scope==="device"?"device":void 0},u=(e)=>(e.value+=1,`oc-${e.value}`),St=(e={})=>{let r=e.target??("window"in globalThis?window:null);if(!r)throw new i("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let s=e.acceptSource??((t)=>t===r.parent),S=e.requestTimeoutMs??Ze,g=new Set,m=new Set,C=new Set,y=new Set,A=new Set,w=new Set,X=new Set,ue=new Set,pe=new Set,W=new Set,Le=[],re=null,se=null,de=new Set,Se=new Set,ne=null,ie=null,Ne=!1,z=new Map,K=new Map,J=new Map,H=!1,c={value:0},l=null,D=null,ae=!1,le=!1,Ot=null,Ct=(t)=>{if(!t)return null;return{sessionId:t.id,phase:t.busy?"started":"completed"}},I=(t)=>{r.parent.postMessage(t,"*")},At=()=>{if(H||r.parent===r||W.size===0||l?.features?.lateGenerateResults!==!0)return;I({channel:p,v:d,type:"generate-late-listen"})},T=(t,o)=>{for(let n of t)try{n(o)}catch(a){console.error(a)}},kt=(t)=>{if(!(t instanceof MessageEvent))return;if(!s(t.source))return;let o=dt(t.data);if(!o)return;if(o.type==="workspace"){let a=K.get(o.payload.subscriptionId);if(a)T([a],o.payload.snapshot);return}if(o.type==="shells"){let a=J.get(o.payload.subscriptionId);if(a)T([a],o.payload.snapshot);return}if(o.type==="ready"){if(l=o.payload,D=Ct(o.payload.session),T(g,o.payload),T(m,o.payload.directory),T(C,o.payload.session),D)T(y,D);T(A,o.payload.connection),T(w,o.payload.settings),T(X,o.payload.item),At();return}if(o.type==="generate-late"){if(W.size===0)Le.push(o.payload);else T(W,o.payload);return}if(o.type==="directory"){if(l)l={...l,directory:o.payload.directory};T(m,o.payload.directory);return}if(o.type==="session"){if(l)l={...l,session:o.payload.session};if(!o.payload.session)D=null;else if(D?.sessionId!==o.payload.session.id)D=Ct(o.payload.session);T(C,o.payload.session);return}if(o.type==="session-lifecycle"){D=o.payload,T(y,o.payload);return}if(o.type==="connection"){if(l)l={...l,connection:o.payload.connection};T(A,o.payload.connection);return}if(o.type==="settings"){if(l)l={...l,settings:o.payload.settings};T(w,o.payload.settings);return}if(o.type==="item"){if(l)l={...l,item:o.payload.item};T(X,o.payload.item);return}if(o.type==="status-control-event"){T(ue,o.payload);return}if(o.type==="popover-closed"){T(pe,o.payload);return}if(o.type==="action"){let a=(E)=>{if(!H)I({channel:p,v:d,type:"action-result",id:o.id,payload:E})},h=se;if(!h){a({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>h(o.payload)).then(()=>a({ok:!0}),(E)=>{let O=(E instanceof Error?E.message:String(E)).trim();a({ok:!1,error:(O||"Action failed.").slice(0,ce)})});return}if(o.type==="file-open"){let a=o.payload;if(ie&&$t(ie,a))return;ie=a,T(de,o.payload);return}if(o.type==="file-saved"){T(Se,o.payload.version);return}if(o.type==="file-snapshot"){let a=(O)=>{if(!H)I({channel:p,v:d,type:"file-snapshot-result",id:o.id,payload:O})},h=(O)=>a({error:(O.trim()||"Could not read the edited file.").slice(0,ce)}),E=ne;if(!E){h("This extension does not edit files.");return}Promise.resolve().then(()=>E(o.payload.purpose)).then((O)=>{if(je(O)>ye){h(`The file is over ${ye} ${"bytes"in O?"bytes":"characters"}.`);return}if(O.version.length>be){h(`The snapshot version is over ${be} characters.`);return}a({snapshot:"bytes"in O?{bytes:O.bytes,version:O.version}:{content:O.content,version:O.version}})},(O)=>h(O instanceof Error?O.message:String(O)));return}if(o.type==="resolve"){let a=(E)=>{I({channel:p,v:d,type:"resolve-result",id:o.id,payload:E})},h=re;if(!h){a({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>h(o.payload)).then((E)=>a({item:E?Q(E):null}),(E)=>{let O=(E instanceof Error?E.message:String(E)).trim();a({error:(O||"Command failed.").slice(0,ce)})});return}let n=z.get(o.id);if(!n)return;if(clearTimeout(n.timer),z.delete(o.id),o.ok){n.resolve(o.payload);return}n.reject(new i(o.code,o.error))};r.addEventListener("message",kt),I({channel:p,v:d,type:"hello"});let P=(t,o=S)=>{if(H||r.parent===r)return Promise.reject(new i("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((n,a)=>{let h=setTimeout(()=>{z.delete(t.id),a(new i("HOST_TIMEOUT","Host did not answer in time."))},o);z.set(t.id,{resolve:n,reject:a,timer:h}),I(t)})},f=(t)=>P(t).then(()=>{return}),R={channel:p,v:d},He=(t)=>{if(!H&&r.parent!==r)I(t)},Gt=()=>He({...R,type:"file-save"}),Pt=(t)=>{if(!go(t)||!Lo(t))return;t.preventDefault(),Gt()},Mt=(t)=>{if(!go(t)||t.key!=="Escape"||l?.surface!=="popover"||!l.popover)return;t.preventDefault(),Lt(l.popover.id,"escape").catch(()=>{return})},ge=()=>{let t=l?.surface==="popover"?l.popover:void 0;if(!t)return;let o=ae||le;if(Ot===o)return;Ot=o,Nt(t.id,o).catch(()=>{return})},me=()=>{if(l?.surface!=="popover"||ae)return;ae=!0,ge()},wt=(t)=>{if(l?.surface!=="popover"||t.relatedTarget!==null||!ae)return;ae=!1,ge()},It=()=>{if(l?.surface!=="popover"||le)return;le=!0,ge()},Ut=()=>{if(l?.surface!=="popover"||!le)return;le=!1,ge()},N=(t,o=1024)=>{if(!t.trim()||t.length>o)throw new i("HOST_REJECTED",`Identity must contain 1 to ${o} characters.`)},De=async(t)=>{if(t.kind!=="projects")N(t.projectId);let o=await P({...R,type:"workspace-read",id:u(c),payload:t});if(!o||!("kind"in o)||!("state"in o)||o.kind!==t.kind)throw new i("HOST_REJECTED","Host did not return workspace data.");return o},Fe=async(t,o)=>{if(t.kind!=="projects")N(t.projectId);let n=u(c);K.set(n,o);try{await f({...R,type:"workspace-subscribe",id:u(c),payload:{subscriptionId:n,query:t}})}catch(a){if(K.delete(n),!H)I({...R,type:"workspace-unsubscribe",id:u(c),payload:{subscriptionId:n}});throw a}return()=>{if(!K.delete(n)||H)return;I({...R,type:"workspace-unsubscribe",id:u(c),payload:{subscriptionId:n}})}},Ao=async(t,o)=>{if(t.kind==="session")N(t.sessionId);if(t.kind==="project")N(t.projectId);let n=u(c);J.set(n,o);try{await f({...R,type:"shells-subscribe",id:u(c),payload:{subscriptionId:n,scope:t}})}catch(a){if(J.delete(n),!H)I({...R,type:"shells-unsubscribe",id:u(c),payload:{subscriptionId:n}});throw a}return()=>{if(!J.delete(n)||H)return;I({...R,type:"shells-unsubscribe",id:u(c),payload:{subscriptionId:n}})}},Ee=async(t)=>{if("key"in t&&(t.key.length===0||t.key.length>$e))throw new i("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(t.op==="set"&&!Y(t.value))throw new i("HOST_REJECTED","Storage values must be JSON.");if(t.op==="set"&&new TextEncoder().encode(JSON.stringify(t.value)).length>Ve)throw new i("HOST_REJECTED","Storage value exceeds 64 KiB.");if(t.scope==="device"&&l?.features?.deviceStorage!==!0)throw new i("UNSUPPORTED","This host does not support device storage.");let o=await P({...R,type:"storage",id:u(c),payload:t});if(!o||!("storage"in o)||o.op!==t.op)throw new i("HOST_REJECTED","Host did not return storage data.");return o},Lt=(t,o)=>l?.features?.popovers!==!0&&!(l?.surface==="popover"&&l.popover?.id===t)?Promise.reject(new i("UNSUPPORTED","This host does not support popovers.")):f({...R,type:"popover-close",id:u(c),payload:o?{id:t,reason:o}:{id:t}}),Nt=(t,o)=>l?.features?.popovers!==!0&&!(l?.surface==="popover"&&l.popover?.id===t)?Promise.reject(new i("UNSUPPORTED","This host does not support popovers.")):f({...R,type:"popover-anchor",id:u(c),payload:{id:t,active:o}});return r.addEventListener("keydown",Mt,!0),r.addEventListener("pointerover",me),r.addEventListener("pointermove",me),r.addEventListener("pointerout",wt),r.addEventListener("focus",It),r.addEventListener("blur",Ut),{onAction:(t)=>(se=t,()=>{if(se===t)se=null}),listProjects:async()=>{let t=await De({kind:"projects"});if(t.kind!=="projects")throw new i("HOST_REJECTED","Expected projects.");return t},listWorktrees:async(t)=>{let o=await De({kind:"worktrees",projectId:t});if(o.kind!=="worktrees")throw new i("HOST_REJECTED","Expected worktrees.");return o},listSessions:async(t)=>{let o=await De({kind:"sessions",projectId:t});if(o.kind!=="sessions")throw new i("HOST_REJECTED","Expected sessions.");return o},onProjects:(t)=>Fe({kind:"projects"},(o)=>{if(o.kind==="projects")t(o)}),onWorktrees:(t,o)=>Fe({kind:"worktrees",projectId:t},(n)=>{if(n.kind==="worktrees")o(n)}),onSessions:(t,o)=>Fe({kind:"sessions",projectId:t},(n)=>{if(n.kind==="sessions")o(n)}),onRunningShells:(t,o)=>Ao(t,o),readShellOutput:async(t,o)=>{N(t,fe);let n=o?.cursor;if(n!==void 0&&(!Number.isInteger(n)||n<0))throw new i("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let a=o?.tailBytes;if(a!==void 0&&(!Number.isInteger(a)||a<1||a>he))throw new i("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${he}.`);let E=await P({...R,type:"shell-output",id:u(c),payload:{shellId:t,cursor:n,tailBytes:a}});if(!E||typeof E.output!=="string"||!Number.isFinite(E.cursor))throw new i("HOST_REJECTED","Host did not return shell output.");return E},stopShell:async(t)=>{if(N(t,fe),(await P({...R,type:"shell-stop",id:u(c),payload:{shellId:t}}))?.stopped!==!0)throw new i("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(t)=>{N(t),await f({...R,type:"open-session",id:u(c),payload:{sessionId:t}})},storage:{get:async(t,o)=>{let n=Ge(o),a={op:"get",key:t};if(n)a.scope=n;let h=await Ee(a);return h.op==="get"&&h.found?h.value:void 0},set:async(t,o,n)=>{let a=Ge(n),h={op:"set",key:t,value:o};if(a)h.scope=a;await Ee(h)},delete:async(t,o)=>{let n=Ge(o),a={op:"delete",key:t};if(n)a.scope=n;await Ee(a)},keys:async(t)=>{let o=Ge(t),n={op:"keys"};if(o)n.scope=o;let a=await Ee(n);if(a.op!=="keys")throw new i("HOST_REJECTED","Expected storage keys.");return a.keys}},onReady:(t)=>{if(g.add(t),l)t(l);return()=>{g.delete(t)}},onDirectory:(t)=>{if(m.add(t),l)t(l.directory);return()=>{m.delete(t)}},onSession:(t)=>{if(C.add(t),l)t(l.session);return()=>{C.delete(t)}},onSessionLifecycle:(t)=>{if(y.add(t),D)t(D);return()=>{y.delete(t)}},onConnection:(t)=>{if(A.add(t),l)t(l.connection);return()=>{A.delete(t)}},onSettings:(t)=>{if(w.add(t),l)t(l.settings);return()=>{w.delete(t)}},onItem:(t)=>{if(X.add(t),l)t(l.item);return()=>{X.delete(t)}},onStatusControl:(t)=>(ue.add(t),()=>{ue.delete(t)}),onPopoverClosed:(t)=>(pe.add(t),()=>{pe.delete(t)}),setStatusControls:(t)=>{if(l?.features?.statusControls!==!0)return Promise.reject(new i("UNSUPPORTED","This host does not support status controls."));if(!Xt(t))return Promise.reject(new i("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return f({...R,type:"status-controls",id:u(c),payload:{controls:t}})},openPopover:(t)=>{if(l?.features?.popovers!==!0)return Promise.reject(new i("UNSUPPORTED","This host does not support popovers."));if(!ze(t))return Promise.reject(new i("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return f({...R,type:"popover-open",id:u(c),payload:t})},closePopover:Lt,setPopoverAnchorActive:Nt,onResolve:(t)=>(re=t,()=>{if(re===t)re=null}),toast:(t)=>{let o=t.message.trim();if(!o||o.length>_e)return Promise.reject(new i("HOST_REJECTED",`Toast message must contain 1 to ${_e} characters.`));if(t.copy&&t.copy!==!0&&(!t.copy.text.length||t.copy.text.length>Te))return Promise.reject(new i("HOST_REJECTED",`Toast copy text must contain 1 to ${Te} characters.`));return f({channel:p,v:d,type:"toast",id:u(c),payload:{...t,message:o}})},openUrl:(t)=>f({channel:p,v:d,type:"open-url",id:u(c),payload:{url:t}}),openCommit:(t)=>Qe(t)?f({channel:p,v:d,type:"open-commit",id:u(c),payload:{sha:t}}):Promise.reject(new i("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),openSurface:(t)=>f({channel:p,v:d,type:"open-surface",id:u(c),payload:{surfaceId:t}}),openProjectDialog:()=>{if(l?.features?.projectDialog!==!0)return Promise.reject(new i("UNSUPPORTED","This host cannot open the project dialog."));return f({channel:p,v:d,type:"open-project-dialog",id:u(c)})},openPage:(t,o)=>f({channel:p,v:d,type:"open-page",id:u(c),payload:o?{pageId:t,intent:o}:{pageId:t}}),previewFile:(t)=>{let o=String(t??"").trim();if(!o||o.length>1024||o.startsWith("/")||o.startsWith("~/")||/^[A-Za-z]:/.test(o)||o.includes("\x00")||o.split("/").includes(".."))return Promise.reject(new i("BAD_PATH","Preview path must be relative to the open project."));return f({channel:p,v:d,type:"preview-file",id:u(c),payload:{path:o}})},openFile:(t)=>{let o=String(t??"").trim();if(!o||o.length>1024||o.includes("\x00")||o.split("/").includes(".."))return Promise.reject(new i("BAD_PATH","File path is malformed."));return f({channel:p,v:d,type:"open-file",id:u(c),payload:{path:o}})},thumbnailFile:async(t)=>{let o=String(t??"").trim();if(!o||o.length>1024||o.includes("\x00")||o.split("/").includes(".."))throw new i("BAD_PATH","File path is malformed.");let n=await P({channel:p,v:d,type:"thumbnail-file",id:u(c),payload:{path:o}});if(!So(n))throw new i("HOST_REJECTED","Host did not return a thumbnail.");return n.dataUrl},writeClipboard:(t)=>f({channel:p,v:d,type:"clipboard-write",id:u(c),payload:{text:t}}),compose:(t)=>f({channel:p,v:d,type:"compose",id:u(c),payload:t}),attach:(t)=>f({channel:p,v:d,type:"attach",id:u(c),payload:Q(t)}),startSession:async(t)=>{if(t.projectId!==void 0)N(t.projectId);let o=t.worktree;if(o&&o!==!0)if(o.kind==="existing")N(o.directory);else{if(o.name!==void 0)N(o.name,200);if(o.baseBranch!==void 0)N(o.baseBranch,200)}let n=await P({channel:p,v:d,type:"start-session",id:u(c),payload:ot(t)},e.requestTimeoutMs??180000);if(!Je(n))throw new i("HOST_REJECTED","Host did not return a session.");return n},prompt:(t)=>P({channel:p,v:d,type:"prompt",id:u(c),payload:rt(t)}).then((o)=>{if(!Ye(o))throw new i("HOST_REJECTED","Host did not return a prompt result.");return o}),sessionLink:(t)=>f({channel:p,v:d,type:"session-link",id:u(c),payload:Q(t)}),close:()=>f({channel:p,v:d,type:"close",id:u(c)}),oauthStart:()=>f({channel:p,v:d,type:"oauth-start",id:u(c)}),oauthDisconnect:()=>f({channel:p,v:d,type:"oauth-disconnect",id:u(c)}),request:(t)=>(Ce(t.path)?P({channel:p,v:d,type:"request",id:u(c),payload:t}):mo()).then((o)=>{if(!Ae(o))throw new i("HOST_REJECTED","Host request result was empty.");return o}),serviceRequest:(t)=>(Ce(t.path)?P({channel:p,v:d,type:"service-request",id:u(c),payload:t}):mo()).then((o)=>{if(!Ae(o))throw new i("HOST_REJECTED","Host service request result was empty.");return o}),serviceStatus:()=>P({channel:p,v:d,type:"service-status",id:u(c)}).then((t)=>{if(!it(t))throw new i("HOST_REJECTED","Host did not return service status.");return t}),readFile:(t)=>(Z(t)?P({channel:p,v:d,type:"file-read",id:u(c),payload:{path:t}}):ke()).then((o)=>{if(!at(o))throw new i("HOST_REJECTED","Host did not return file content.");return o}),writeFile:(t,o)=>{if(!Z(t))return ke();if(o.length>ve)return Promise.reject(new i("FILE_TOO_LARGE",`Content is over ${ve} characters.`));return P({channel:p,v:d,type:"file-write",id:u(c),payload:{path:t,content:o}}).then((n)=>{if(!lt(n))throw new i("HOST_REJECTED","Host did not confirm the write.");return n})},listDir:(t)=>(Z(t)?P({channel:p,v:d,type:"file-list",id:u(c),payload:{path:t}}):ke()).then((o)=>{if(!ct(o))throw new i("HOST_REJECTED","Host did not return directory entries.");return o}),stat:(t)=>(Z(t)?P({channel:p,v:d,type:"file-stat",id:u(c),payload:{path:t}}):ke()).then((o)=>{if(!ut(o))throw new i("HOST_REJECTED","Host did not return file status.");return o}),generate:(t)=>{let o=t.prompt.trim(),n=t.system?.trim();if(o.length===0||o.length>Re)return Promise.reject(new i("HOST_REJECTED",`Prompt must be 1 to ${Re} characters.`));if(n!==void 0&&(n.length===0||n.length>Oe))return Promise.reject(new i("HOST_REJECTED",`System prompt must be 1 to ${Oe} characters.`));let a=t.maxOutputTokens===void 0?void 0:Math.min(et,Math.max(1,Math.floor(t.maxOutputTokens)));if(a!==void 0&&!Number.isFinite(a))return Promise.reject(new i("HOST_REJECTED","maxOutputTokens must be a number."));let h={prompt:o};if(n!==void 0)h.system=n;if(a!==void 0)h.maxOutputTokens=a;return P({channel:p,v:d,type:"generate",id:u(c),payload:h},e.requestTimeoutMs??tt).then((E)=>{if(!pt(E))throw new i("HOST_REJECTED","Host did not return generated text.");return E})},onLateGenerateResult:(t)=>{W.add(t);for(let o of Le.splice(0))T([t],o);return At(),()=>{W.delete(t)}},setBadge:(t)=>f({channel:p,v:d,type:"badge",id:u(c),payload:{count:st(t)}}),setHeight:(t)=>f({channel:p,v:d,type:"resize",id:u(c),payload:{height:nt(t)}}),onFileOpen:(t)=>{if(de.add(t),!Ne)Ne=!0,r.addEventListener("keydown",Pt,!0);if(ie)t(ie);return()=>{de.delete(t)}},onFileSnapshot:(t)=>(ne=t,()=>{if(ne===t)ne=null}),onFileSaved:(t)=>(Se.add(t),()=>{Se.delete(t)}),reportFileChange:(t)=>He({...R,type:"file-change",payload:{dirty:t.dirty,edited:t.edited}}),requestFileSave:Gt,reportFileUnsupported:()=>He({...R,type:"file-unsupported"}),dispose:()=>{for(let t of K.keys())I({...R,type:"workspace-unsubscribe",id:u(c),payload:{subscriptionId:t}});K.clear();for(let t of J.keys())I({...R,type:"shells-unsubscribe",id:u(c),payload:{subscriptionId:t}});if(J.clear(),H=!0,re=null,se=null,ne=null,de.clear(),Se.clear(),Ne)r.removeEventListener("keydown",Pt,!0);r.removeEventListener("message",kt),r.removeEventListener("keydown",Mt,!0),r.removeEventListener("pointerover",me),r.removeEventListener("pointermove",me),r.removeEventListener("pointerout",wt),r.removeEventListener("focus",It),r.removeEventListener("blur",Ut);for(let t of z.values())clearTimeout(t.timer),t.reject(new i("HOST_UNAVAILABLE","Host client was disposed."));z.clear(),g.clear(),m.clear(),C.clear(),y.clear(),A.clear(),w.clear(),X.clear(),ue.clear(),pe.clear(),W.clear(),Le.length=0}}};var Eo=["browser.open","browser.snapshot","browser.click","browser.type","browser.select","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize","browser.close"];var mr=new Set(Eo);var fo=["none","agent","user"];var fr=new Set(fo);var No=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],Ho=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],ho=(e,r)=>{r.style.colorScheme=e.mode;for(let[s,S]of No)r.style.setProperty(s,e.tokens[S]);for(let[s,S,g]of Ho){let m=e.tokens[g]??"";r.style.setProperty(s,m),r.style.setProperty(S,m)}r.style.setProperty("font-family",e.tokens.font),r.style.setProperty("font-size","0.875rem"),r.style.setProperty("line-height","1.45"),r.style.setProperty("color",e.tokens.foreground)},gt=(e,r)=>{if(ho(e.theme,r),r.dataset)r.dataset.ocSurface=e.surface,r.dataset.ocTheme=e.theme.mode};var Do={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},_=(e,r)=>`var(--${e}, var(--oc-${Do[e]}, ${r}))`,B=_("surface-background","transparent"),Me=_("surface-elevated","transparent"),ee=_("surface-elevated-foreground","inherit"),L=_("surface-foreground","inherit"),b=_("surface-muted-foreground","gray"),Fo=_("surface-muted","transparent"),V=_("interactive-border","currentColor"),M=_("interactive-hover","transparent"),j=_("interactive-active","transparent"),mt=_("interactive-selection","transparent"),Et=_("interactive-selection-foreground","inherit"),F=_("primary","currentColor"),ft=_("primary-text","inherit"),ht=_("error-text","inherit"),Bo=_("font-sans","inherit"),yt=_("font-mono","monospace"),xo=_("radius","9px"),bt=`calc(${xo} - 2px)`,yo=`calc(${xo} - 4px)`,x=(e,r,s="transparent")=>`color-mix(in srgb, ${e} ${r}%, ${s})`,bo=`background-image: linear-gradient(${M}, ${M});`,_t=(e)=>`box-shadow: inset 0 0 0 1px ${e}, var(--oc-sdk-field-lift);`,Tt="border-color: var(--oc-sdk-edge); box-shadow: var(--oc-sdk-raised-lift);",_o="box-shadow: var(--oc-sdk-lit);",To=`inset 0 1px 0 0 ${x(L,1.5)}, 0 1px 1px 0 rgb(0 0 0 / 0.28), 0 2px 3px -2px rgb(0 0 0 / 0.2)`,Xo=`
:root {
  --oc-sdk-edge: ${x(L,10)};
  --oc-sdk-field-bg: ${Me};
  --oc-sdk-raised-bg: ${B};
  --oc-sdk-field-lift: inset 0 1px 2px 0 rgb(0 0 0 / 0.04);
  --oc-sdk-raised-lift: 0 1px 2px 0 rgb(0 0 0 / 0.06);
  --oc-sdk-lit: inset 0 1px 0 0 rgb(255 255 255 / 0.45), 0 1px 2px 0 rgb(0 0 0 / 0.08);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.1);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.8), inset 0 0 0 1px rgb(0 0 0 / 0.04), 0 1px 2px -0.5px rgb(0 0 0 / 0.08), 0 4px 8px -2px rgb(0 0 0 / 0.08), 0 12px 20px -4px rgb(0 0 0 / 0.08);
}
:root[data-oc-theme="dark"] {
  --oc-sdk-edge: ${x(L,6)};
  --oc-sdk-field-bg: ${x(B,50,Me)};
  --oc-sdk-raised-bg: ${Me};
  --oc-sdk-field-lift: ${To};
  --oc-sdk-raised-lift: ${To};
  --oc-sdk-lit: inset 0 1px 0 0 ${x(L,1.5)}, 0 1px 1px 0 rgb(0 0 0 / 0.28), 0 2px 3px -2px rgb(0 0 0 / 0.2);
  --oc-sdk-float-edge: rgb(0 0 0 / 0.36);
  --oc-sdk-float: inset 0 1px 0 0 rgb(255 255 255 / 0.06), inset 0 0 0 1px rgb(255 255 255 / 0.08), 0 1px 1px -0.5px rgb(0 0 0 / 0.22), 0 3px 3px -1.5px rgb(0 0 0 / 0.2), 0 6px 6px -3px rgb(0 0 0 / 0.16);
}`,Pe=(e)=>{let r=_(`status-${e}`,"currentColor");return`
.oc-sdk[data-tone="${e}"], .oc-sdk [data-tone="${e}"] { --oc-sdk-tone: ${r}; --oc-sdk-tone-text: ${_(`${e}-text`,"inherit")}; }`},$o=`
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
`,vo=`${Xo}
.oc-sdk { color: ${L}; font-family: ${Bo}; }
.oc-sdk :focus-visible, .oc-sdk:focus-visible { outline: none; }
.oc-sdk :where(button, a[href], [role="button"], [role="tab"], [role="option"]):focus-visible, button.oc-sdk:focus-visible { ${bo} }
.oc-sdk-mono { font-family: ${yt}; }
.oc-sdk-muted { color: ${b}; }
${Pe("success")}${Pe("warning")}${Pe("error")}${Pe("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${F}; --oc-sdk-tone-text: ${ft}; }

.oc-sdk-btn { border-radius: ${bt}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${yo}; }
.oc-sdk-btn[data-variant="default"] { color: ${ft}; background: ${x(F,10,B)}; border-color: ${x(F,12)}; ${_o} }
.oc-sdk-btn[data-variant="default"]:hover { background: ${x(F,16,B)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${x(F,22,B)}; box-shadow: none; }
.oc-sdk-btn[data-variant="secondary"] { background: ${Fo}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${j}, ${j}); }
.oc-sdk-btn[data-variant="outline"] { background: var(--oc-sdk-raised-bg); color: ${ee}; ${Tt} }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${j}, ${j}); box-shadow: none; }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${M}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${j}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${_("status-error","red")}; color: ${ht}; background: ${x("var(--oc-sdk-tone)",7,B)}; border-color: ${x("var(--oc-sdk-tone)",12)}; ${_o} }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${x("var(--oc-sdk-tone)",9,B)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${x("var(--oc-sdk-tone)",11,B)}; box-shadow: none; }

.oc-sdk-field-note { color: ${b}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${ht}; }
.oc-sdk-input { border-radius: ${bt}; background: var(--oc-sdk-field-bg); color: ${ee}; ${_t("var(--oc-sdk-edge)")} transition: background 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${b}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { ${_t(x(L,26))} }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input, .oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { ${_t(_("status-error","red"))} }
.oc-sdk-input[data-mono="true"] { font-family: ${yt}; }

.oc-sdk-search-icon { color: ${b}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${F}; }
.oc-sdk-search-clear { border-radius: ${yo}; color: ${b}; }
.oc-sdk-search-clear:hover { background: ${M}; color: ${L}; }

.oc-sdk-trigger { border-radius: ${bt}; background: var(--oc-sdk-raised-bg); color: ${ee}; ${Tt} transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${M}, ${M}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${j}, ${j}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${b}; }
.oc-sdk-trigger-chevron { color: ${b}; }
/* The app's dropdown light: lit top, hairline rings and a layered shadow. Its outer ring is the border, over the page like the app's. */
.oc-sdk-popup { --surface-foreground: ${ee}; border-color: var(--oc-sdk-float-edge); border-radius: 12px; background: ${Me}; background-clip: padding-box; color: ${ee}; box-shadow: var(--oc-sdk-float); }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${M}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${mt}; color: ${Et}; }
.oc-sdk-option-check { color: ${L}; }
.oc-sdk-option[data-destructive="true"] { color: ${ht}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${x(_("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${b}; }
.oc-sdk-popup-empty { color: ${b}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${V}; border-radius: 4px; color: ${L}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${x(L,60,V)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${V}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${B}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${F}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${bo} }
.oc-sdk-check-desc { color: ${b}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${x(L,4)}; box-shadow: inset 0 1px 2px 0 rgb(0 0 0 / 0.16); }
.oc-sdk-tab { border-radius: 8px; color: ${b}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${L}; }
.oc-sdk-tab[aria-selected="true"] { color: ${Et}; background: ${mt}; border-color: ${V}; }
.oc-sdk-tabs[data-track="true"] .oc-sdk-tab[aria-selected="true"] { color: ${ee}; background: var(--oc-sdk-raised-bg); ${Tt} }
.oc-sdk-tab-count { color: ${b}; }

.oc-sdk-badge { border-radius: 9999px; background: ${M}; color: ${b}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${x("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${M}; }
.oc-sdk-row[aria-selected="true"] { background: ${mt}; color: ${Et}; }
.oc-sdk-row-lead { font-family: ${yt}; color: ${b}; }
.oc-sdk-row-sub { color: ${b}; }
.oc-sdk-row-meta { color: ${b}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${b}; }

.oc-sdk-empty-body { color: ${b}; }

.oc-sdk-spinner { color: ${b}; }
.oc-sdk-spinner-ring { border-color: ${V}; border-top-color: ${F}; border-radius: 9999px; }

/* Set apart by its tint alone, like the app's banners. */
.oc-sdk-banner { border-color: transparent; border-radius: 8px; background: ${x("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${b}; }

.oc-sdk-separator { color: ${b}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${x(V,40)}; }

.oc-sdk-progress-label { color: ${b}; }
.oc-sdk-progress-track { border-radius: 9999px; background: ${V}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${F}); }

.oc-sdk-text a { color: ${ft}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${x(V,60)}; }
`,k=`
${Be}
${$o}
${vo}`;var Ro="oc-sdk-ui-style";var G=(e)=>{let r=document.getElementById(Ro);if(r instanceof HTMLStyleElement){if(r.textContent!==e)r.textContent=e;return}Xe(document);let s=document.createElement("style");s.id=Ro,s.textContent=e,document.head.appendChild(s)},v=(e,r)=>{let s=document.createElement(e);if(r)s.className=r;return s},q=(e)=>{let r=v("button",e);return r.type="button",r},U=(e,r)=>{let s=r??"";if(e.textContent!==s)e.textContent=s},te=(e,r,s)=>{if(s===void 0||s===null||s==="")e.removeAttribute(r);else if(e.getAttribute(r)!==s)e.setAttribute(r,s)};var Vo=()=>{let e=document.createElement("span");return e.className="oc-sdk-spinner-ring",e.setAttribute("aria-hidden","true"),e},oe=(e,r)=>{G(k);let s=r,S=q("oc-sdk oc-sdk-btn"),g=Vo(),m=document.createElement("span");S.append(m),e.append(S);let C=()=>{if(S.dataset.variant=s.variant??"default",S.dataset.size=s.size??"default",S.disabled=Boolean(s.disabled)||Boolean(s.loading),S.dataset.loading=s.loading?"true":"false",S.setAttribute("aria-busy",s.loading?"true":"false"),s.loading&&g.parentNode!==S)S.prepend(g);else if(!s.loading&&g.parentNode===S)g.remove();U(m,s.label)},y=()=>{if(s.disabled||s.loading)return;s.onClick()};return S.addEventListener("click",y),C(),{update:(A)=>{s={...s,...A},C()},dispose:()=>{S.removeEventListener("click",y),S.remove()}}};var xt=(e,r)=>{G(k);let s=r,S=v("label","oc-sdk oc-sdk-field"),g=v("span","oc-sdk-field-label"),m=s.multiline?v("textarea","oc-sdk-input"):v("input","oc-sdk-input"),C=v("span","oc-sdk-field-note");S.append(g,m,C),e.append(S);let y=()=>{if(U(g,s.label),g.hidden=!s.label,m instanceof HTMLInputElement)m.type=s.password?"password":"text";else m.rows=s.rows??3;if(m.value!==s.value)m.value=s.value;m.disabled=Boolean(s.disabled),te(m,"placeholder",s.placeholder),m.dataset.mono=s.mono?"true":"false";let w=Boolean(s.error);S.dataset.invalid=w?"true":"false",m.setAttribute("aria-invalid",w?"true":"false");let X=s.error??s.helper??"";U(C,X),C.hidden=X===""},A=()=>{s.onChange(m.value)};return m.addEventListener("input",A),y(),{update:(w)=>{s={...s,...w},y()},dispose:()=>{m.removeEventListener("input",A),S.remove()}}};var Rt=St(),Co=document.querySelector("#root");if(!Co)throw Error("Missing root");var Oo=!1;Rt.onReady((e)=>{if(gt(e,document.documentElement),Oo)return;Oo=!0;let r=document.createElement("div");r.style.cssText="display:flex;align-items:center;gap:8px;height:100%;padding:0 8px;box-sizing:border-box;",Co.append(r);let s="",S=document.createElement("div");S.style.flex="1",r.append(S);let g=xt(S,{value:s,placeholder:"https://example.com",mono:!0,onChange:(y)=>{s=y,g.update({value:y})}}),m=oe(r,{label:"Go",size:"sm",onClick:()=>{if(!s.trim())return;m.update({loading:!0}),Rt.serviceRequest({method:"POST",path:"/navigate",body:JSON.stringify({url:s.trim()})}).then(()=>C()).finally(()=>m.update({loading:!1}))}}),C=async()=>{try{let y=await Rt.serviceRequest({method:"GET",path:"/state"}),A=JSON.parse(y.body);if(String(A.url)===A.url&&A.url!==s)s=A.url==="about:blank"?"":A.url,g.update({value:s})}catch{}};C(),setInterval(()=>{C()},2000)});})();
