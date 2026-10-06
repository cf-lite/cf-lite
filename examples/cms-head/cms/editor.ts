/** The mock CMS's editor UI: a static page (no secrets in it) that talks to /graphql and /admin with a Bearer token typed by the user. */
export const EDITOR_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>mock CMS editor</title>
<style>body{font:14px system-ui;margin:0;display:grid;grid-template-columns:320px 1fr;height:100vh}aside{padding:12px;border-right:1px solid #ccc;overflow:auto}
li{cursor:pointer;margin:2px 0}li.sel{font-weight:700}iframe{width:100%;height:100%;border:0}main{display:grid;grid-template-rows:auto 1fr}#bar{padding:8px;border-bottom:1px solid #ccc}
.pill{font-size:11px;padding:0 4px;border:1px solid #999;border-radius:4px;margin-left:4px}</style></head><body>
<aside><label>token <input id="tok" type="password" size="16"></label> <button id="load">load</button>
<ul id="list"></ul></aside>
<main><div id="bar"><b id="cur">(select an entry)</b> <input id="title" size="30" placeholder="title"> <button id="save">save draft</button> <button id="pub">publish</button> <span id="msg" role="status"></span></div>
<iframe id="pv" title="preview"></iframe></main>
<script>
const $=(i)=>document.getElementById(i);let cur=null;
const H=()=>({"content-type":"application/json",authorization:"Bearer "+$("tok").value});
const gql=async(query,variables)=>(await fetch("/api/cms/graphql",{method:"POST",headers:H(),body:JSON.stringify({query,variables})})).json();
const say=(m)=>{$("msg").textContent=m};
async function load(){const r=await fetch("/api/cms/admin/entries",{headers:H()});if(!r.ok)return say("unauthorized");
 $("list").replaceChildren(...(await r.json()).map((e)=>{const li=document.createElement("li");li.dataset.id=e.id;li.textContent=e.id;
  const p=document.createElement("span");p.className="pill";p.textContent=e.draft?"draft v"+e.draft:(e.published?"v"+e.published:"unpublished");li.append(p);li.onclick=()=>pick(e);return li}))}
async function pick(e){cur=e;$("cur").textContent=e.id;$("title").value=e.title;for(const l of $("list").children)l.classList.toggle("sel",l.dataset.id===e.id);
 const r=await fetch("/api/cms/admin/preview-url?id="+encodeURIComponent(e.id),{headers:H()});if(!r.ok)return say("no preview for this entry");$("pv").src=(await r.json()).url}
// the content-saved notification: tell the framed page, restricted to its own origin (cms/saved-listener.ts is the receiving side)
const notify=(id,version)=>$("pv").contentWindow&&$("pv").contentWindow.postMessage({type:"cms:content-saved",id,version},location.origin);
$("save").onclick=async()=>{if(!cur)return;const r=await gql("mutation($id:String!,$f:JSON){saveDraft(id:$id,fields:$f){id version}}",{id:cur.id,f:{title:$("title").value}});
 if(r.errors)return say(r.errors[0].message);say("saved v"+r.data.saveDraft.version);notify(cur.id,r.data.saveDraft.version);load()};
$("pub").onclick=async()=>{if(!cur)return;const r=await gql("mutation($id:String!){publish(id:$id){id version}}",{id:cur.id});say(r.errors?r.errors[0].message:"published v"+r.data.publish.version);load()};
$("load").onclick=load;
</script></body></html>`;
