/**
 * Gemini 하이브리드 자동 생성기 - Cloudflare Worker 버전
 * (원본 geminai.php 포팅)
 *
 * 필요한 env 바인딩 (wrangler.toml [vars] / secrets):
 *  - GEMINI_API_KEY
 *  - GOOGLE_CLIENT_ID
 *  - GOOGLE_CLIENT_SECRET
 *  - GOOGLE_REFRESH_TOKEN
 *  - BLOG_ID
 *  - BLOG_ID_NEWSVIEWT (optional)
 *  - BLOG_ID_ZEROWORKER (optional)
 *  - BLOG_ID_LIFE (optional)
 *  - BLOG_ID_MILITARY (optional)
 */

const WORKER_IMG_URL = "https://pexel-image.usbkr.workers.dev"; // 이미지/펙셀 검색 중계 (브라우저에서 직접 호출할 때만 사용)
const PLAY_WORKER = "https://play.scsi.kr"; // 동영상 스트리밍 도메인

// ---------------------------------------------------------------
// 공통 유틸
// ---------------------------------------------------------------

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getCookie(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return match ? decodeURIComponent(match[1]) : null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; GeminiHybridBot/1.0)",
        ...(options.headers || {}),
      },
    });
    const body = await res.text();
    return { body, code: res.status };
  } catch (e) {
    return { body: "", code: 0, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// 부작용 없는 조회성 요청(번역/위키/DDG 검색) 전용 - Workers 엣지 캐시로 반복 호출 절감
async function cachedFetch(url, options = {}, timeoutMs = 15000, cacheTtlSec = 3600) {
  const cache = caches.default;
  const cacheKey = new Request(url, { method: "GET" });

  const cached = await cache.match(cacheKey);
  if (cached) {
    return { body: await cached.text(), code: cached.status };
  }

  const result = await fetchWithTimeout(url, options, timeoutMs);
  if (result.code >= 200 && result.code < 300 && result.body) {
    const cacheResp = new Response(result.body, {
      status: 200,
      headers: { "Cache-Control": `public, max-age=${cacheTtlSec}` },
    });
    await cache.put(cacheKey, cacheResp);
  }
  return result;
}

// pexel-image 워커 서버-투-서버 호출 전용 헬퍼.
// Cloudflare는 Worker가 다른 워커의 *.workers.dev 주소로 직접 fetch하는 걸 막는다
// (error code: 1042). 브라우저에서 직접 부르는 건 문제없지만, 이 Worker 내부에서
// 이미지 업로드/동영상 정보 조회를 위해 서버 간 호출할 때는 반드시 이 헬퍼를 통해야 함.
// wrangler.toml에 아래처럼 Service Binding을 추가하면 workers.dev 제약을 아예 우회하고
// 외부망도 타지 않아 더 빠르다:
//   [[services]]
//   binding = "PEXEL_IMAGE"
//   service = "pexel-image"   # 실제 워커 이름으로 교체
// 바인딩이 없으면 직접 fetch로 폴백하는데, 대상이 workers.dev 도메인 그대로라면
// 여전히 1042로 막히므로 이 경우엔 pexel-image 워커에 커스텀 도메인(예: img.usb.kr)을
// 연결하고 WORKER_IMG_URL을 그 도메인으로 바꿔야 한다.
async function callImageWorker(env, path, options = {}, timeoutMs = 15000) {
  const url = WORKER_IMG_URL + path;

  if (env && env.PEXEL_IMAGE) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await env.PEXEL_IMAGE.fetch(url, { ...options, signal: controller.signal });
      const body = await res.text();
      return { body, code: res.status };
    } catch (e) {
      return { body: "", code: 0, error: String(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  return fetchWithTimeout(url, options, timeoutMs);
}

// ---------------------------------------------------------------
// 블로그 ID 매핑 / Blogger 인증 / 최신글 조회
// ---------------------------------------------------------------

// selectedBlog 키 -> 실제 Blogger blogId. handleUpload와 최신글 조회 양쪽에서 공용으로 사용.
function getBlogIdMap(env) {
  return {
    petpy: env.BLOG_ID,
    newsviewt: env.BLOG_ID_NEWSVIEWT || env.BLOG_ID,
    zeroworker: env.BLOG_ID_ZEROWORKER || env.BLOG_ID,
    military: env.BLOG_ID_MILITARY || env.BLOG_ID,
    life: env.BLOG_ID_LIFE || env.BLOG_ID,
  };
}

async function getBloggerAccessToken(env) {
  const tokenData = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const res = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenData.toString(),
  });
  try {
    const data = JSON.parse(res.body);
    return data.access_token || null;
  } catch (_) {
    return null;
  }
}

async function fetchLatestPosts(accessToken, blogId, maxResults = 3) {
  if (!accessToken || !blogId) return [];
  const url = `https://www.googleapis.com/blogger/v3/blogs/${blogId}/posts/?maxResults=${maxResults}&fetchBodies=false&fields=items(title,url)`;
  const res = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, 8000);
  try {
    const data = JSON.parse(res.body);
    return Array.isArray(data.items) ? data.items : [];
  } catch (_) {
    return [];
  }
}

// 블로그 4~5개 최신글 3개씩 병렬 조회 (통합 대시보드용)
async function fetchAllLatestPosts(env) {
  const accessToken = await getBloggerAccessToken(env);
  if (!accessToken) return {};

  const blogIdMap = getBlogIdMap(env);
  const entries = Object.entries(blogIdMap);
  const results = await Promise.all(
    entries.map(([, blogId]) => fetchLatestPosts(accessToken, blogId, 3))
  );

  const out = {};
  entries.forEach(([key], i) => { out[key] = results[i]; });
  return out;
}

// ---------------------------------------------------------------
// 번역 / 위키 / 밀리터리 소스 체인
// ---------------------------------------------------------------

// MyMemory 무료 할당량 소진 시 "MYMEMORY WARNING..." 문구가 정상 번역처럼 응답에 섞여 오므로
// 어디서든 번역 결과를 신뢰하기 전에 이 필터를 거친다.
function isMyMemoryQuotaWarning(text) {
  if (!text) return false;
  const upper = text.toUpperCase();
  return upper.includes("MYMEMORY WARNING") || upper.includes("YOU USED ALL AVAILABLE FREE TRANSLATIONS");
}

async function fetchSecureTranslate(text, from = "ko", to = "en") {
  text = (text || "").trim();
  if (!text) return "";

  // MyMemory 무료 할당량은 Workers 공유 IP 특성상 금방 소진되고, 소진되면 경고 문구를
  // 마치 정상 번역처럼 반환한다. 그래서 사실상 무제한인 구글 번역을 1순위로 쓰고
  // MyMemory는 보조(용어사전형 결과가 더 정확할 때 대비)로만 사용한다.
  const primaryUrl = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`;
  const resPrimary = await cachedFetch(primaryUrl, {}, 6000);
  try {
    const dataPrimary = JSON.parse(resPrimary.body);
    let primaryText = "";
    if (Array.isArray(dataPrimary?.[0])) {
      for (const sentence of dataPrimary[0]) if (sentence?.[0]) primaryText += sentence[0];
    }
    primaryText = primaryText.trim();
    if (primaryText && !isMyMemoryQuotaWarning(primaryText) && primaryText.toLowerCase() !== text.toLowerCase()) {
      return primaryText;
    }
  } catch (_) {}

  // 백업: MyMemory (할당량 소진 경고는 반드시 필터링)
  const langpair = `${from}|${to}`;
  const dictUrl = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langpair)}`;
  const res = await cachedFetch(dictUrl, {}, 6000);
  try {
    const data = JSON.parse(res.body);
    if (data?.responseData?.translatedText) {
      const result = data.responseData.translatedText.trim();
      if (result && !isMyMemoryQuotaWarning(result) && result.toLowerCase() !== text.toLowerCase()) {
        return result;
      }
    }
  } catch (_) {}

  return "";
}

// 구글 번역 비공식 엔드포인트는 한 번에 너무 긴 텍스트를 넣으면 잘리거나 실패할 수 있어
// 문단 단위로 쪼개 병렬 번역 후 합친다.
function chunkText(text, maxLen = 1800) {
  const parts = [];
  let current = "";
  for (const para of text.split(/\n{2,}/)) {
    if (current && (current + "\n\n" + para).length > maxLen) {
      parts.push(current);
      current = "";
    }
    let rest = para;
    while (rest.length > maxLen) {
      if (current) { parts.push(current); current = ""; }
      parts.push(rest.slice(0, maxLen));
      rest = rest.slice(maxLen);
    }
    current = current ? current + "\n\n" + rest : rest;
  }
  if (current) parts.push(current);
  return parts.length ? parts : [text];
}

async function translateChunked(text, from, to) {
  const chunks = chunkText(text, 1800);
  const translated = await Promise.all(chunks.map((c) => fetchSecureTranslate(c, from, to)));
  return translated.filter(Boolean).join("\n\n");
}

function cleanupWikiExtract(extractRaw) {
  let extract = extractRaw.trim();
  extract = extract.replace(/\[\d+\]/gu, "");
  extract = extract.replace(/==+\s*([^=]+)\s*==+/gu, "\n\n■ $1\n");
  extract = extract.replace(/[ \t]+/gu, " ");
  extract = extract.split(". ").join(".\n\n");
  return extract;
}

async function fetchWikiTitleSearch(text, lang = "ko") {
  // opensearch(접두어 매칭)보다 강건한 전문검색으로 "보더콜리" 같은 붙여쓰기/띄어쓰기
  // 차이가 있는 입력도 실제 문서 제목에 매칭시킨다.
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(text)}&format=json&srlimit=1`;
  const res = await cachedFetch(url, {}, 6000);
  try {
    const data = JSON.parse(res.body);
    const title = data?.query?.search?.[0]?.title;
    if (title) return title;
  } catch (_) {}
  return null;
}

async function fetchWikiExtractByTitle(title, lang = "ko") {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&exlimit=max&redirects=1&format=json&titles=${encodeURIComponent(title)}`;
  const res = await cachedFetch(url, {}, 12000);
  try {
    const data = JSON.parse(res.body);
    const pages = data?.query?.pages;
    if (pages) {
      const pageKey = Object.keys(pages)[0];
      const extractRaw = pages[pageKey]?.extract;
      if (pageKey !== "-1" && extractRaw && extractRaw.trim()) return extractRaw.trim();
    }
  } catch (_) {}
  return "";
}

async function fetchHfFaceoff(text) {
  text = (text || "").trim();
  if (!text) return "";

  const enText = (await translateChunked(text, "ko", "en")).trim();
  if (!enText) return text;

  let converted = (await translateChunked(enText, "en", "ko")).trim();
  if (!converted) return text;

  const lastDot = converted.lastIndexOf(".");
  if (lastDot !== -1) converted = converted.slice(0, lastDot + 1);
  return converted;
}

async function fetchWikiSummary(finalHangul, finalEnglish = "") {
  finalHangul = (finalHangul || "").trim();
  if (!finalHangul) return "";

  // 1) 한국어 위키 우선 시도
  const koTitle = (await fetchWikiTitleSearch(finalHangul, "ko")) || finalHangul;
  let extractRaw = await fetchWikiExtractByTitle(koTitle, "ko");

  if (extractRaw) {
    let extract = cleanupWikiExtract(extractRaw);
    if ([...extract].length > 15000) extract = [...extract].slice(0, 15000).join("");
    let cleanBlogText = await fetchHfFaceoff(extract);
    cleanBlogText = cleanBlogText.split(". ").join(".\n\n");
    return cleanBlogText;
  }

  // 2) 한국어 위키에 문서가 없거나 부실한 경우(외래어 품종/브랜드 등에 흔함) -
  //    영어 위키를 가져와 청크 번역으로 한글화. 원본 정보량이 훨씬 풍부한 경우가 많다.
  if (finalEnglish && finalEnglish !== "topic") {
    const enTitle = (await fetchWikiTitleSearch(finalEnglish, "en")) || finalEnglish;
    const enExtractRaw = await fetchWikiExtractByTitle(enTitle, "en");
    if (enExtractRaw) {
      let enExtract = cleanupWikiExtract(enExtractRaw);
      if ([...enExtract].length > 12000) enExtract = [...enExtract].slice(0, 12000).join("");
      const koTranslated = await translateChunked(enExtract, "en", "ko");
      if (koTranslated) return koTranslated.split(". ").join(".\n\n");
    }
  }

  // 3) 둘 다 실패 시 약한 백업 (문장 번역 - 실제 정보량은 적음)
  const backupQuery = finalHangul + "의 특징과 상세 정보 설명";
  const backupEnText = await fetchSecureTranslate(backupQuery, "ko", "en");
  if (backupEnText) {
    const backupKoText = await fetchSecureTranslate(backupEnText, "en", "ko");
    if (backupKoText) return backupKoText;
  }

  return "";
}

function parseDdgTopResult(html) {
  if (!html) return "";
  const mLink = html.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
  if (!mLink) return "";
  const stripTags = (s) => s.replace(/<[^>]*>/g, "");
  const decodeEntities = (s) =>
    s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const link = decodeEntities(stripTags(mLink[1]));
  const title = decodeEntities(stripTags(mLink[2])).trim();

  let snippet = "";
  const mSnip = html.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
  if (mSnip) snippet = decodeEntities(stripTags(mSnip[1])).trim();

  if (!title && !snippet) return "";
  return `${title}\n${snippet}\n(출처: ${link})`.trim();
}

async function fetchMilitaryEquipmentWaterfall(finalEnglish) {
  finalEnglish = (finalEnglish || "").trim();
  if (!finalEnglish || finalEnglish === "topic") return "";

  const equipmentSites = {
    "Military-Today": "military-today.com",
    "Army-Technology": "army-technology.com",
    "Naval-Technology": "naval-technology.com",
    "Air-Force-Technology": "air-force-technology.com",
    "MilitaryFactory": "militaryfactory.com",
    "Army-Recognition": "army-recognition.com",
    "GlobalSecurity": "globalsecurity.org",
    "FAS": "fas.org",
  };

  // 원본은 순서대로 하나씩 조회하다 첫 성공에서 멈추는 방식(최악 8x8초=64초까지 지연 가능).
  // 8개 사이트 쿼리는 서로 독립적이므로 동시에 조회한 뒤, 결과 도착 후 우선순위 순서대로
  // 첫 성공 항목을 골라 동일한 선택 로직을 유지하면서 최악 지연시간만 크게 줄인다.
  const ddgBase = "https://html.duckduckgo.com/html/?q=";
  const entries = Object.entries(equipmentSites);
  const results = await Promise.all(
    entries.map(([, domain]) => {
      const url = ddgBase + encodeURIComponent(`site:${domain} ${finalEnglish}`);
      return cachedFetch(url, {}, 6000, 1800); // DDG 결과는 30분만 캐시(신선도 유지)
    })
  );

  for (let i = 0; i < entries.length; i++) {
    const [label] = entries[i];
    const snippet = parseDdgTopResult(results[i].body || "");
    if (snippet) return `[${label}]\n${snippet}`;
  }
  return "";
}

async function resolveTopicPair(rawTopic) {
  rawTopic = (rawTopic || "").trim();
  if (!rawTopic) return "";

  const already = rawTopic.match(/^([a-zA-Z0-9\s\-_]+)\((.+)\)$/u);
  if (already) return `${already[1].trim()}(${already[2].trim()})`;

  let finalEnglish = "";
  let finalHangul = "";

  if (/^[a-zA-Z0-9\s\-_]+$/.test(rawTopic)) {
    finalEnglish = rawTopic;
    const fetchedKo = await fetchSecureTranslate(rawTopic, "en", "ko");
    finalHangul = fetchedKo.replace(/[^가-힣a-zA-Z0-9\s]/gu, "");
  } else {
    finalHangul = rawTopic;
    let fetchedEn = await fetchSecureTranslate(rawTopic, "ko", "en");
    fetchedEn = fetchedEn.replace(/[^a-zA-Z0-9\s\-_]/g, "");

    const stopWords = ["a ", "an ", "the "];
    for (const sw of stopWords) {
      if (fetchedEn.toLowerCase().startsWith(sw)) {
        fetchedEn = fetchedEn.slice(sw.length);
        break;
      }
    }
    finalEnglish = fetchedEn.trim().replace(/\s+/g, " ");
  }

  if (!finalEnglish || finalEnglish === "keyword") finalEnglish = "topic";
  if (!finalHangul) finalHangul = rawTopic;

  return `${finalEnglish}(${finalHangul})`;
}

// ---------------------------------------------------------------
// 액션 핸들러
// ---------------------------------------------------------------

async function handleGenerate(form, env) {
  const selectedBlog = (form.get("blog_id") || "petpy").trim();
  const rawTopic = (form.get("topic") || "").trim();
  let statusMsg = "";
  let resultText = "";
  let topic = "";

  if (!rawTopic) return { statusMsg, resultText, topic, selectedBlog };

  topic = await resolveTopicPair(rawTopic);
  const matches = topic.match(/^([a-zA-Z0-9\s\-_]+)\((.+)\)$/u);
  const finalHangul = matches ? matches[2].trim() : topic;
  const finalEnglish = matches ? matches[1].trim() : topic;

  const skipGeneration = form.get("skip_generation") === "1";

  if (skipGeneration) {
    // 위키 요약과 장비정보 조회는 서로 독립적이므로 동시에 실행해 대기 시간을 절반 이상 줄인다.
    const [wikiResult, equipmentInfo] = await Promise.all([
      fetchWikiSummary(finalHangul, finalEnglish),
      selectedBlog === "military" ? fetchMilitaryEquipmentWaterfall(finalEnglish) : Promise.resolve(""),
    ]);

    let dictionaryStream = wikiResult;
    if (selectedBlog === "military" && equipmentInfo) {
      dictionaryStream = (dictionaryStream + "\n\n■ 장비 상세정보\n" + equipmentInfo).trim();
    }

    if (dictionaryStream && dictionaryStream.trim().length > 5) {
      resultText = dictionaryStream + "\n\n";
    } else {
      resultText =
        `■ ${topic} 관련 정보\n\n` +
        `${finalHangul}에 대한 유용한 가이드 및 추천 콘텐츠입니다.\n` +
        `실시간 미디어 소스를 선택하신 후 상세 본문 내용을 이곳에 직접 완성해 주세요.`;
    }
    statusMsg = "<div class='success-box'>⏩ AI 호출을 패스하고, 표준 지식백과를 긁어와 허깅페이스(KoBART)로 사람처럼 세탁 변환을 무상으로 완료했습니다!</div>";
  } else {
    const geminiBaseUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;

    const blogConcepts = {
      petpy: "인간외 블로그",
      newviewt: "새로운 문물",
      zeroworker: "생산성/자동화/직장인 업무 효율 블로그",
      military: "군사/무기/밀리터리 역사 전문 블로그",
      life: "일상/생활 정보/라이프스타일 블로그",
    };
    const currentConcept = blogConcepts[selectedBlog] || "전문 블로그";

    let referenceBlock = "";
    if (selectedBlog === "military") {
      const equipmentInfo = await fetchMilitaryEquipmentWaterfall(finalEnglish);
      if (equipmentInfo) referenceBlock = `[참고 자료 - 아래 사실 정보를 근거로 본문을 작성하라]\n${equipmentInfo}\n\n`;
    }

    const prompt =
      `[블로그] ${currentConcept}\n` +
      `${referenceBlock}` +
      `[주제] ${topic}\n` +
      `${topic}을 중심으로 300자 내외의 블로그 본문을 작성하라.\n` +
      `소제목과 문단을 포함하고, '${topic}'을 그대로 사용하라.\n` +
      `인사말, AI 언급, 불필요한 서론은 금지.`;

    const resGemini = await fetchWithTimeout(
      geminiBaseUrl,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) },
      30000
    );
    try {
      const responseData = JSON.parse(resGemini.body);
      const text = responseData?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (text) {
        resultText = text;
        statusMsg = "<div class='success-box'>✨ 글 생성이 완료되었습니다. 생성된 본문을 직접 수정하거나 아래 갤러리에서 미디어를 선택해 주세요.</div>";
      } else {
        statusMsg = "<div class='error-box'>❌ Gemini 글 생성에 실패했습니다. API 키를 확인해 주세요.</div>";
      }
    } catch (_) {
      statusMsg = "<div class='error-box'>❌ Gemini 글 생성에 실패했습니다. API 키를 확인해 주세요.</div>";
    }
  }

  return { statusMsg, resultText, topic, selectedBlog };
}

async function handleProcessImages(form, env) {
  const selectedBlog = (form.get("blog_id") || "petpy").trim();
  const topic = (form.get("topic") || "").trim();
  const resultText = (form.get("generated_content") || "").trim();
  const selectedSources = (form.get("selected_image_ids") || "").trim();

  let statusMsg = "";
  let finalHtmlContent = "";

  if (!resultText) return { statusMsg, finalHtmlContent, selectedBlog, topic, resultText };

  const imageTags = {};
  let uploadSuccess = false;

  if (selectedSources) {
    const sourceArray = selectedSources.split("||").map((s) => s.trim()).filter(Boolean);
    const imageUrlsToUpload = {};
    const videoIdsByIdx = {};
    const videoEmbedTags = {};

    sourceArray.forEach((srcItem, idx) => {
      if (srcItem.startsWith("video_")) videoIdsByIdx[idx] = srcItem.replace("video_", "");
      else imageUrlsToUpload[idx] = srcItem;
    });

    if (Object.keys(videoIdsByIdx).length > 0) {
      const entries = Object.entries(videoIdsByIdx);
      const videoResponsesArr = await Promise.all(
        entries.map(([, vId]) => {
          const videoInfoApi = `https://api.pexels.com/v1/videos/videos/${vId}`;
          return callImageWorker(env, `/?url=${encodeURIComponent(videoInfoApi)}`, {
            headers: { "User-Agent": "Cloudflare-Worker" },
          }, 15000);
        })
      );
      const videoResponses = {};
      entries.forEach(([idx], i) => { videoResponses[idx] = videoResponsesArr[i]; });

      for (const [idx, vId] of Object.entries(videoIdsByIdx)) {
        let downloadMp4Url = "";
        try {
          const vData = JSON.parse(videoResponses[idx]?.body || "{}");
          if (Array.isArray(vData.video_files)) {
            for (const vf of vData.video_files) {
              if (vf.link && (vf.link.includes("mp4") || vf.link.includes("pexels"))) {
                downloadMp4Url = vf.link;
                break;
              }
            }
          }
        } catch (_) {}

        if (!downloadMp4Url && vId) {
          downloadMp4Url = `https://videos.pexels.com/video-files/${vId}/${vId}-hd_1280_720_24fps.mp4`;
        }

        const finalTargetVideoUrl = downloadMp4Url.trim();
        if (finalTargetVideoUrl && finalTargetVideoUrl !== "null") {
          const cdnVideoUrl = escapeHtml(`${PLAY_WORKER}/?url=${finalTargetVideoUrl}`);
          videoEmbedTags[idx] =
            `\n<div style='width:100%; max-width:550px; margin:25px auto; overflow:hidden; border-radius:14px; box-shadow:0 4px 15px rgba(0,0,0,0.15); background:#000;'>` +
            `<video src='${cdnVideoUrl}' controls autoplay muted loop playsinline preload='metadata' style='width:100%; display:block; max-height:500px; background:#000;'></video>` +
            `</div>`;
        } else {
          videoEmbedTags[idx] = "<div class='error-box' style='margin:15px 0;'>⚠️ 비디오 소스 주소를 획득하지 못했습니다.</div>";
        }
      }
    }

    if (Object.keys(imageUrlsToUpload).length > 0) {
      const uploadPayload = {
        imageUrls: Object.values(imageUrlsToUpload),
        branch: "run",
        removeBgForFirst: true,
        blogId: selectedBlog,
      };
      const resUpload = await callImageWorker(
        env,
        "/upload-to-github",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(uploadPayload) },
        90000
      );
      let uploadData = {};
      let parseError = null;
      try { uploadData = JSON.parse(resUpload.body); } catch (e) { parseError = e; }

      if (uploadData.success === true && uploadData.filenames?.length) {
        uploadSuccess = true;

        const cdnBase = `https://cdn.${selectedBlog}.scsi.kr/`;
        let imgFileIdx = 0;
        sourceArray.forEach((srcItem, originalIdx) => {
          if (videoEmbedTags[originalIdx] !== undefined) {
            imageTags[originalIdx] = videoEmbedTags[originalIdx];
          } else if (imageUrlsToUpload[originalIdx] !== undefined) {
            const filename = uploadData.filenames[imgFileIdx];
            if (filename) {
              const finalImgUrl = cdnBase + filename;
              if (originalIdx === 0) {
                const effects = ["fx-move", "fx-shrink", "fx-grow"];
                const randomEffect = effects[Math.floor(Math.random() * effects.length)];
                imageTags[originalIdx] =
                  `<div style='text-align:center; margin:25px 0; width:100%; height:550px; margin-left:auto; margin-right:auto; display:block; clear:both; overflow:hidden; border-radius:14px; position:relative; background:#ffffff !important;'>` +
                  `<div class='${randomEffect}' style='width:100%; height:100%; position:absolute; top:0; left:0; transform-origin:center center !important; background:#ffffff !important;'>` +
                  `<img src='${finalImgUrl}' style='width:100% !important; height:100% !important; display:block !important; object-fit:contain !important; object-position:center center !important; background:#ffffff !important;' alt='대형 메인 이미지' />` +
                  `</div></div>`;
              } else {
                imageTags[originalIdx] = `<div style='text-align:center; margin:20px 0;'><img src='${finalImgUrl}' style='width:100%; height:auto; border-radius:8px;' alt='본문 이미지' /></div>`;
              }
              imgFileIdx++;
            }
          }
        });
      } else {
        let errMsg = uploadData.error;
        if (!errMsg) {
          if (resUpload.error) {
            errMsg = `네트워크 오류: ${resUpload.error}`;
          } else if (resUpload.code === 0) {
            errMsg = "요청이 타임아웃되었거나 워커에 연결하지 못했습니다.";
          } else if (resUpload.code && resUpload.code >= 400) {
            errMsg = `HTTP ${resUpload.code} - ${(resUpload.body || "").slice(0, 200)}`;
          } else if (parseError) {
            errMsg = `응답 파싱 실패 (JSON 아님) - ${(resUpload.body || "").slice(0, 200)}`;
          } else {
            errMsg = "워커 통신 에러 발생 (원인 불명)";
          }
        }
        statusMsg = `<div class='error-box'>❌ 이미지 업로드에 실패했습니다. (원인: ${escapeHtml(errMsg)})</div>`;
      }
    } else {
      uploadSuccess = true;
      Object.assign(imageTags, videoEmbedTags);
    }
  } else {
    uploadSuccess = true;
  }

  if (uploadSuccess) {
    const orderedTags = Object.keys(imageTags)
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => imageTags[k]);

    const paragraphs = resultText.split("\n").map((p) => p.trim()).filter(Boolean);
    const finalContentArr = [
      `<style>
        .fx-move { animation: fxMoveLoop 4s ease-in-out infinite alternate !important; }
        .fx-shrink { animation: fxShrinkLoop 5s ease-in-out infinite alternate !important; }
        .fx-grow { animation: fxGrowLoop 5s ease-in-out infinite alternate !important; }
        @keyframes fxMoveLoop { 0% { transform: translateX(-8px); } 100% { transform: translateX(8px); } }
        @keyframes fxShrinkLoop { 0% { transform: scale(1); } 100% { transform: scale(0.95); } }
        @keyframes fxGrowLoop { 0% { transform: scale(1); } 100% { transform: scale(1.06); } }
      </style>`,
    ];

    if (orderedTags[0]) finalContentArr.push(orderedTags[0]);

    let imgIndex = 1;
    const pCount = paragraphs.length;
    const imgCount = orderedTags.length;
    const remainImgCount = imgCount - 1;
    const insertInterval = remainImgCount > 0 ? Math.max(1, Math.floor(pCount / (remainImgCount + 1))) : 999;

    paragraphs.forEach((p, index) => {
      let cleanP = p.replace(/[#\-*"[\]{}<>]/gu, "");
      cleanP = cleanP.trim().replace(/\s+/g, " ");
      if (cleanP) {
        finalContentArr.push(`<p style='line-height:1.7; margin-bottom:14px; color:#334155; font-size:15px;'>${escapeHtml(cleanP)}</p>`);
      }
      if (imgIndex < imgCount && (index + 1) % insertInterval === 0 && index < pCount - 1) {
        finalContentArr.push(orderedTags[imgIndex++]);
      }
    });

    while (imgIndex < imgCount) finalContentArr.push(orderedTags[imgIndex++]);

    finalHtmlContent = finalContentArr.join("\n");
    statusMsg = "<div class='success-box'>✨ 미디어 믹싱이 완료되었습니다! 본문을 확인해 주세요.</div>";
  }

  return { statusMsg, finalHtmlContent, selectedBlog, topic, resultText };
}

async function handleUpload(form, env) {
  const selectedBlog = (form.get("blog_id") || "petpy").trim();
  let topic = (form.get("topic") || "").trim();
  const finalHtmlContent = (form.get("final_html_content") || "").trim();
  let statusMsg = "";
  let labels = [];

  if (!finalHtmlContent) return { statusMsg, labels, selectedBlog, topic, finalHtmlContent: "" };

  const accessToken = await getBloggerAccessToken(env);

  if (!accessToken) {
    return { statusMsg: "<div class='error-box'>❌ 구글 인증 토큰 갱신에 실패했습니다.</div>", labels, selectedBlog, topic, finalHtmlContent };
  }

  const targetBlogId = getBlogIdMap(env)[selectedBlog] || env.BLOG_ID;
  const bloggerUrl = `https://www.googleapis.com/blogger/v3/blogs/${targetBlogId}/posts/`;

  const editedTagsStr = (form.get("custom_tags") || "").trim();
  if (editedTagsStr) {
    labels = editedTagsStr.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    labels = [selectedBlog];
    const cleanContent = finalHtmlContent.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    const pureText = cleanContent.replace(/<[^>]*>/g, "").replace(/[^가-힣a-zA-Z0-9\s]/gu, " ");
    const words = pureText.split(" ");
    const wordCounts = {};
    const stopWords = [
      "경우", "때문", "통해", "대해", "위해", "대한", "이후", "그리고", "하지만",
      "가장", "매우", "함께", "있는", "있습니다", "합니다", "따라", "animation",
      "infinite", "alternate", "position", "relative", "width", "height", "important",
    ];
    for (let word of words) {
      word = word.trim();
      const len = [...word].length;
      if (len < 2 || len > 8 || stopWords.includes(word)) continue;
      wordCounts[word] = (wordCounts[word] || 0) + 1;
    }
    const sorted = Object.entries(wordCounts).sort((a, b) => b[1] - a[1]);
    for (const [kw] of sorted) {
      if (!labels.includes(kw)) labels.push(kw);
      if (labels.length >= 9) break;
    }
    const cleanTopic = topic.replace(/[^가-힣a-zA-Z0-9]/gu, "");
    if (cleanTopic) {
      const topicTag = [...cleanTopic].slice(0, 10).join("");
      if (!labels.includes(topicTag)) labels.push(topicTag);
    }
  }

  const blogData = { kind: "blogger#post", title: topic.trim(), content: finalHtmlContent, labels };
  const resBlog = await fetchWithTimeout(bloggerUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(blogData),
  });

  if (resBlog.code === 200 || resBlog.code === 201) {
    statusMsg = "<div class='success-box'>🎉 블로그 발행 완료되었습니다! 전용 동영상 스트리밍 주소로 매핑되었습니다!</div>";
    return { statusMsg, labels, selectedBlog, topic: "", finalHtmlContent: "" };
  }

  statusMsg = `<div class='error-box'>❌ Blogspot 업로드에 실패했습니다. (코드: ${resBlog.code})</div>`;
  return { statusMsg, labels, selectedBlog, topic, finalHtmlContent };
}

// ---------------------------------------------------------------
// HTML 렌더링
// ---------------------------------------------------------------

function renderLatestPostsDashboard(latestPostsByBlog) {
  const blogLabels = [
    ["petpy", "PetPy"],
    ["newsviewt", "newsviewt"],
    ["zeroworker", "ZeroWorker"],
    ["military", "Military"],
    ["life", "Life"],
  ];

  const cards = blogLabels.map(([key, label]) => {
    const posts = latestPostsByBlog[key] || [];
    const items = posts.length
      ? posts.map((p) =>
          `<li style="margin-bottom:6px;"><a href="${escapeHtml(p.url)}" target="_blank" rel="noopener" style="color:#334155; text-decoration:none; font-size:13px; line-height:1.4;">${escapeHtml(p.title)}</a></li>`
        ).join("")
      : `<li style="color:#94a3b8; font-size:13px;">최신 글 없음</li>`;

    return `<div style="background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:12px 14px;">
        <div style="font-weight:bold; font-size:13px; margin-bottom:8px; color:#1e293b;">${escapeHtml(label)}</div>
        <ul style="list-style:none; padding:0; margin:0;">${items}</ul>
      </div>`;
  }).join("");

  return `<div style="margin-bottom:25px; padding-bottom:20px; border-bottom:2px dashed #e2e8f0;">
      <div style="font-weight:bold; margin-bottom:10px; font-size:15px;">📋 블로그별 최신 글 (3개씩)</div>
      <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:14px;">
        ${cards}
      </div>
    </div>`;
}

function renderPage({ csrfToken, statusMsg = "", resultText = "", finalHtmlContent = "", topic = "", selectedBlog = "petpy", labels = [], latestPostsByBlog = {} }) {
  const blogOptions = [
    ["petpy", "PetPy"],
    ["newsviewt", "newsviewt"],
    ["zeroworker", "ZeroWorker"],
    ["military", "Military"],
    ["life", "Life"],
  ]
    .map(([val, label]) => `<option value="${val}" ${selectedBlog === val ? "selected" : ""}>${label}</option>`)
    .join("\n");

  const showEditor = resultText && !finalHtmlContent;
  const showResult = !!finalHtmlContent;

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gemini 하이브리드 자동 생성기</title>
<style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { min-height: 100vh; display: flex; justify-content: center; align-items: center; background: #f5f7fb; font-family: 'Malgun Gothic', sans-serif; padding: 20px 20px 120px; }
    .container { width: 100%; max-width: 1200px; background: #fff; padding: 30px; border-radius: 16px; box-shadow: 0 10px 30px rgba(0,0,0,.08); margin: 20px 0; }
    h1 { text-align: center; font-size: 24px; margin-bottom: 25px; }
    .form-group { margin-bottom: 18px; }
    label { display: block; font-weight: bold; margin-bottom: 8px; }
    select, input[type=text], #mainForm button { width: 100%; max-width: 500px; height: 50px; padding: 0 15px; border: 1px solid #dcdcdc; border-radius: 10px; font-size: 16px; margin: 0 auto; display: block; }
    select:focus, input[type=text]:focus { outline: none; border-color: #4285f4; }
    #mainForm { text-align: center; }
    .edit-text-container { width: 100%; max-width: 800px; margin: 20px auto; background: #fdfdfd; border: 1px solid #cbd5e1; border-radius: 12px; padding: 15px; box-shadow: inset 0 2px 4px rgba(0,0,0,0.02); text-align: left; }
    .edit-textarea { width: 100%; height: 200px; border: none; background: transparent; font-size: 15px; line-height: 1.6; color: #334155; resize: vertical; outline: none; font-family: inherit; }
    .result-box form { position: static !important; background: transparent !important; box-shadow: none !important; padding: 0 !important; display: block !important; }
    .fixed-bottom-bar { position: fixed !important; bottom: 40% !important; left: 50% !important; transform: translateX(-50%) !important; background: transparent !important; border: none !important; padding: 0 !important; z-index: 999999 !important; display: flex !important; justify-content: center !important; align-items: center !important; gap: 15px !important; box-shadow: none !important; width: 100% !important; max-width: 660px !important; }
    .btn-upload, #btnFinishSelect, .bottom-tab-btn { height: 52px !important; border: none !important; border-radius: 26px !important; font-size: 15px !important; font-weight: 700 !important; letter-spacing: -0.4px !important; cursor: pointer !important; transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important; margin: 0 !important; display: inline-flex !important; align-items: center !important; justify-content: center !important; gap: 8px !important; }
    #btnFinishSelect { width: 100% !important; max-width: 260px !important; background: linear-gradient(135deg, #4285f4 0%, #1a56db 100%) !important; color: #ffffff !important; box-shadow: 0 10px 25px rgba(37, 99, 235, 0.35) !important; border: 1px solid rgba(255,255,255,0.1) !important; }
    #btnFinishSelect:hover { transform: translateY(-4px) !important; box-shadow: 0 14px 30px rgba(37, 99, 235, 0.5) !important; }
    .btn-upload { background: linear-gradient(135deg, #10b981 0%, #059669 100%) !important; color: #ffffff !important; position: fixed !important; bottom: 30px !important; left: 50% !important; transform: translateX(-50%) !important; box-shadow: 0 10px 25px rgba(5, 150, 105, 0.35) !important; width: 100% !important; max-width: 420px !important; border-radius: 30px !important; }
    .btn-upload:hover { transform: translate(-50%, -4px) !important; box-shadow: 0 14px 30px rgba(5, 150, 105, 0.5) !important; }
    .bottom-tab-btn { width: 100% !important; max-width: 140px !important; background: #ffffff !important; color: #334155 !important; border: 1px solid #e2e8f0 !important; box-shadow: 0 8px 20px rgba(0,0,0,0.06) !important; }
    .bottom-tab-btn:hover { background: #f8fafc !important; transform: translateY(-3px) !important; box-shadow: 0 12px 24px rgba(0,0,0,0.1) !important; }
    .bottom-tab-btn.active { background: #0f172a !important; color: #ffffff !important; border-color: #0f172a !important; box-shadow: 0 10px 22px rgba(15, 23, 42, 0.3) !important; }
    .result-box { padding-bottom: 90px !important; margin-top: 30px; padding-top: 25px; border-top: 2px dashed #e2e8f0; }
    .result-content { background: #f8fafc; padding: 20px; border-radius: 10px; border: 1px solid #e2e8f0; font-size: 15px; line-height: 1.7; color: #333; margin-bottom: 15px; }
    .success-box { margin-top: 20px; background: #f0fdf4; border: 1px solid #bbf7d0; color: #166534; padding: 15px; border-radius: 10px; font-size: 14px; text-align: center; }
    .error-box { margin-top: 20px; background: #fef2f2; border: 1px solid #fee2e2; color: #991b1b; padding: 15px; border-radius: 10px; font-size: 14px; text-align: center; }
    .gallery-container { margin-top: 15px; border-top: 2px dashed #e2e8f0; padding-top: 20px; padding-bottom: 120px !important; }
    .gallery-grid { display: grid !important; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)) !important; justify-content: center !important; justify-items: center !important; gap: 20px !important; margin: 25px auto !important; padding: 10px !important; max-width: 1000px !important; }
    .gallery-item { position: relative !important; cursor: pointer !important; border-radius: 12px !important; overflow: hidden !important; border: 3px solid transparent !important; transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1) !important; background: #fff !important; box-shadow: 0 4px 10px rgba(0,0,0,0.05) !important; width: 100% !important; max-width: 180px !important; }
    .gallery-item img { width: 100% !important; height: 140px !important; object-fit: cover !important; display: block !important; }
    .gallery-item:hover { transform: translateY(-5px) !important; box-shadow: 0 10px 22px rgba(0,0,0,0.12) !important; }
    .gallery-item.selected { border-color: #007bff !important; box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.25), 0 10px 22px rgba(0, 123, 255, 0.15) !important; }
    .badge-order { position: absolute !important; top: 8px !important; right: 8px !important; background: #007bff !important; color: #fff !important; width: 24px !important; height: 24px !important; border-radius: 50% !important; display: none !important; justify-content: center !important; align-items: center !important; font-size: 13px !important; font-weight: bold !important; z-index: 20 !important; box-shadow: 0 2px 6px rgba(0,0,0,0.3) !important; }
    .gallery-item.selected .badge-order { display: flex !important; }
    .loading-trigger { text-align: center; padding: 15px; color: #888; font-size: 14px; }
    .gallery-item.local-uploaded-item { border-color: #28a745 !important; }
    .local-webp-badge, .video-badge { position: absolute !important; bottom: 0 !important; left: 0 !important; right: 0 !important; color: #fff !important; font-size: 11px !important; padding: 7px 5px !important; text-align: center !important; font-weight: 500 !important; letter-spacing: -0.2px !important; backdrop-filter: blur(2px) !important; z-index: 15 !important; }
    .local-webp-badge { background: linear-gradient(to top, rgba(40,167,69,0.95) 0%, rgba(40,167,69,0.5) 100%) !important; }
    .video-badge { background: linear-gradient(to top, rgba(239,68,68,0.95) 0%, rgba(239,68,68,0.5) 100%) !important; }
    .local-upload-container { margin: 25px auto !important; text-align: center !important; width: 100% !important; display: flex !important; justify-content: center !important; align-items: center !important; }
    #btn-local-upload { display: inline-flex !important; align-items: center !important; gap: 8px !important; padding: 12px 26px !important; background: linear-gradient(135deg, #28a745 0%, #1e7e34 100%) !important; color: #fff !important; border: none !important; border-radius: 8px !important; cursor: pointer !important; font-size: 14px !important; font-weight: 600 !important; box-shadow: 0 4px 12px rgba(40, 167, 69, 0.2) !important; transition: all 0.25s ease !important; }
    .tag-chip { display: inline-flex; align-items: center; gap: 6px; background: #e2e8f0; color: #334155; padding: 4px 10px; border-radius: 6px; font-size: 13px; font-weight: 500; user-select: none; }
    .tag-del-btn { cursor: pointer; color: #94a3b8; font-weight: bold; font-size: 14px; }
    .tag-del-btn:hover { color: #ef4444; }
    @media(max-width:900px){ .gallery-grid { grid-template-columns: repeat(3, 1fr); } }
    @media(max-width:600px){ .container { padding: 20px; } h1 { font-size: 20px; } select, input[type=text], #mainForm button { height: 48px; font-size: 15px; } .gallery-grid { grid-template-columns: repeat(2, 1fr); } .gallery-item img { height: 110px; } .btn-upload, #btnFinishSelect, .tab-btn { font-size: 12px !important; height: 44px !important; } .fixed-bottom-bar { bottom: 15px !important; gap: 8px !important; padding: 0 10px !important; } }
</style>
</head>

<body>
<div class="container">
    ${renderLatestPostsDashboard(latestPostsByBlog)}

    <form method="post" id="mainForm">
        <input type="hidden" name="action" value="generate">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
        <div class="form-group">
            <select name="blog_id" id="blogSelect">
                ${blogOptions}
            </select>
        </div>
        <div class="form-group">
            <input type="text" name="topic" id="topicInput" placeholder="예: 강아지 산책 시간" value="${escapeHtml(topic)}" required autofocus>
        </div>

        <div style="margin-top: 15px; margin-bottom: 25px; text-align: center;">
            <label style="display: inline-flex !important; align-items: center !important; justify-content: center !important; font-size: 15px !important; color: #475569 !important; cursor: pointer !important; font-weight: bold !important; width: auto !important; max-width: none !important; height: auto !important; border: none !important; padding: 0 !important; margin: 0 auto !important;">
                <input checked type="checkbox" name="skip_generation" value="1"
                    style="width: 18px !important; height: 18px !important; margin: 0 8px 0 0 !important; cursor: pointer !important; display: inline-block !important;">
                글 생성 패스 (기존 글 직접 작성/수정)
            </label>
        </div>
        <button type="submit">생성하기</button>
    </form>

    <div class="local-upload-container">
        <button type="button" id="btn-local-upload">
            <svg width="16" height="16" fill="currentColor" viewBox="0 0 16 16">
                <path d="M10.5 8.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z"/>
                <path d="M2 4a2 2 0 0 1 2-2h7.93a2 2 0 0 1 1.41.59l1.41 1.41A2 2 0 0 1 15 5.41V12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4zm11-1H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V5.41L12.59 4H11z"/>
            </svg>
            내 PC / 핸드폰 사진 올리기 (다중 선택 가능)
        </button>
        <input type="file" id="local-file-input" multiple accept="image/*" style="display: none;">
    </div>

    ${statusMsg}

    ${showEditor ? `
        <div class="edit-text-container">
            <label style="font-size: 14px; color: #475569; display: block; margin-bottom: 8px;">✏️ 생성본 수정하기 (수정한 텍스트가 본문에 최종 결합됩니다)</label>
            <textarea id="liveTextEditor" class="edit-textarea">${escapeHtml(resultText)}</textarea>
        </div>

        <div class="gallery-container">
            <div class="gallery-grid" id="galleryGrid"></div>
            <div class="loading-trigger" id="loadMoreTrigger">🔄 소스를 더 불러오는 중...</div>
        </div>

        <div class="fixed-bottom-bar">
            <button type="button" class="bottom-tab-btn active" id="tab-photo" onclick="switchMediaMode('photo')">🖼️ 사진 검색</button>
            <button type="button" id="btnFinishSelect">선택 완료</button>
            <button type="button" class="bottom-tab-btn" id="tab-video" onclick="switchMediaMode('video')">🎬 동영상 검색</button>
        </div>

        <form method="post" id="imageProcessForm">
            <input type="hidden" name="action" value="process_images">
            <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
            <input type="hidden" name="blog_id" id="processFormBlogId" value="${escapeHtml(selectedBlog)}">
            <input type="hidden" name="topic" value="${escapeHtml(topic)}">
            <input type="hidden" name="generated_content" id="formGeneratedContent" value="">
            <input type="hidden" name="selected_image_ids" id="selectedImageIds" value="">
        </form>
    ` : ""}

    ${showResult ? `
        <div class="result-box">
            <div class="result-content">
                ${finalHtmlContent}
            </div>

            <div class="tag-editor-container" style="max-width: 500px; margin: 25px auto; text-align: left; background: #fff; padding: 20px; border-radius: 12px; border: 1px solid #e2e8f0; box-shadow: 0 4px 12px rgba(0,0,0,0.02);">
                <label style="display: block; font-weight: bold; margin-bottom: 10px; color: #333; font-size: 15px;">🏷️ 블로그스팟 태그(레이블) 편집</label>
                <div id="tagWrapper" style="display: flex; flex-wrap: wrap; gap: 8px; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 8px; background: #f8fafc; min-height: 46px; align-items: center; cursor: text;">
                    <input type="text" id="tagInput" placeholder="태그 입력 후 Enter 또는 콤마(,)" style="flex: 1; min-width: 150px; border: none !important; height: auto !important; padding: 4px 0 !important; margin: 0 !important; background: transparent !important; font-size: 14px; outline: none !important; box-shadow: none !important;">
                </div>
            </div>

            <form method="post" id="finalUploadForm">
                <input type="hidden" name="action" value="upload">
                <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
                <input type="hidden" name="blog_id" value="${escapeHtml(selectedBlog)}">
                <input type="hidden" name="topic" value="${escapeHtml(topic)}">
                <input type="hidden" name="final_html_content" value="${escapeHtml(finalHtmlContent)}">
                <input type="hidden" name="custom_tags" id="customTagsInput" value="">
                <button type="submit" class="btn-upload">블로그스팟에 최종 업로드하기</button>
            </form>
        </div>

        <script>
        document.addEventListener('DOMContentLoaded', function() {
            const initialTags = ${JSON.stringify(labels)} || [];
            const tagWrapper = document.getElementById('tagWrapper');
            const tagInput = document.getElementById('tagInput');
            const customTagsInput = document.getElementById('customTagsInput');

            if (!tagWrapper || !tagInput || !customTagsInput) return;
            tagWrapper.addEventListener('click', () => tagInput.focus());

            function renderTags() {
                tagWrapper.querySelectorAll('.tag-chip').forEach(chip => chip.remove());
                initialTags.forEach((tag, index) => {
                    const trimmedTag = tag.trim();
                    if (!trimmedTag) return;

                    const span = document.createElement('span');
                    span.className = 'tag-chip';
                    span.innerHTML = \`<span>\${trimmedTag}</span><span class="tag-del-btn" data-index="\${index}">&times;</span>\`;
                    span.querySelector('.tag-del-btn').addEventListener('click', function(e) {
                        e.stopPropagation();
                        initialTags.splice(parseInt(this.getAttribute('data-index')), 1);
                        renderTags();
                    });
                    tagWrapper.insertBefore(span, tagInput);
                });
                customTagsInput.value = initialTags.join(',');
            }

            function handleNewTag() {
                const value = tagInput.value.replace(/,/g, '').trim();
                if (value && !initialTags.includes(value)) {
                    initialTags.push(value);
                    renderTags();
                }
                tagInput.value = '';
            }

            tagInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault();
                    handleNewTag();
                } else if (e.key === 'Backspace' && tagInput.value === '' && initialTags.length > 0) {
                    initialTags.pop();
                    renderTags();
                }
            });
            tagInput.addEventListener('blur', handleNewTag);
            renderTags();
        });
        </script>
    ` : ""}
</div>

<script>
const workerUrl = ${JSON.stringify(WORKER_IMG_URL)};
const currentTopic = ${JSON.stringify(topic)};

let selectedImages = [];
let currentMode = "photo";
let photoPage = 1, videoPage = 1;
let loading = false;
let photoCacheNodes = [], videoCacheNodes = [];

function switchMediaMode(mode) {
    if (currentMode === mode || loading) return;

    const galleryGrid = document.getElementById('galleryGrid');
    if (!galleryGrid) return;
    if (currentMode === 'photo') photoCacheNodes = Array.from(galleryGrid.childNodes);
    else videoCacheNodes = Array.from(galleryGrid.childNodes);

    currentMode = mode;
    document.getElementById('tab-photo').classList.toggle('active', mode === 'photo');
    document.getElementById('tab-video').classList.toggle('active', mode === 'video');

    galleryGrid.innerHTML = "";
    const targetCache = mode === 'photo' ? photoCacheNodes : videoCacheNodes;

    if (targetCache.length > 0) {
        targetCache.forEach(node => galleryGrid.appendChild(node));
        updateBadges();
    } else {
        fetchPexelsMedia();
    }
}

if (currentTopic && document.getElementById('galleryGrid')) {
    const galleryGrid = document.getElementById('galleryGrid');
    const trigger = document.getElementById('loadMoreTrigger');

    const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) fetchPexelsMedia();
    }, { threshold: 0.1 });

    function fetchPexelsMedia() {
        if (loading) return;
        loading = true;
        trigger.innerText = "🔄 소스를 더 불러오는 중...";

        let cleanQuery = currentTopic.replace(/\\([^)]*\\)/g, '').trim();
        if (!cleanQuery) cleanQuery = currentTopic;

        let targetPexelsApi = "";
        let currentPage = currentMode === 'photo' ? photoPage : videoPage;

        if (currentMode === 'photo') {
            targetPexelsApi = \`https://api.pexels.com/v1/search?query=\${encodeURIComponent(cleanQuery)}&per_page=30&page=\${currentPage}\`;
        } else {
            targetPexelsApi = \`https://api.pexels.com/v1/videos/search?query=\${encodeURIComponent(cleanQuery)}&per_page=20&page=\${currentPage}&size=medium\`;
        }

        fetch(\`\${workerUrl}/?url=\${encodeURIComponent(targetPexelsApi)}\`)
        .then(res => {
            if (!res.ok) throw new Error('HTTP 에러 발생');
            return res.json();
        })
        .then(data => {
            const itemsList = currentMode === 'photo' ? data.photos : data.videos;

            if (itemsList && itemsList.length > 0) {
                observer.unobserve(trigger);

                itemsList.forEach(itemData => {
                    const item = document.createElement('div');
                    item.className = 'gallery-item';

                    const dataId = currentMode === 'photo' ? itemData.src.large2x : \`video_\${itemData.id}\`;
                    item.dataset.id = dataId;

                    const rawThumb = currentMode === 'photo' ? itemData.src.tiny : itemData.image;
                    item.innerHTML = \`
                        <img src="\${workerUrl}/?url=\${encodeURIComponent(rawThumb)}" alt="media source">
                        <div class="badge-order"></div>
                        \${currentMode === 'video' ? '<div class="video-badge">🎬 숏폼 동영상</div>' : ''}
                    \`;

                    item.addEventListener('click', (e) => { if (e.detail === 1) handleImageSelection(item.dataset.id); });
                    item.addEventListener('dblclick', (e) => { e.preventDefault(); makeFirstPriority(item.dataset.id); });

                    let touchTimer = null, isMove = false;
                    item.addEventListener('touchstart', () => {
                        isMove = false;
                        touchTimer = setTimeout(() => {
                            if (!isMove) {
                                makeFirstPriority(item.dataset.id);
                                if (navigator.vibrate) navigator.vibrate(50);
                            }
                        }, 600);
                    }, { passive: true });
                    item.addEventListener('touchmove', () => { isMove = true; clearTimeout(touchTimer); }, { passive: true });
                    item.addEventListener('touchend', () => clearTimeout(touchTimer), { passive: true });

                    galleryGrid.appendChild(item);
                });

                if (currentMode === 'photo') photoPage++; else videoPage++;
                loading = false;
                updateBadges();
                observer.observe(trigger);
            } else {
                trigger.innerText = "더 이상 가져올 소스가 없습니다.";
                loading = true;
            }
        })
        .catch(err => {
            console.error("로딩 실패:", err);
            trigger.innerText = "❌ 소스를 불러오는 중 오류가 발생했습니다.";
            loading = false;
            observer.observe(trigger);
        });
    }

    observer.observe(trigger);
}

function handleImageSelection(id) {
    if (selectedImages.includes(id)) {
        selectedImages = selectedImages.filter(imgId => imgId !== id);
    } else {
        selectedImages.push(id);
        if (selectedImages.length === 1 && currentMode === "photo") {
            setTimeout(() => switchMediaMode("video"), 180);
        } else if (selectedImages.length === 2 && currentMode === "video") {
            setTimeout(() => switchMediaMode("photo"), 180);
        }
    }
    updateBadges();
}

function makeFirstPriority(id) {
    selectedImages = selectedImages.filter(imgId => imgId !== id);
    selectedImages.unshift(id);
    updateBadges();
}

function updateBadges() {
    document.querySelectorAll('.gallery-item').forEach(item => {
        const idx = selectedImages.indexOf(item.dataset.id);
        const badge = item.querySelector('.badge-order');
        if (idx !== -1) {
            badge.innerText = idx + 1;
            item.classList.add('selected');
        } else {
            item.classList.remove('selected');
        }
    });
}

document.addEventListener('DOMContentLoaded', function() {
    const localBtn = document.getElementById('btn-local-upload');
    const localInput = document.getElementById('local-file-input');

    if (!localBtn || !localInput) return;
    localBtn.addEventListener('click', (e) => { e.preventDefault(); localInput.click(); });

    localInput.addEventListener('change', async (e) => {
        const files = e.target.files;
        if (!files || files.length === 0) return;

        let galleryGrid = document.getElementById('galleryGrid');
        if (!galleryGrid) {
            alert("✨ 글이 아직 생성되지 않았습니다.\\n먼저 상단의 [생성하기] 버튼을 눌러 글을 만든 후 소스를 선택해 주세요!");
            localInput.value = "";
            return;
        }

        if (currentMode !== 'photo') switchMediaMode('photo');
        let addedCount = 0;

        for (let file of files) {
            try {
                const img = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = (event) => {
                        const image = new Image();
                        image.onload = () => resolve(image);
                        image.onerror = reject;
                        image.src = event.target.result;
                    };
                    reader.onerror = reject;
                    reader.readAsDataURL(file);
                });

                const canvas = document.createElement('canvas');
                let width = img.width, height = img.height;
                if (width > 800) {
                    height = Math.round((height * 800) / width);
                    width = 800;
                }
                canvas.width = width; canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);

                const compressedBase64 = canvas.toDataURL('image/webp', 0.7);
                const item = document.createElement('div');
                item.className = 'gallery-item local-uploaded-item';
                item.dataset.id = compressedBase64;
                item.innerHTML = \`
                    <img src="\${compressedBase64}" alt="local webp img">
                    <div class="badge-order"></div>
                    <div class="local-webp-badge">📸 원래사진 (WebP)</div>
                \`;

                item.addEventListener('click', () => handleImageSelection(item.dataset.id));
                item.addEventListener('dblclick', (e) => { e.preventDefault(); makeFirstPriority(item.dataset.id); });

                if (galleryGrid.firstChild) galleryGrid.insertBefore(item, galleryGrid.firstChild);
                else galleryGrid.appendChild(item);
                addedCount++;
            } catch (err) {
                console.error("로컬 전처리 오류:", err);
            }
        }

        if (addedCount > 0) {
            updateBadges();
            alert(\`\${addedCount}장의 사진이 초경량 WebP 파일로 사전 압축되어 등록되었습니다.\`);
        }
        localInput.value = "";
    });

    const btnFinish = document.getElementById('btnFinishSelect');
    if (btnFinish) {
        btnFinish.addEventListener('click', function() {
            if (selectedImages.length === 0) {
                alert('글에 삽입할 이미지나 동영상을 최소 1개 이상 선택해 주세요.');
                return;
            }

            const realSelect = document.getElementById('blogSelect');
            if (realSelect) {
                document.getElementById('processFormBlogId').value = realSelect.value;
            }

            const textEditor = document.getElementById('liveTextEditor');
            if (textEditor) {
                document.getElementById('formGeneratedContent').value = textEditor.value;
            }

            document.getElementById('selectedImageIds').value = selectedImages.join('||');
            document.getElementById('imageProcessForm').submit();
        });
    }
});
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------
// 메인 fetch 핸들러
// ---------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const setCookieHeaders = [];
    let csrfToken = getCookie(request, "csrf_token");
    if (!csrfToken) {
      csrfToken = randomToken();
      setCookieHeaders.push(`csrf_token=${csrfToken}; Path=/; HttpOnly; SameSite=Lax`);
    }

    let state = { csrfToken };

    if (request.method === "POST") {
      const form = await request.formData();
      const postedCsrf = form.get("csrf_token") || "";

      if (!csrfToken || postedCsrf !== csrfToken) {
        return new Response("요청이 만료되었거나 유효하지 않습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.", { status: 403 });
      }

      const action = form.get("action") || "";

      if (action === "generate") {
        const r = await handleGenerate(form, env);
        state = { ...state, ...r };
      } else if (action === "process_images") {
        const r = await handleProcessImages(form, env);
        state = { ...state, ...r };
      } else if (action === "upload") {
        const r = await handleUpload(form, env);
        state = { ...state, ...r };
      }

      // POST 이후에도 대시보드가 계속 보이도록 최신글 재조회
      state.latestPostsByBlog = await fetchAllLatestPosts(env);
    } else {
      state.latestPostsByBlog = await fetchAllLatestPosts(env);
    }

    const html = renderPage(state);
    const headers = new Headers({ "Content-Type": "text/html; charset=UTF-8" });
    for (const c of setCookieHeaders) headers.append("Set-Cookie", c);

    return new Response(html, { headers });
  },
};
