
const CFG = {"name":"TuniflexBlog","baseUrl":"https://ttunflix.blogspot.com","searchTemplate":"/feeds/posts/default?alt=json&q={q}&max-results=20","searchPost":false,"anime":false,"live":false,"sports":false};

function baseUrl() {
  return (manifest && manifest.baseUrl) ? manifest.baseUrl.replace(/\/+$/, "") : CFG.baseUrl.replace(/\/+$/, "");
}
function abs(u) {
  if (!u) return "";
  try { return new URL(u, baseUrl()).toString(); } catch (_) { return u; }
}
function dec(s) {
  if (!s) return "";
  return String(s).replace(/&amp;/gi,"&").replace(/&quot;/gi,'"').replace(/&#39;/gi,"'").replace(/&lt;/gi,"<").replace(/&gt;/gi,">");
}
function strip(s) { return dec(String(s||"").replace(/<[^>]*>/g," ")).replace(/\s+/g," ").trim(); }
function attr(tag, n) {
  const m = new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+String.raw`\s*=\s*(["'])(.*?)\1`,"i").exec(tag);
  return m ? dec(m[2]) : "";
}
async function getText(url, options={}) {
  // SkyStream Gen 2 uses its native HTTP bridge; browser/Node fetch is not
  // guaranteed to exist inside the plugin QuickJS runtime.
  if (typeof fetch === "function") {
    const r = await fetch(url, {redirect:"follow", ...options});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  }
  if (typeof http_parallel !== "function") {
    throw new Error("SkyStream HTTP helper is unavailable");
  }
  const req = {
    url,
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body
  };
  const result = await http_parallel([req]);
  const r = Array.isArray(result) ? result[0] : result;
  const status = Number(r?.status ?? r?.statusCode ?? r?.code ?? 200);
  const body = r?.body ?? r?.text ?? r?.data ?? "";
  if (status < 200 || status >= 400) throw new Error(`HTTP ${status}`);
  return typeof body === "string" ? body : JSON.stringify(body);
}
function cards(html) {
  const out=[]; const seen=new Set();
  const rx=/<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi;
  for (const m of html.matchAll(rx)) {
    const block=m[0], href=dec(m[1]);
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
    if (!/^https?:\/\//i.test(href) && !href.startsWith("/")) continue;
    const img=/<img\b[^>]*>/i.exec(block)?.[0]||"";
    const title=(attr(block,"title")||strip(block)).trim();
    if (!title || title.length<2 || title.length>180) continue;
    const poster=attr(img,"data-image")||attr(img,"data-src")||attr(img,"src");
    const url=abs(href);
    if (seen.has(url)) continue;
    if (!/(movie|series|anime|film|episode|watch|show|مسلسل|فيلم|انمي|حلقة|video|match|مسابقة|play)/i.test(url+block)) continue;
    seen.add(url);
    let type=CFG.anime ? "anime" : CFG.live ? "livestream" : "movie";
    if (/series|tvshow|مسلسل|season|episode|حلقة/i.test(url)) type=CFG.anime?"anime":"series";
    out.push(new MultimediaItem({title,url,posterUrl:abs(poster),type}));
    if (out.length>=80) break;
  }
  return out;
}
function media(html) {
  const s=new Set();
  const rx=/https?:\/\/[^\s"'<>\\]+?\.(?:m3u8|mp4|webm|mov)(?:\?[^\s"'<>\\]*)?/gi;
  for (const m of String(html||"").matchAll(rx)) s.add(m[0].replace(/&amp;/g,"&"));
  return [...s];
}
function iframes(html) {
  const out=[];
  const rx=/<iframe\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  for (const m of html.matchAll(rx)) out.push(abs(dec(m[1])));
  return [...new Set(out)];
}
function makeItems(html) { return cards(html); }

async function getHome(cb) {
  try {
    const html=await getText(baseUrl());
    const items=makeItems(html);
    cb({success:true,data:{"Latest":items}});
  } catch(e) {
    console.error(CFG.name,"getHome",e);
    cb({success:false,errorCode:"NETWORK_ERROR",message:String(e)});
  }
}
async function search(query, cb) {
  try {
    const q=encodeURIComponent(query);
    let url;
    if (CFG.searchTemplate) {
      url=CFG.searchTemplate.replaceAll("{q}",q);
      if (!/^https?:\/\//i.test(url)) url=baseUrl()+url;
    } else {
      url=baseUrl()+"/?s="+q;
    }
    let options={};
    if (CFG.searchPost) {
      options={method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Referer":baseUrl()+"/"},body:"queryString="+q};
    }
    const html=await getText(url,options);
    cb({success:true,data:makeItems(html)});
  } catch(e) {
    console.error(CFG.name,"search",e);
    cb({success:false,errorCode:"NETWORK_ERROR",message:String(e)});
  }
}
async function load(url, cb) {
  try {
    const html=await getText(url);
    const h1=strip((/<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)||[])[1]||"");
    const og=attr((/<meta\b[^>]*property=["']og:image["'][^>]*>/i.exec(html)||[])[0]||"","content");
    const title=h1||strip((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)||[])[1]||"").replace(/\s*[|–-]\s*[^|–-]+$/,"").trim();
    const poster=abs(og);
    const description=strip((/<meta\b[^>]*name=["']description["'][^>]*>/i.exec(html)||[])[0]||"");
    const eps=[]; const seen=new Set();
    const rx=/<a\b[^>]*href=["']([^"']+)["'][^>]*>[\s\S]*?<\/a>/gi;
    for (const m of html.matchAll(rx)) {
      const block=m[0], href=abs(dec(m[1]));
      if (!/(episode|ep-|episodes|watch|حلقة|الحلقة|season|موسم)/i.test(href+block)) continue;
      if (seen.has(href)) continue; seen.add(href);
      const epTitle=attr(block,"title")||strip(block);
      const nums=/(?:episode|ep|الحلقة|حلقة)[^\d]{0,5}(\d+)/i.exec(epTitle+" "+href);
      const sn=/(?:season|موسم)[^\d]{0,5}(\d+)/i.exec(epTitle+" "+href);
      eps.push(new Episode({name:epTitle||`Episode ${nums?.[1]||eps.length+1}`,url:href,season:Number(sn?.[1]||1),episode:Number(nums?.[1]||eps.length+1)}));
      if (eps.length>=200) break;
    }
    const type=CFG.live?"livestream":(CFG.anime?"anime":(eps.length?"series":"movie"));
    const item=new MultimediaItem({title:title||CFG.name,url,posterUrl:poster,type,description,episodes:eps});
    cb({success:true,data:item});
  } catch(e) {
    console.error(CFG.name,"load",e);
    cb({success:false,errorCode:"NETWORK_ERROR",message:String(e)});
  }
}
async function loadStreams(url, cb) {
  try {
    const html=await getText(url,{headers:{"Referer":url}});
    const found=new Set(media(html));
    const frames=iframes(html);
    for (const frame of frames.slice(0,8)) {
      try {
        const fh=await getText(frame,{headers:{"Referer":url}});
        for (const x of media(fh)) found.add(x);
        for (const nested of iframes(fh).slice(0,2)) {
          try {
            const nh=await getText(nested,{headers:{"Referer":frame}});
            for (const x of media(nh)) found.add(x);
          } catch(_){}
        }
      } catch(_){}
    }
    const data=[...found].map(x=>new StreamResult({url:x,quality:"Unknown",headers:{Referer:url}}));
    cb({success:true,data});
  } catch(e) {
    console.error(CFG.name,"loadStreams",e);
    cb({success:false,errorCode:"NETWORK_ERROR",message:String(e)});
  }
}
globalThis.getHome=getHome;
globalThis.search=search;
globalThis.load=load;
globalThis.loadStreams=loadStreams;
