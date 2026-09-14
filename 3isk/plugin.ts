/*
 * SkyStream Gen 2 port of the supplied CloudStream "قصة عشق" provider.
 *
 * Source basis:
 *   - main URL: https://3esk.onl
 *   - home/search/load/loadLinks logic from the supplied Kotlin source
 *
 * The provider intentionally keeps the original site's request flow:
 * episode -> watch form -> POST 1 -> myUrl/news -> POST 2 -> iframe
 * -> embed servers -> direct HLS/MP4 extraction.
 *
 * SkyStream exposes getHome/search/load/loadStreams as the plugin entry points.
 */

const SITE = () => manifest.baseUrl || "https://3esk.onl";

function absUrl(value) {
  if (!value) return "";
  try {
    return new URL(value, SITE()).toString();
  } catch (_) {
    return value;
  }
}

function htmlDecode(s) {
  return String(s || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(s) {
  return htmlDecode(String(s || "").replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attr(tag, name) {
  const rx = new RegExp(
    name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
      String.raw`\s*=\s*(["'])(.*?)\1`,
    "i"
  );
  return rx.exec(tag)?.[2] || "";
}

function decodeBase64Compat(encoded) {
  if (!encoded) return null;
  let s = String(encoded).trim();
  while (s.length % 4) s += "=";

  // SkyStream runs JavaScript, so atob is the portable first choice.
  try {
    const bin = atob(s);
    let out = "";
    for (let i = 0; i < bin.length; i++) out += String.fromCharCode(bin.charCodeAt(i));
    try { return decodeURIComponent(escape(out)); } catch (_) { return out; }
  } catch (_) {}

  // URL-safe variant.
  try {
    const safe = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(safe);
    let out = "";
    for (let i = 0; i < bin.length; i++) out += String.fromCharCode(bin.charCodeAt(i));
    try { return decodeURIComponent(escape(out)); } catch (_) { return out; }
  } catch (_) {}

  return null;
}

async function requestText(url, options = {}) {
  if (typeof fetch === "function") {
    const r = await fetch(url, { redirect: "follow", ...options });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    return await r.text();
  }
  if (typeof http_parallel !== "function") {
    throw new Error("SkyStream HTTP helper is unavailable");
  }
  const result = await http_parallel([{
    url,
    method: options.method || "GET",
    headers: options.headers || {},
    body: options.body
  }]);
  const r = Array.isArray(result) ? result[0] : result;
  const status = Number(r?.status ?? r?.statusCode ?? r?.code ?? 200);
  const body = r?.body ?? r?.text ?? r?.data ?? "";
  if (status < 200 || status >= 400) throw new Error(`HTTP ${status} for ${url}`);
  return typeof body === "string" ? body : JSON.stringify(body);
}

function findCards(html) {
  const out = [];
  const cardRx = /<(?:a)\b[^>]*(?:class=["'][^"']*type_item(?:_wide)?[^"']*["'])[^>]*>[\s\S]*?<\/a>/gi;

  for (const m of html.matchAll(cardRx)) {
    const tagAndBody = m[0];
    const href = attr(tagAndBody, "href");
    const encoded = attr(tagAndBody, "data-clse");
    const title = attr(tagAndBody, "title") || stripTags(tagAndBody).trim();
    const imgMatch = /<img\b[^>]*>/i.exec(tagAndBody);
    const poster = imgMatch
      ? (attr(imgMatch[0], "data-image") || attr(imgMatch[0], "src"))
      : "";

    let url = encoded ? decodeBase64Compat(encoded) : href;
    if (!url) url = href;
    url = absUrl(url);
    if (!url || !title) continue;

    let type;
    if (url.includes("/tvshows/")) type = "series";
    else if (url.includes("/movies/")) type = "movie";
    else if (url.includes("/episodes/")) type = "series";
    else continue;

    out.push(new MultimediaItem({
      title,
      url,
      posterUrl: absUrl(poster),
      type
    }));
  }

  // Some pages use the wider card selector separately. De-duplicate.
  const seen = new Set();
  return out.filter(x => {
    if (seen.has(x.url)) return false;
    seen.add(x.url);
    return true;
  });
}

async function getHome(cb) {
  try {
    const html = await requestText(SITE());
    const data = {};
    const sectionRx = /<section\b[^>]*class=["'][^"']*home-items-sec[^"']*["'][^>]*>([\s\S]*?)<\/section>/gi;

    for (const m of html.matchAll(sectionRx)) {
      const section = m[1];
      const title = stripTags(
        section.match(/<[^>]*class=["'][^"']*sec-title[^"']*["'][^>]*>([\s\S]*?)<\/[^>]+>/i)?.[1] || ""
      );
      const items = findCards(section);
      if (title && items.length) data[title] = items;
    }

    cb({ success: true, data });
  } catch (e) {
    console.error("3isk getHome:", e);
    cb({ success: false, errorCode: "NETWORK_ERROR", message: String(e) });
  }
}

async function search(query, cb) {
  try {
    const url = `${SITE()}/search/${encodeURIComponent(query)}/`;
    const html = await requestText(url);
    cb({ success: true, data: findCards(html) });
  } catch (e) {
    console.error("3isk search:", e);
    cb({ success: false, errorCode: "NETWORK_ERROR", message: String(e) });
  }
}

function firstMatch(html, regex) {
  const m = regex.exec(html);
  return m ? m[1] : "";
}

async function load(url, cb) {
  try {
    let target = url;

    // Original provider redirects episode pages back to their series page.
    if (target.includes("/episodes/")) {
      const episodeHtml = await requestText(target);
      const seriesUrl = firstMatch(
        episodeHtml,
        /<a\b[^>]*class=["'][^"']*single-serie-btn[^"']*["'][^>]*href=["']([^"']+)["']/i
      );
      if (!seriesUrl) {
        return cb({ success: false, errorCode: "NOT_FOUND", message: "Series URL not found" });
      }
      target = absUrl(htmlDecode(seriesUrl));
    }

    const html = await requestText(target);
    let title = stripTags(firstMatch(
      html,
      /<div\b[^>]*class=["'][^"']*single_info[^"']*["'][\s\S]*?<h1\b[^>]*class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i
    ));

    if (!title) title = stripTags(firstMatch(html, /<h1\b[^>]*class=["'][^"']*title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i));
    title = title.replace(/مترجم|مدبلج/gi, "").trim();

    if (!title) {
      return cb({ success: false, errorCode: "NOT_FOUND", message: "Title not found" });
    }

    const poster = absUrl(firstMatch(
      html,
      /<div\b[^>]*class=["'][^"']*poster-wrapper[^"']*["'][\s\S]*?<img\b[^>]*(?:src|data-image)=["']([^"']+)["']/i
    ));

    const description = stripTags(firstMatch(
      html,
      /<div\b[^>]*class=["'][^"']*description[^"']*["'][\s\S]*?<span\b[^>]*data-nosnippet[^>]*>([\s\S]*?)<\/span>/i
    ));

    const isMovie = target.includes("/movies/");
    if (isMovie) {
      cb({
        success: true,
        data: new MultimediaItem({
          title,
          url: target,
          posterUrl: poster,
          type: "movie",
          description
        })
      });
      return;
    }

    const episodes = [];
    const seasonRx = /<div\b[^>]*class=["'][^"']*season-eps[^"']*["'][^>]*id=["']season-num-([^"']+)["'][^>]*>([\s\S]*?)<\/div>/gi;

    for (const sm of html.matchAll(seasonRx)) {
      const season = Number.parseInt(sm[1], 10) || 1;
      const block = sm[2];

      const epRx = /<a\b[^>]*class=["'][^"']*ep-num[^"']*["'][^>]*>[\s\S]*?<\/a>/gi;
      for (const em of block.matchAll(epRx)) {
        const tag = em[0];
        const raw = attr(tag, "data-clse") || attr(tag, "href");
        if (!raw) continue;

        let epUrl = raw.startsWith("http") ? raw : decodeBase64Compat(raw) || attr(tag, "href");
        epUrl = absUrl(htmlDecode(epUrl));

        const epNumber = Number.parseInt(attr(tag, "data-ep-num"), 10);
        const epName = attr(tag, "title") || `الحلقة ${Number.isFinite(epNumber) ? epNumber : ""}`;

        episodes.push(new Episode({
          name: epName,
          url: epUrl,
          season,
          episode: Number.isFinite(epNumber) ? epNumber : 0
        }));
      }
    }

    episodes.sort((a, b) =>
      (a.season - b.season) || (a.episode - b.episode)
    );

    cb({
      success: true,
      data: new MultimediaItem({
        title,
        url: target,
        posterUrl: poster,
        type: "series",
        description,
        episodes
      })
    });
  } catch (e) {
    console.error("3isk load:", e);
    cb({ success: false, errorCode: "NETWORK_ERROR", message: String(e) });
  }
}

function extractMedia(text) {
  const results = [];
  const rx = /https?:\/\/[^\s"'\\<>]+?\.(?:m3u8|mp4|webm|mov)(?:\?[^\s"'\\<>]*)?/gi;
  for (const m of text.matchAll(rx)) results.push(m[0]);
  return [...new Set(results)];
}

function extractIframes(html) {
  const out = [];
  const rx = /<iframe\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  for (const m of html.matchAll(rx)) out.push(absUrl(htmlDecode(m[1])));
  return [...new Set(out)];
}

function unpackPackerFallback(text) {
  // The supplied CloudStream implementation uses a P.A.C.K.E.R. decoder.
  // SkyStream exposes getAndUnpack natively, so prefer it when available.
  try {
    if (typeof getAndUnpack === "function") {
      return getAndUnpack(text) || "";
    }
  } catch (_) {}
  return "";
}

function mediaFromHtml(html) {
  const found = new Set(extractMedia(html));

  // Look for packed eval scripts. Native getAndUnpack handles the common
  // P.A.C.K.E.R. format used by the original provider.
  const scriptRx = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(scriptRx)) {
    const script = m[1];
    if (!/eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k/i.test(script)) continue;
    const unpacked = unpackPackerFallback(script);
    for (const u of extractMedia(unpacked)) found.add(u);
  }

  return [...found];
}

async function processEmbed(embedUrl, referer) {
  const headers = { Referer: referer };
  let html;
  try {
    html = await requestText(embedUrl, { headers });
  } catch (_) {
    return [];
  }

  const found = new Set(mediaFromHtml(html));
  const nested = extractIframes(html);

  for (const iframe of nested.slice(0, 1)) {
    try {
      const nestedHtml = await requestText(iframe, {
        headers: { Referer: embedUrl }
      });
      for (const u of mediaFromHtml(nestedHtml)) found.add(u);
    } catch (_) {}
  }

  return [...found];
}

async function loadStreams(data, cb) {
  try {
    // Step 1: initial episode page
    const html0 = await requestText(data);

    // The original provider finds the watch form using button.single-watch-btn
    // and falls back to a form whose action contains 3isk/aa.3isk/watch.
    let formHtml = firstMatch(
      html0,
      /(<form\b[^>]*>[\s\S]*?button\b[^>]*class=["'][^"']*single-watch-btn[^"']*["'][\s\S]*?<\/form>)/i
    );

    if (!formHtml) {
      const forms = [...html0.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].map(x => x[0]);
      formHtml = forms.find(f => /(?:3isk|aa\.3isk|watch)/i.test(attr(f, "action") || f)) || "";
    }

    if (!formHtml) {
      return cb({ success: true, data: [] });
    }

    const firstPostUrl = absUrl(attr(formHtml, "action"));
    const formData = new URLSearchParams();

    const inputRx = /<input\b[^>]*type=["']hidden["'][^>]*>/gi;
    for (const m of formHtml.matchAll(inputRx)) {
      const tag = m[0];
      const name = attr(tag, "name");
      if (name) formData.set(name, attr(tag, "value"));
    }

    const watchButton = firstMatch(
      html0,
      /<button\b[^>]*class=["'][^"']*single-watch-btn[^"']*["'][^>]*>[\s\S]*?<\/button>/i
    );
    if (watchButton) {
      const btnName = attr(watchButton, "name");
      if (btnName) formData.set(btnName, attr(watchButton, "value"));
    }

    const r1 = await requestText(firstPostUrl, {
      method: "POST",
      headers: {
        "Referer": data,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: formData.toString()
    });

    const nextPost = firstMatch(r1, /var\s+myUrl\s*=\s*["']([^"']+)["']/i);
    const newsVal = firstMatch(r1, /myInput\.value\s*=\s*["']([^"']+)["']/i);
    if (!nextPost || !newsVal) return cb({ success: true, data: [] });

    const post2Data = new URLSearchParams();
    post2Data.set("news", newsVal);
    post2Data.set("u", "");
    post2Data.set("submit", "submit");

    const r2 = await requestText(absUrl(nextPost), {
      method: "POST",
      headers: {
        "Referer": firstPostUrl,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: post2Data.toString()
    });

    const iframeSrcs = extractIframes(r2);
    if (!iframeSrcs.length) return cb({ success: true, data: [] });

    const baseIframe = iframeSrcs[0];
    const m = /^(https:\/\/3esk\.onl\/embed\/)(\d+)\/(.*)$/i.exec(baseIframe);

    const media = new Set();

    if (m) {
      // Preserve the original provider's server probing (1..5).
      for (let server = 1; server <= 5; server++) {
        const embed = `${m[1]}${server}/${m[3]}`;
        const links = await processEmbed(embed, r2.url || data);
        for (const link of links) media.add(link);
      }
    } else {
      for (const link of await processEmbed(baseIframe, r2.url || data)) media.add(link);
    }

    const streams = [...media].map(url => new StreamResult({
      url,
      quality: "Unknown",
      headers: { Referer: r2.url || data }
    }));

    cb({ success: true, data: streams });
  } catch (e) {
    console.error("3isk loadStreams:", e);
    cb({ success: false, errorCode: "NETWORK_ERROR", message: String(e) });
  }
}

globalThis.getHome = getHome;
globalThis.search = search;
globalThis.load = load;
globalThis.loadStreams = loadStreams;
