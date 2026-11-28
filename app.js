const COVER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHAPTER_INDEX_TTL_MS = 60 * 60 * 1000;
const INDEX_PAGE_SIZE = 100;
const INDEX_MAX_PAGES = 40;
const MAX_SAVED_SCROLL_POSITIONS = 50;
const SCROLL_SAVE_DELAY_MS = 400;
const CHAPTER_CACHE_LIMIT = 6;
const AUTO_ADVANCE_DELAY_MS = 1500;
const ARROW_SCROLL_AMOUNT = 250;
const SPEED_STEPS = [0.25, 0.33, 0.5, 0.75, 1, 1.5, 2, 2.5, 3, 4, 5, 7, 10];

// Keys included in account sync (caches like bounds_* are deliberately excluded).
const PROGRESS_KEY_PATTERN = /^(lastRead|recentChapters|scrollPositions)_[\w-]+$/;
const PREFERENCE_KEYS = ["readerFontSize", "autoScrollSpeed", "autoScrollEnabled", "autoAdvanceEnabled"];
const PROGRESS_UPDATED_AT_KEY = "progressUpdatedAt";

const ALLOWED_INLINE_TAGS = new Set(["B", "STRONG", "I", "EM", "U", "S", "SUB", "SUP", "SPAN", "SMALL", "MARK", "BR", "IMG"]);
const DROPPED_TAGS = new Set(["A", "SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "VIDEO", "AUDIO", "FORM", "INPUT", "BUTTON"]);
const CUT_PATTERNS = [
    /\[?\s*T[\/.]L\s*:/i,
    /ko-fi/i,
    /buy\s*me\s*a\s*coffee|buymeacoffee/i,
    /patreon/i,
    /discord\.gg|join (?:our|my|the) discord/i,
    /novelupdates/i,
    /translated by\s*:/i,
    /previous\s+chapter/i,
    /next\s+chapter/i,
    /choose the platform that works best/i,
    /[\w.+-]+@[\w-]+\.[a-z]{2,}/i,
    /≧▽≦/,
    /^\d{1,4}\s*\/\s*\d{1,4}$/
];
// A translator's note near the end usually starts a block of thanks/promotions; everything from it is dropped.
const TRAILER_MARKERS = [
    /^(?:T\/?L|T\/?N)(?:['’]s)?\s*(?:notes?)?\s*(?::|$)/i,
    /^translator['’]?s?\s+notes?\b/i,
    /^here are this week/i,
    /^thanks for reading\b/i,
    /^(?:hey|hi|hello)\s+(?:everyone|guys|all)\b/i
];
const TRAILER_ZONE = 0.8;

let NOVELS = [];
let activeNovel = null;
let currentChapter = 1;
let minChapter = 1;
let maxChapter = 5000;
let detectedMaxChapter = null;
// Sorted chapter numbers that actually exist on the source (from the chapter index), or null if unknown.
let chapterList = null;
let sortDescending = true;
let readerFontSize = Number(localStorage.getItem("readerFontSize")) || 20;
let isRestoringScroll = false;
let isAutoScrolling = false;
let autoScrollEnabled = localStorage.getItem("autoScrollEnabled") === "true";
let autoAdvanceEnabled = localStorage.getItem("autoAdvanceEnabled") !== "false";
let autoScrollSpeed = Number(localStorage.getItem("autoScrollSpeed")) || 0.5;
let autoScrollRaf = null;
let autoAdvanceTimer = null;
let autoScrollDistance = 0;
let lastFrameTime = null;
let scrollAccumulator = 0;
let wasAutoScrollingBeforeHide = false;
let isTouchHolding = false;
let lastPointerType = "mouse";
let chapterLoadToken = 0;
let pendingScrollSave = null;
let scrollSaveTimer = null;
const chapterCache = new Map();
const htmlParser = new DOMParser();

if ("scrollRestoration" in history) {
    history.scrollRestoration = "manual";
}
const homeView = document.getElementById("home-view");
const novelView = document.getElementById("novel-view");
const readerView = document.getElementById("reader-view");
const authView = document.getElementById("auth-view");
const headerBackGroup = document.getElementById("header-back-group");
const backToNovelBtn = document.getElementById("back-to-novel-btn");
const backToLibraryBtn = document.getElementById("back-to-library-btn");

const titleEl = document.getElementById("chapter-title");
const debugUrlEl = document.getElementById("debug-url");
const contentEl = document.getElementById("chapter-content");
const chapterInput = document.getElementById("chapter-input");
const dropdownMenu = document.getElementById("dropdown-menu");
const dropdownToggle = document.getElementById("dropdown-toggle");
const comboWrapper = document.getElementById("combo-wrapper");
const progressBar = document.getElementById("reading-progress");

/* ---------- Small helpers ---------- */

function createEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

// Makes a non-button element reachable and usable from the keyboard.
function makeActivatable(el, onActivate, label) {
    el.tabIndex = 0;
    el.setAttribute("role", "button");
    if (label) el.setAttribute("aria-label", label);
    el.addEventListener("click", onActivate);
    el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onActivate();
        }
    });
}

function decodeHtml(text) {
    return htmlParser.parseFromString(text || "", "text/html").documentElement.textContent.trim();
}

function readJson(key, fallback) {
    try {
        const value = JSON.parse(localStorage.getItem(key));
        return value === null ? fallback : value;
    } catch {
        return fallback;
    }
}

function toChapterNumber(value) {
    const num = Number(value);
    return Number.isInteger(num) && num > 0 ? num : null;
}

function getApiBase(novel) {
    return `https://public-api.wordpress.com/rest/v1.1/sites/${novel.siteDomain}/posts/`;
}

const JSONP_TIMEOUT_MS = 20000;
let jsonpCounter = 0;
// Some networks (e.g. office security proxies) block cross-origin fetch() but allow plain script loads.
// After the first network/CORS failure, all WordPress requests go through JSONP for the rest of the visit.
let useJsonp = false;

function fetchJsonp(url) {
    return new Promise((resolve, reject) => {
        const callbackName = `__grimoireJsonp${Date.now()}_${jsonpCounter++}`;
        const script = document.createElement("script");
        const cleanup = () => {
            clearTimeout(timer);
            delete window[callbackName];
            script.remove();
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error("The source site took too long to respond."));
        }, JSONP_TIMEOUT_MS);

        window[callbackName] = (data) => {
            cleanup();
            if (data && data.error) {
                reject(new Error(`Source site error: ${data.message || data.error}`));
            } else {
                resolve(data);
            }
        };
        script.onerror = () => {
            cleanup();
            reject(new Error("Couldn't reach the source site. Check your internet connection."));
        };
        script.src = `${url}${url.includes("?") ? "&" : "?"}callback=${callbackName}`;
        document.head.appendChild(script);
    });
}

async function fetchJson(url) {
    if (useJsonp) return fetchJsonp(url);

    let response;
    try {
        response = await fetch(url);
    } catch (err) {
        // fetch() only throws on network/CORS failures, which JSONP can often get around.
        console.warn("fetch() blocked, switching to JSONP:", err);
        useJsonp = true;
        return fetchJsonp(url);
    }
    if (!response.ok) {
        throw new Error(`Source site responded with ${response.status} ${response.statusText}`.trim());
    }
    return response.json();
}

function getUpperBound() {
    return detectedMaxChapter || (activeNovel && activeNovel.knownMaxChapter) || maxChapter;
}

function isReaderActive() {
    return readerView.classList.contains("active");
}

function isAtPageBottom() {
    return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
}

/* ---------- Reading history ---------- */

function getSavedChapter(novelId) {
    return toChapterNumber(localStorage.getItem(`lastRead_${novelId}`));
}

function getRecentChapters(novelId) {
    const list = readJson(`recentChapters_${novelId}`, []);
    return Array.isArray(list) ? list.map(toChapterNumber).filter(Boolean) : [];
}

function addRecentChapter(novelId, chapNum) {
    const num = toChapterNumber(chapNum);
    if (!num) return;
    let list = getRecentChapters(novelId).filter(c => c !== num);
    list.unshift(num);
    if (list.length > 10) list = list.slice(0, 10);
    setProgressItem(`recentChapters_${novelId}`, JSON.stringify(list));
}

function renderRecentChapters() {
    const container = document.getElementById("recent-chapters-list");
    const clearBtn = document.getElementById("clear-recent-btn");
    if (!container) return;

    const recent = getRecentChapters(activeNovel.id);
    container.replaceChildren();

    if (recent.length === 0) {
        clearBtn.style.display = "none";
        container.appendChild(createEl("div", "recent-empty", "No chapters viewed yet. Pick a chapter below to begin reading."));
        return;
    }

    clearBtn.style.display = "inline-block";
    recent.forEach((chapNum, idx) => {
        const chip = createEl("div", "recent-chip" + (idx === 0 ? " latest" : ""));
        chip.appendChild(createEl("span", "recent-chip-num", `Chapter ${chapNum}`));
        if (idx === 0) chip.appendChild(createEl("span", "recent-chip-badge", "Last Read"));
        makeActivatable(chip, () => openChapter(chapNum), `Open chapter ${chapNum}`);
        container.appendChild(chip);
    });
}

/* ---------- Scroll position memory ---------- */

// Stored per novel as [[chapter, ratio], ...], most recent first, capped at MAX_SAVED_SCROLL_POSITIONS.
function getScrollPositions(novelId) {
    const list = readJson(`scrollPositions_${novelId}`, []);
    if (!Array.isArray(list)) return [];
    return list.filter(entry => Array.isArray(entry) && toChapterNumber(entry[0]) && Number(entry[1]) > 0);
}

function getSavedScrollRatio(novelId, chapNum) {
    const entry = getScrollPositions(novelId).find(([chap]) => chap === chapNum);
    return entry ? Number(entry[1]) : 0;
}

function saveScrollRatio(novelId, chapNum, ratio) {
    const list = getScrollPositions(novelId).filter(([chap]) => chap !== chapNum);
    if (ratio > 0) list.unshift([chapNum, Number(ratio.toFixed(4))]);
    setProgressItem(`scrollPositions_${novelId}`, JSON.stringify(list.slice(0, MAX_SAVED_SCROLL_POSITIONS)));
}

function queueScrollSave(novelId, chapNum, ratio) {
    pendingScrollSave = { novelId, chapNum, ratio };
    if (!scrollSaveTimer) {
        scrollSaveTimer = setTimeout(flushScrollSave, SCROLL_SAVE_DELAY_MS);
    }
}

function flushScrollSave() {
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = null;
    if (!pendingScrollSave) return;
    const { novelId, chapNum, ratio } = pendingScrollSave;
    pendingScrollSave = null;
    saveScrollRatio(novelId, chapNum, ratio);
}

// Older versions stored one `scrollPos_<novel>_<chapter>` key per chapter forever; fold them into the capped list.
function migrateLegacyScrollPositions() {
    const legacyKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (/^scrollPos_.+_\d+$/.test(key)) legacyKeys.push(key);
    }
    if (legacyKeys.length === 0) return;

    const byNovel = {};
    for (const key of legacyKeys) {
        const [, novelId, chap] = key.match(/^scrollPos_(.+)_(\d+)$/);
        const ratio = Number(localStorage.getItem(key));
        localStorage.removeItem(key);
        if (ratio > 0) (byNovel[novelId] = byNovel[novelId] || []).push([Number(chap), ratio]);
    }

    for (const [novelId, legacy] of Object.entries(byNovel)) {
        const existing = getScrollPositions(novelId);
        const recent = getRecentChapters(novelId);
        const rank = chap => (recent.includes(chap) ? recent.indexOf(chap) : recent.length + 1);
        legacy.sort((a, b) => rank(a[0]) - rank(b[0]) || b[0] - a[0]);
        const merged = [...existing, ...legacy.filter(([chap]) => !existing.some(([c]) => c === chap))];
        setProgressItem(`scrollPositions_${novelId}`, JSON.stringify(merged.slice(0, MAX_SAVED_SCROLL_POSITIONS)));
    }
}

/* ---------- Novel selection, covers & chapter index ---------- */

function selectNovel(novel) {
    activeNovel = novel;
    minChapter = novel.detectedMin || novel.minChapter || 1;
    maxChapter = novel.maxChapter || 5000;
    detectedMaxChapter = novel.detectedMax || null;
    chapterList = novel.chapters || null;
    currentChapter = getSavedChapter(novel.id) || novel.defaultChapter || 1;
    fetchCover(novel);
    getChapterIndex(novel);
}

function escapeXml(text) {
    return String(text).replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[ch]));
}

// Generated cover for novels whose translator site has no cover image.
function placeholderCover(title) {
    const words = String(title).split(/\s+/);
    const lines = [];
    for (const word of words) {
        const last = lines[lines.length - 1];
        if (last && (last + " " + word).length <= 14) lines[lines.length - 1] = last + " " + word;
        else lines.push(word);
    }
    const startY = 210 - (lines.length - 1) * 22;
    const text = lines.slice(0, 7).map((line, i) =>
        `<text x="150" y="${startY + i * 44}" text-anchor="middle" font-family="Georgia, serif" font-size="30" font-weight="700" fill="#e0e7ff">${escapeXml(line)}</text>`
    ).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 420"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1e1b4b"/><stop offset="1" stop-color="#0b0b12"/></linearGradient></defs><rect width="300" height="420" fill="url(#g)"/><text x="150" y="80" text-anchor="middle" font-size="40" fill="#818cf8">◈</text>${text}</svg>`;
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function coverFor(novel) {
    return novel.cover || placeholderCover(novel.title);
}

function readCachedCover(novel) {
    const cached = readJson(`bounds_${novel.id}`, null);
    return cached && typeof cached === "object" ? cached : null;
}

function applyCover(novel, cover) {
    if (!cover) return;
    novel.cover = cover;
    const cardImg = document.getElementById(`card-img-${novel.id}`);
    if (cardImg) cardImg.src = cover;
    if (activeNovel && activeNovel.id === novel.id) {
        const detailImg = document.getElementById("detail-cover");
        if (detailImg) detailImg.src = cover;
    }
}

// Deduplicated so the startup loop and selectNovel() don't fire the same request twice.
function fetchCover(novel) {
    if (!novel.coverPromise) {
        novel.coverPromise = loadCover(novel);
    }
    return novel.coverPromise;
}

async function loadCover(novel) {
    if (!novel.infoSlug) return;
    const cached = readCachedCover(novel);
    if (cached && cached.cover) applyCover(novel, cached.cover);
    if (cached && Date.now() - (cached.savedAt || 0) < COVER_CACHE_TTL_MS) return;

    try {
        const data = await fetchJson(`${getApiBase(novel)}slug:${encodeURIComponent(novel.infoSlug)}?fields=content,featured_image`);
        const doc = htmlParser.parseFromString(data.content || "", "text/html");
        const firstImg = doc.querySelector("img");
        const cover = (firstImg && firstImg.getAttribute("src") || "").split("?")[0] || data.featured_image;
        if (cover && /^https:\/\//i.test(cover)) {
            applyCover(novel, cover);
            localStorage.setItem(`bounds_${novel.id}`, JSON.stringify({ cover, savedAt: Date.now() }));
        }
    } catch (err) {
        console.error(err);
    }
}

function postsUrl(novel, params, { withCategory = true } = {}) {
    const category = withCategory && novel.category ? `&category=${encodeURIComponent(novel.category)}` : "";
    return `${getApiBase(novel)}?${params}${category}`;
}

// Builds an exact chapter number → post ID map from post titles, so chapters load by ID
// instead of relying on full-text search (which misses low chapter numbers on many sites).
async function fetchChapterIndex(novel) {
    const pageUrl = page => postsUrl(novel, `number=${INDEX_PAGE_SIZE}&page=${page}&order=DESC&fields=ID,title`);
    const first = await fetchJson(pageUrl(1));
    const totalPages = Math.min(INDEX_MAX_PAGES, Math.ceil((first.found || 0) / INDEX_PAGE_SIZE));
    const rest = await Promise.all(
        Array.from({ length: Math.max(0, totalPages - 1) }, (_, i) => fetchJson(pageUrl(i + 2)))
    );

    const ids = new Map();
    for (const data of [first, ...rest]) {
        for (const post of data.posts || []) {
            const num = parseChapterTitle(novel, post.title);
            // Newest first, so a re-posted chapter wins over its older copy.
            if (num && !ids.has(num)) ids.set(num, post.ID);
        }
    }
    return [...ids.entries()].sort((a, b) => a[0] - b[0]);
}

function applyChapterIndex(novel, entries) {
    novel.chapterIds = new Map(entries);
    novel.chapters = entries.map(([num]) => num);
    if (novel.chapters.length > 0) {
        novel.detectedMin = novel.chapters[0];
        novel.detectedMax = novel.chapters[novel.chapters.length - 1];
    }
    refreshBoundsUI(novel);
    return novel.chapterIds;
}

function getChapterIndex(novel) {
    if (!novel.indexPromise) {
        novel.indexPromise = loadChapterIndex(novel);
    }
    return novel.indexPromise;
}

async function loadChapterIndex(novel) {
    const cacheKey = `chapterIndex_${novel.id}`;
    const cached = readJson(cacheKey, null);
    const hasCache = Boolean(cached && Array.isArray(cached.entries) && cached.entries.length);
    if (hasCache) {
        novel.indexState = "ready";
        applyChapterIndex(novel, cached.entries);
        if (Date.now() - (cached.savedAt || 0) < CHAPTER_INDEX_TTL_MS) return novel.chapterIds;
    } else {
        novel.indexState = "loading";
    }

    try {
        const entries = await fetchChapterIndex(novel);
        if (entries.length > 0) {
            try {
                localStorage.setItem(cacheKey, JSON.stringify({ savedAt: Date.now(), entries }));
            } catch (err) {
                console.warn("Could not cache chapter index", err);
            }
            novel.indexState = "ready";
            return applyChapterIndex(novel, entries);
        }
    } catch (err) {
        console.error(err);
    }
    if (!hasCache) {
        novel.indexState = "failed";
        refreshBoundsUI(novel);
    }
    return hasCache ? novel.chapterIds : null;
}

function refreshBoundsUI(novel) {
    if (!activeNovel || activeNovel.id !== novel.id) return;
    detectedMaxChapter = novel.detectedMax || null;
    minChapter = novel.detectedMin || novel.minChapter || 1;
    chapterList = novel.chapters && novel.chapters.length ? novel.chapters : null;
    renderNovelChapterList(document.getElementById("novel-chapter-search").value);
    renderDropdownItems("");
    updateNavButtons();
}

// Chapters to offer in lists: the real index when known, nothing while it's still loading
// (so readers can't pick chapters that don't exist), and the numeric range only if the index failed.
function getAvailableChapters() {
    if (chapterList) return chapterList;
    if (activeNovel && activeNovel.indexState === "loading") return [];
    const list = [];
    for (let i = minChapter; i <= getUpperBound(); i++) list.push(i);
    return list;
}

// Previous/next chapter that actually exists (skips gaps like SMYS 189 → 301), or null at either end.
function getAdjacentChapter(novel, chapNum, step) {
    const list = novel && novel.chapters && novel.chapters.length ? novel.chapters : null;
    if (list) {
        if (step > 0) {
            const next = list.find(n => n > chapNum);
            return next === undefined ? null : next;
        }
        for (let i = list.length - 1; i >= 0; i--) {
            if (list[i] < chapNum) return list[i];
        }
        return null;
    }
    const target = chapNum + step;
    return target >= minChapter && target <= getUpperBound() ? target : null;
}

function goToAdjacentChapter(step) {
    const target = getAdjacentChapter(activeNovel, currentChapter, step);
    if (target !== null) loadChapter(target);
}

// Explains why a chapter is missing and offers the nearest chapters that do exist.
function buildMissingChapterMessage(novel, chapNum) {
    const wrap = createEl("div", "missing-chapter");
    const chapters = novel.chapters || [];
    let reason = "This chapter isn't on the translator's site.";
    if (chapters.length && chapNum < chapters[0]) {
        reason = `This translation starts at Chapter ${chapters[0]}.`;
    } else if (chapters.length && chapNum > chapters[chapters.length - 1]) {
        reason = `The latest chapter available from this translator is Chapter ${chapters[chapters.length - 1]}.`;
    } else if (chapters.length) {
        reason = "The translator skipped this chapter on their site.";
    }
    wrap.appendChild(createEl("p", null, reason));

    const actions = createEl("div", "missing-chapter-actions");
    const prev = getAdjacentChapter(novel, chapNum, -1);
    const next = getAdjacentChapter(novel, chapNum, 1);
    if (prev !== null) {
        const btn = createEl("button", "bottom-nav-btn", `← Chapter ${prev}`);
        btn.addEventListener("click", () => loadChapter(prev));
        actions.appendChild(btn);
    }
    if (next !== null) {
        const btn = createEl("button", "bottom-nav-btn primary", `Chapter ${next} →`);
        btn.addEventListener("click", () => loadChapter(next));
        actions.appendChild(btn);
    }
    wrap.appendChild(actions);
    return wrap;
}

/* ---------- Auto-scroll ---------- */

function updateAutoScrollUI() {
    const btn = document.getElementById("autoscroll-btn");
    const speedDisplay = document.getElementById("speed-display");
    const advanceBtn = document.getElementById("autoadvance-btn");
    if (btn) {
        if (autoAdvanceTimer) {
            btn.textContent = "⏭ Next…";
        } else {
            btn.textContent = isAutoScrolling ? "⏸ Pause" : "▶ Auto";
        }
        btn.classList.toggle("active", isAutoScrolling || Boolean(autoAdvanceTimer));
    }
    if (speedDisplay) {
        speedDisplay.textContent = `${autoScrollSpeed}x`;
    }
    if (advanceBtn) {
        advanceBtn.classList.toggle("active", autoAdvanceEnabled);
        advanceBtn.setAttribute("aria-pressed", String(autoAdvanceEnabled));
        advanceBtn.title = `Auto-advance to next chapter: ${autoAdvanceEnabled ? "On" : "Off"}`;
    }
}

function autoScrollStep(timestamp) {
    if (!isAutoScrolling) return;
    if (!lastFrameTime || isTouchHolding) {
        // Hold position while the reader's finger is on the screen.
        lastFrameTime = timestamp;
        autoScrollRaf = requestAnimationFrame(autoScrollStep);
        return;
    }
    const delta = (timestamp - lastFrameTime) / 1000;
    lastFrameTime = timestamp;

    const pixelsPerSecond = autoScrollSpeed * 22;
    scrollAccumulator += pixelsPerSecond * delta;

    if (scrollAccumulator >= 1) {
        const move = Math.floor(scrollAccumulator);
        window.scrollBy(0, move);
        scrollAccumulator -= move;
        autoScrollDistance += move;
    }

    if (isAtPageBottom()) {
        // Only advance when auto-scroll itself carried the reader to the end,
        // not when a finished chapter was reopened at its saved bottom position.
        const reachedEndByScrolling = autoScrollDistance > 0;
        stopAutoScroll(false);
        if (reachedEndByScrolling) scheduleAutoAdvance();
        return;
    }

    autoScrollRaf = requestAnimationFrame(autoScrollStep);
}

function startAutoScroll(savePreference = true) {
    if (savePreference) {
        autoScrollEnabled = true;
        setProgressItem("autoScrollEnabled", "true");
    }
    if (isAutoScrolling) return;
    cancelAutoAdvance();
    isAutoScrolling = true;
    lastFrameTime = null;
    scrollAccumulator = 0;
    autoScrollDistance = 0;
    updateAutoScrollUI();
    autoScrollRaf = requestAnimationFrame(autoScrollStep);
}

function stopAutoScroll(savePreference = true) {
    if (savePreference) {
        autoScrollEnabled = false;
        setProgressItem("autoScrollEnabled", "false");
        wasAutoScrollingBeforeHide = false;
    }
    cancelAutoAdvance();
    isAutoScrolling = false;
    lastFrameTime = null;
    if (autoScrollRaf) cancelAnimationFrame(autoScrollRaf);
    updateAutoScrollUI();
}

function toggleAutoScroll() {
    if (isAutoScrolling || autoAdvanceTimer) {
        stopAutoScroll(true);
    } else {
        startAutoScroll(true);
    }
}

function scheduleAutoAdvance() {
    if (!autoAdvanceEnabled || !autoScrollEnabled || !isReaderActive()) return;
    const next = getAdjacentChapter(activeNovel, currentChapter, 1);
    if (next === null) return;
    autoAdvanceTimer = setTimeout(() => {
        autoAdvanceTimer = null;
        if (isReaderActive()) loadChapter(next);
    }, AUTO_ADVANCE_DELAY_MS);
    updateAutoScrollUI();
}

function cancelAutoAdvance() {
    if (!autoAdvanceTimer) return;
    clearTimeout(autoAdvanceTimer);
    autoAdvanceTimer = null;
    updateAutoScrollUI();
}

/* ---------- Views ---------- */

function openChapter(chapNum) {
    switchView("reader");
    loadChapter(chapNum);
}

function switchView(viewName, updateUrl = true) {
    stopAutoScroll(false);
    homeView.classList.remove("active");
    novelView.classList.remove("active");
    readerView.classList.remove("active");
    authView.classList.remove("active");
    document.body.classList.remove("reader-mode");

    headerBackGroup.style.display = "none";
    backToNovelBtn.style.display = "none";
    backToLibraryBtn.style.display = "none";

    if (viewName === "home") {
        homeView.classList.add("active");
        const searchInput = document.getElementById("library-search-input");
        renderLibraryGrid(searchInput ? searchInput.value : "");
        if (updateUrl) history.pushState(null, "", "#/");
    } else if (viewName === "novel") {
        novelView.classList.add("active");
        headerBackGroup.style.display = "flex";
        backToLibraryBtn.style.display = "inline-flex";
        renderNovelDetails(activeNovel);
        if (updateUrl) history.pushState(null, "", `#/novel/${activeNovel.id}`);
    } else if (viewName === "reader") {
        readerView.classList.add("active");
        document.body.classList.add("reader-mode");
        headerBackGroup.style.display = "flex";
        backToNovelBtn.style.display = "inline-flex";
        backToLibraryBtn.style.display = "inline-flex";
        document.getElementById("reader-novel-kicker").textContent = activeNovel.title;
        applyFontSize();
    } else if (viewName === "login" || viewName === "signup") {
        authView.classList.add("active");
        headerBackGroup.style.display = "flex";
        backToLibraryBtn.style.display = "inline-flex";
        document.getElementById("login-panel").hidden = viewName !== "login";
        document.getElementById("signup-panel").hidden = viewName !== "signup";
        if (updateUrl) history.pushState(null, "", `#/${viewName}`);
        window.dispatchEvent(new CustomEvent("grimoire:auth-view", { detail: viewName }));
    }
    window.scrollTo(0, 0);
}

function applyFontSize() {
    contentEl.style.fontSize = `${readerFontSize}px`;
    document.getElementById("font-size-display").textContent = `${readerFontSize}px`;
}

function changeFontSize(step) {
    const next = readerFontSize + step;
    if (next < 14 || next > 32) return;
    readerFontSize = next;
    setProgressItem("readerFontSize", readerFontSize);
    applyFontSize();
}

function renderLibraryGrid(filterQuery = "") {
    const grid = document.getElementById("novel-grid");
    grid.replaceChildren();
    const q = filterQuery.trim().toLowerCase();

    const filtered = NOVELS.filter(novel => {
        if (!q) return true;
        const inTitle = novel.title.toLowerCase().includes(q);
        const inAuthor = novel.author.toLowerCase().includes(q);
        const inGenres = novel.genres.some(g => g.toLowerCase().includes(q));
        const inAlt = novel.associatedNames.some(a => a.toLowerCase().includes(q));
        return inTitle || inAuthor || inGenres || inAlt;
    });

    if (filtered.length === 0) {
        grid.appendChild(createEl("div", "empty-library-msg", `No novels found matching "${filterQuery}".`));
        return;
    }

    for (const novel of filtered) {
        const savedChap = getSavedChapter(novel.id);
        const card = createEl("div", "novel-card");

        const coverWrap = createEl("div", "card-cover-wrap");
        const img = createEl("img");
        img.id = `card-img-${novel.id}`;
        img.src = coverFor(novel);
        img.alt = novel.title;
        coverWrap.appendChild(img);
        coverWrap.appendChild(createEl("div", "card-badge", novel.type));
        if (savedChap) coverWrap.appendChild(createEl("div", "card-continue", `Ch. ${savedChap}`));

        const body = createEl("div", "card-body");
        body.appendChild(createEl("h3", "card-title", novel.title));
        body.appendChild(createEl("div", "card-sub", novel.author));

        card.append(coverWrap, body);
        makeActivatable(card, () => {
            selectNovel(novel);
            switchView("novel");
        }, `Open ${novel.title}`);
        grid.appendChild(card);
    }
}

function renderNovelDetails(novel) {
    const savedChap = getSavedChapter(novel.id);
    currentChapter = savedChap || novel.defaultChapter;

    document.getElementById("detail-cover").src = coverFor(novel);
    document.getElementById("detail-title").textContent = novel.title;
    const translatorEl = document.getElementById("detail-translator");
    if (translatorEl) {
        translatorEl.textContent = novel.translator ? `Source: ${novel.translator}` : "";
    }
    document.getElementById("detail-type").textContent = novel.type;
    document.getElementById("detail-author").textContent = novel.author;
    document.getElementById("detail-status").textContent = novel.status;
    document.getElementById("detail-translation").textContent = novel.translationStatus || "";
    document.getElementById("detail-translation-row").hidden = !novel.translationStatus;

    const continueBtn = document.getElementById("continue-reading-btn");
    continueBtn.textContent = savedChap
        ? `Continue Reading (Chapter ${currentChapter})`
        : `Start Reading (Chapter ${currentChapter})`;

    document.getElementById("detail-genres").replaceChildren(
        ...novel.genres.map(g => createEl("span", "genre-tag", g))
    );
    document.getElementById("detail-description").replaceChildren(
        ...novel.description.map(p => createEl("p", null, p))
    );
    document.getElementById("detail-alt-names").replaceChildren(
        ...novel.associatedNames.map(n => createEl("li", null, `• ${n}`))
    );

    renderRecentChapters();
    renderNovelChapterList(document.getElementById("novel-chapter-search").value);
}

function renderNovelChapterList(filterText = "") {
    const listEl = document.getElementById("novel-chapter-list");
    const countLabel = document.getElementById("chapter-count-label");
    if (!listEl || !activeNovel) return;

    listEl.replaceChildren();
    const cleanFilter = filterText.replace(/[^0-9]/g, "");
    const available = getAvailableChapters();
    const recentList = getRecentChapters(activeNovel.id);
    const savedChap = getSavedChapter(activeNovel.id);

    countLabel.textContent = available.length
        ? `List of Chapters (${available.length} · ${available[0]} – ${available[available.length - 1]})`
        : (activeNovel.indexState === "loading" ? "List of Chapters (loading…)" : "List of Chapters");

    const chapters = available.filter(i => !cleanFilter || String(i).includes(cleanFilter));

    if (sortDescending) {
        chapters.reverse();
    }

    const fragment = document.createDocumentFragment();
    for (const chapNum of chapters) {
        const isLast = chapNum === savedChap;
        const isVisited = recentList.includes(chapNum);
        const pill = createEl("div", "chapter-pill" + (isLast ? " last-read" : ""));
        pill.appendChild(createEl("span", "chapter-pill-num", `Chapter ${chapNum}`));
        if (isLast || isVisited) {
            pill.appendChild(createEl("span", "chapter-pill-tag", isLast ? "LAST" : "READ"));
        }
        makeActivatable(pill, () => openChapter(chapNum), `Open chapter ${chapNum}`);
        fragment.appendChild(pill);
    }
    listEl.appendChild(fragment);
}

/* ---------- Chapter matching ---------- */

// Only accept text that *starts* with "Chapter N" followed by nothing or a separator (or is just "N"),
// so posts like "Buy chapters from 331 to 355!", "Happy New Year 2025" or
// "Chapter 949 will be delayed" are never mistaken for chapters.
function parseChapterHeading(text) {
    const clean = (text || "").trim();
    const match = clean.match(/^(?:chapter|ch\.?)\s*(\d{1,4})\s*(?:$|[:\-–—.(\[])/i) || clean.match(/^(\d{1,4})$/);
    return match ? Number(match[1]) : null;
}

// Novels can define `chapterPattern` (a regex whose first group is the chapter number) for sites
// whose titles don't start with "Chapter N", e.g. "Talent Swallowing Magician Ch. 12".
function getChapterMatcher(novel) {
    if (novel.chapterRegex === undefined) {
        novel.chapterRegex = novel.chapterPattern ? new RegExp(novel.chapterPattern, "i") : null;
    }
    return novel.chapterRegex;
}

function parseChapterTitle(novel, title) {
    const text = decodeHtml(title);
    const matcher = getChapterMatcher(novel);
    if (matcher) {
        const match = text.match(matcher);
        return match ? toChapterNumber(match[1]) : null;
    }
    return parseChapterHeading(text);
}

function extractChapterNum(post, novel) {
    const fromTitle = parseChapterTitle(novel, post.title);
    if (fromTitle || getChapterMatcher(novel)) return fromTitle;

    const doc = htmlParser.parseFromString(post.content || "", "text/html");
    const paragraphs = doc.querySelectorAll("p");
    for (let i = 0; i < Math.min(3, paragraphs.length); i++) {
        const fromParagraph = parseChapterHeading(paragraphs[i].textContent);
        if (fromParagraph) return fromParagraph;
    }
    return null;
}

function findMatchingPost(posts, targetNum, novel) {
    return posts.find(post => extractChapterNum(post, novel) === targetNum) || null;
}

// Rebuilds paragraphs from scratch keeping only harmless inline formatting, so markup
// from the source site (event handlers, scripts, styles) can never run on this page.
function appendSanitizedChildren(source, target) {
    for (const node of source.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            target.appendChild(document.createTextNode(node.textContent));
            continue;
        }
        if (node.nodeType !== Node.ELEMENT_NODE || DROPPED_TAGS.has(node.tagName)) continue;

        if (node.tagName === "IMG") {
            const src = node.getAttribute("src") || "";
            if (/^https?:\/\//i.test(src)) {
                const img = document.createElement("img");
                img.src = src;
                img.alt = node.getAttribute("alt") || "";
                img.loading = "lazy";
                target.appendChild(img);
            }
        } else if (ALLOWED_INLINE_TAGS.has(node.tagName)) {
            const clean = document.createElement(node.tagName.toLowerCase());
            appendSanitizedChildren(node, clean);
            target.appendChild(clean);
        } else {
            appendSanitizedChildren(node, target);
        }
    }
}

function buildChapterContent(rawHtml, novel, chapNum) {
    const doc = htmlParser.parseFromString(rawHtml || "", "text/html");
    const paragraphs = Array.from(doc.querySelectorAll("p")).filter(p => p.textContent.trim());

    let end = paragraphs.length;
    for (let i = paragraphs.length - 1; i >= Math.floor(paragraphs.length * TRAILER_ZONE); i--) {
        const text = paragraphs[i].textContent.trim();
        if (TRAILER_MARKERS.some(pattern => pattern.test(text))) end = i;
    }

    const fragment = document.createDocumentFragment();
    paragraphs.slice(0, end).forEach((p, i) => {
        const text = p.textContent.trim();
        if (CUT_PATTERNS.some(pattern => pattern.test(text))) return;
        // Many posts repeat the chapter heading (e.g. "301") as their first paragraph.
        if (i < 3 && (parseChapterHeading(text) === chapNum || parseChapterTitle(novel, text) === chapNum)) return;

        const clean = document.createElement("p");
        appendSanitizedChildren(p, clean);
        if (clean.textContent.trim()) fragment.appendChild(clean);
    });
    return fragment;
}

function safeHttpUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
    } catch {
        return null;
    }
}

function externalLink(href, text, className) {
    const link = createEl("a", className, text);
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener";
    return link;
}

function renderSourceLink(url) {
    debugUrlEl.replaceChildren();
    const href = safeHttpUrl(url);
    if (href) debugUrlEl.appendChild(externalLink(href, `Source: ${href} ↗`));
}

// Bottom-of-chapter credit with the translator's own donation links (configured per novel in novels.json).
function updateSupportPanel(novel, chapterUrl) {
    const panel = document.getElementById("support-panel");
    const nameEl = document.getElementById("support-translator");
    const linksEl = document.getElementById("support-links");
    nameEl.replaceChildren();
    linksEl.replaceChildren();

    const translator = novel.translatorName || novel.translator;
    const siteUrl = safeHttpUrl(novel.translatorUrl || `https://${novel.siteDomain}/`);
    nameEl.appendChild(siteUrl ? externalLink(siteUrl, translator) : document.createTextNode(translator));

    const chapterHref = safeHttpUrl(chapterUrl);
    if (chapterHref) linksEl.appendChild(externalLink(chapterHref, "Read on their site ↗", "support-btn"));
    for (const { label, url } of novel.supportLinks || []) {
        const href = safeHttpUrl(url);
        if (href) linksEl.appendChild(externalLink(href, `${label} ↗`, "support-btn primary"));
    }
    panel.hidden = false;
}

/* ---------- Chapter loading ---------- */

// Small LRU of chapter lookups (promises, so a prefetch in flight is reused instead of re-requested).
function getChapterPost(novel, chapNum) {
    const key = `${novel.id}:${chapNum}`;
    if (chapterCache.has(key)) {
        const cached = chapterCache.get(key);
        chapterCache.delete(key);
        chapterCache.set(key, cached);
        return cached;
    }

    const request = resolveChapterPost(novel, chapNum);
    request.catch(() => chapterCache.delete(key));

    chapterCache.set(key, request);
    while (chapterCache.size > CHAPTER_CACHE_LIMIT) {
        chapterCache.delete(chapterCache.keys().next().value);
    }
    return request;
}

async function resolveChapterPost(novel, chapNum) {
    const ids = await getChapterIndex(novel);
    const postId = ids && ids.get(chapNum);
    if (postId) {
        return fetchJson(`${getApiBase(novel)}${postId}?fields=ID,title,content,URL`);
    }
    // Not in the index (index unavailable, or a chapter published after it was cached): fall back to search.
    // The category filter is skipped here because WordPress.com returns nothing when it's combined with search.
    const data = await fetchJson(postsUrl(novel, `search=${chapNum}&number=20&fields=ID,title,content,URL`, { withCategory: false }));
    return findMatchingPost(data.posts || [], chapNum, novel);
}

function prefetchNextChapter(novel, chapNum) {
    const next = getAdjacentChapter(novel, chapNum, 1);
    if (next === null) return;
    getChapterPost(novel, next).catch(() => {});
}

function updateNavButtons() {
    const atMin = !activeNovel || getAdjacentChapter(activeNovel, currentChapter, -1) === null;
    const atMax = !activeNovel || getAdjacentChapter(activeNovel, currentChapter, 1) === null;
    document.getElementById("prev-top").disabled = atMin;
    document.getElementById("prev-bottom").disabled = atMin;
    document.getElementById("next-top").disabled = atMax;
    document.getElementById("next-bottom").disabled = atMax;
}

function restoreScrollPosition(novelId, chapNum, token) {
    const finishRestore = () => {
        if (token !== chapterLoadToken) return;
        isRestoringScroll = false;
        if (autoScrollEnabled && isReaderActive() && !document.hidden) startAutoScroll(false);
    };

    const savedRatio = getSavedScrollRatio(novelId, chapNum);
    if (savedRatio > 0) {
        setTimeout(() => {
            requestAnimationFrame(() => {
                if (token !== chapterLoadToken) return;
                const docHeight = document.documentElement.scrollHeight - window.innerHeight;
                window.scrollTo(0, docHeight * savedRatio);
                progressBar.style.width = `${savedRatio * 100}%`;
                setTimeout(finishRestore, 100);
            });
        }, 60);
    } else {
        window.scrollTo(0, 0);
        progressBar.style.width = "0%";
        finishRestore();
    }
}

async function loadChapter(chapterNum, updateUrl = true) {
    stopAutoScroll(false);
    flushScrollSave();
    const num = toChapterNumber(String(chapterNum).replace(/[^0-9]/g, ""));
    if (!num) return;

    // Each load gets a token; responses from older, superseded loads are ignored.
    const token = ++chapterLoadToken;
    const novel = activeNovel;

    currentChapter = num;
    chapterInput.value = `Chapter ${currentChapter}`;
    updateNavButtons();

    if (updateUrl) {
        history.pushState(null, "", `#/novel/${novel.id}/chapter/${currentChapter}`);
    }

    titleEl.textContent = `Loading Chapter ${currentChapter}...`;
    debugUrlEl.textContent = "Fetching chapter from source...";
    contentEl.replaceChildren();
    updateSupportPanel(novel, null);
    progressBar.style.width = "0%";
    isRestoringScroll = true;
    window.scrollTo(0, 0);

    try {
        const post = await getChapterPost(novel, num);
        if (token !== chapterLoadToken) return;

        if (!post) {
            titleEl.textContent = `Chapter ${num} Not Available`;
            debugUrlEl.textContent = "";
            contentEl.replaceChildren(buildMissingChapterMessage(novel, num));
            updateSupportPanel(novel, null);
            updateNavButtons();
            isRestoringScroll = false;
            return;
        }

        // Only chapters that actually loaded count as reading progress.
        setProgressItem(`lastRead_${novel.id}`, num);
        addRecentChapter(novel.id, num);
        titleEl.textContent = decodeHtml(post.title) || `Chapter ${num}`;
        renderSourceLink(post.URL);
        contentEl.replaceChildren(buildChapterContent(post.content, novel, num));
        updateSupportPanel(novel, post.URL);
        restoreScrollPosition(novel.id, num, token);
        prefetchNextChapter(novel, num);
    } catch (err) {
        if (token !== chapterLoadToken) return;
        titleEl.textContent = "Error Loading Chapter";
        debugUrlEl.textContent = "";
        contentEl.replaceChildren(createEl("p", null, err.message));
        isRestoringScroll = false;
    }
}

/* ---------- Chapter combo-box ---------- */

function renderDropdownItems(filterText) {
    dropdownMenu.replaceChildren();
    if (!activeNovel) return;
    const cleanFilter = filterText.replace(/[^0-9]/g, "");

    const fragment = document.createDocumentFragment();
    for (const i of getAvailableChapters()) {
        if (cleanFilter && !String(i).includes(cleanFilter)) continue;

        const item = createEl("div", "dropdown-item" + (i === currentChapter ? " active" : ""), `Chapter ${i}`);
        item.id = `chapter-option-${i}`;
        item.dataset.chapter = i;
        item.setAttribute("role", "option");
        item.addEventListener("click", () => {
            closeDropdown();
            loadChapter(i);
        });
        fragment.appendChild(item);
    }
    dropdownMenu.appendChild(fragment);
    chapterInput.removeAttribute("aria-activedescendant");
}

function openDropdown() {
    renderDropdownItems("");
    dropdownMenu.classList.add("open");
    chapterInput.setAttribute("aria-expanded", "true");
    const activeItem = dropdownMenu.querySelector(".dropdown-item.active");
    if (activeItem) {
        activeItem.scrollIntoView({ block: "center" });
    }
}

function closeDropdown() {
    dropdownMenu.classList.remove("open");
    chapterInput.setAttribute("aria-expanded", "false");
    chapterInput.removeAttribute("aria-activedescendant");
    chapterInput.value = `Chapter ${currentChapter}`;
}

function moveDropdownHighlight(step) {
    if (!dropdownMenu.classList.contains("open")) {
        dropdownMenu.classList.add("open");
        chapterInput.setAttribute("aria-expanded", "true");
    }
    const items = Array.from(dropdownMenu.querySelectorAll(".dropdown-item"));
    if (items.length === 0) return;

    let idx = items.findIndex(item => item.classList.contains("highlighted"));
    if (idx === -1) idx = items.findIndex(item => item.classList.contains("active"));
    idx = idx === -1
        ? (step > 0 ? 0 : items.length - 1)
        : Math.min(items.length - 1, Math.max(0, idx + step));

    items.forEach(item => item.classList.remove("highlighted"));
    items[idx].classList.add("highlighted");
    items[idx].scrollIntoView({ block: "nearest" });
    chapterInput.setAttribute("aria-activedescendant", items[idx].id);
}

/* ---------- Progress store (local, synced to the account by auth.js) ---------- */

function isProgressKey(key) {
    return PROGRESS_KEY_PATTERN.test(key) || PREFERENCE_KEYS.includes(key);
}

function collectProgress() {
    const data = {};
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (isProgressKey(key)) data[key] = localStorage.getItem(key);
    }
    return data;
}

function getLocalProgressUpdatedAt() {
    return Number(localStorage.getItem(PROGRESS_UPDATED_AT_KEY)) || 0;
}

function markProgressChanged() {
    localStorage.setItem(PROGRESS_UPDATED_AT_KEY, String(Date.now()));
    window.dispatchEvent(new CustomEvent("grimoire:progress-changed"));
}

// All progress writes go through these so a signed-in session knows when to sync.
function setProgressItem(key, value) {
    const str = String(value);
    if (localStorage.getItem(key) === str) return;
    localStorage.setItem(key, str);
    markProgressChanged();
}

function removeProgressItem(key) {
    if (localStorage.getItem(key) === null) return;
    localStorage.removeItem(key);
    markProgressChanged();
}

function reloadPreferences() {
    readerFontSize = Number(localStorage.getItem("readerFontSize")) || 20;
    autoScrollSpeed = Number(localStorage.getItem("autoScrollSpeed")) || 0.5;
    autoScrollEnabled = localStorage.getItem("autoScrollEnabled") === "true";
    autoAdvanceEnabled = localStorage.getItem("autoAdvanceEnabled") !== "false";
    if (isAutoScrolling && !autoScrollEnabled) stopAutoScroll(false);
}

function refreshCurrentView() {
    updateAutoScrollUI();
    if (homeView.classList.contains("active")) {
        renderLibraryGrid(document.getElementById("library-search-input").value);
    } else if (novelView.classList.contains("active") && activeNovel) {
        renderNovelDetails(activeNovel);
    } else if (isReaderActive()) {
        applyFontSize();
    }
}

// Replaces everything saved in this browser with `data` (used when loading an account's progress).
function applyProgress(data, updatedAtMs) {
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = null;
    pendingScrollSave = null;

    Object.keys(collectProgress()).forEach(key => localStorage.removeItem(key));
    Object.entries(data || {}).forEach(([key, value]) => {
        if (isProgressKey(key) && typeof value === "string") localStorage.setItem(key, value);
    });
    localStorage.setItem(PROGRESS_UPDATED_AT_KEY, String(updatedAtMs || 0));

    reloadPreferences();
    if (activeNovel && !isReaderActive()) {
        currentChapter = getSavedChapter(activeNovel.id) || activeNovel.defaultChapter || 1;
    }
    refreshCurrentView();
}

function ensureProgressTimestamp() {
    let updatedAt = getLocalProgressUpdatedAt();
    if (!updatedAt) {
        updatedAt = Date.now();
        localStorage.setItem(PROGRESS_UPDATED_AT_KEY, String(updatedAt));
    }
    return updatedAt;
}

let toastTimer = null;
function showToast(message, isError = false) {
    const toast = document.getElementById("toast");
    toast.textContent = message;
    toast.classList.toggle("error", isError);
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 4000);
}

function navigate(route, replace = false) {
    if (replace) {
        history.replaceState(null, "", route);
    } else {
        history.pushState(null, "", route);
    }
    handleRouteFromUrl();
}

// Interface used by auth.js (a module script, loaded after this file).
window.Grimoire = {
    collectProgress,
    applyProgress,
    clearProgress: () => applyProgress({}, 0),
    flushScrollSave,
    getLocalProgressUpdatedAt,
    ensureProgressTimestamp,
    showToast,
    navigate
};

/* ---------- Event wiring ---------- */

makeActivatable(document.getElementById("nav-home"), () => switchView("home"), "Grimoire home");
backToLibraryBtn.addEventListener("click", () => switchView("home"));
backToNovelBtn.addEventListener("click", () => switchView("novel"));

document.getElementById("clear-recent-btn").addEventListener("click", () => {
    removeProgressItem(`recentChapters_${activeNovel.id}`);
    renderRecentChapters();
    renderNovelChapterList(document.getElementById("novel-chapter-search").value);
});

document.getElementById("continue-reading-btn").addEventListener("click", () => openChapter(currentChapter));

document.getElementById("novel-chapter-search").addEventListener("input", (e) => {
    renderNovelChapterList(e.target.value);
});

document.getElementById("sort-toggle-btn").addEventListener("click", (e) => {
    sortDescending = !sortDescending;
    e.target.textContent = sortDescending ? "Sort: Newest ↓" : "Sort: Oldest ↑";
    renderNovelChapterList(document.getElementById("novel-chapter-search").value);
});

document.getElementById("font-dec").addEventListener("click", () => changeFontSize(-2));
document.getElementById("font-inc").addEventListener("click", () => changeFontSize(2));

chapterInput.addEventListener("focus", () => {
    chapterInput.value = "";
    openDropdown();
});

chapterInput.addEventListener("input", () => {
    dropdownMenu.classList.add("open");
    chapterInput.setAttribute("aria-expanded", "true");
    renderDropdownItems(chapterInput.value);
});

chapterInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        moveDropdownHighlight(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
        const highlighted = dropdownMenu.querySelector(".dropdown-item.highlighted");
        const val = highlighted ? highlighted.dataset.chapter : chapterInput.value.trim();
        closeDropdown();
        chapterInput.blur();
        if (val) loadChapter(val);
    } else if (e.key === "Escape") {
        closeDropdown();
        chapterInput.blur();
    }
});

dropdownToggle.addEventListener("click", () => {
    if (dropdownMenu.classList.contains("open")) {
        closeDropdown();
    } else {
        openDropdown();
    }
});

document.addEventListener("click", (e) => {
    if (!comboWrapper.contains(e.target)) {
        closeDropdown();
    }
});

window.addEventListener("keydown", (e) => {
    if (!isReaderActive()) return;
    if (document.activeElement && document.activeElement.tagName === "INPUT") return;

    if (e.code === "Space") {
        e.preventDefault();
        if (document.activeElement && document.activeElement.tagName === "BUTTON") {
            document.activeElement.blur();
        }
        toggleAutoScroll();
    } else if (e.key === "ArrowRight") {
        e.preventDefault();
        window.scrollBy({ top: ARROW_SCROLL_AMOUNT, behavior: "smooth" });
    } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        window.scrollBy({ top: -ARROW_SCROLL_AMOUNT, behavior: "smooth" });
    }
});

window.addEventListener("scroll", () => {
    if (!isReaderActive() || !activeNovel) return;
    const scrollTop = window.scrollY;
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const ratio = docHeight > 0 ? Math.min(1, Math.max(0, scrollTop / docHeight)) : 0;
    progressBar.style.width = `${ratio * 100}%`;

    if (!isRestoringScroll && docHeight > 0) {
        queueScrollSave(activeNovel.id, currentChapter, ratio);
    }
}, { passive: true });

// Mobile: tap the text to pause/resume auto-scroll, and hold still while a finger is on the screen.
window.addEventListener("pointerdown", (e) => {
    lastPointerType = e.pointerType;
}, { passive: true });

contentEl.addEventListener("click", () => {
    if (lastPointerType !== "touch") return;
    const selection = window.getSelection();
    if (selection && selection.toString()) return;
    toggleAutoScroll();
});

window.addEventListener("touchstart", () => {
    isTouchHolding = true;
}, { passive: true });

["touchend", "touchcancel"].forEach(type => {
    window.addEventListener(type, () => {
        isTouchHolding = false;
    }, { passive: true });
});

document.getElementById("prev-top").addEventListener("click", () => goToAdjacentChapter(-1));
document.getElementById("next-top").addEventListener("click", () => goToAdjacentChapter(1));
document.getElementById("prev-bottom").addEventListener("click", () => goToAdjacentChapter(-1));
document.getElementById("next-bottom").addEventListener("click", () => goToAdjacentChapter(1));
document.getElementById("library-search-input").addEventListener("input", (e) => {
    renderLibraryGrid(e.target.value);
});

document.addEventListener("click", (e) => {
    const navTarget = e.target.closest("[data-nav]");
    if (navTarget) {
        e.preventDefault();
        navigate(navTarget.dataset.nav);
    }
});

function handleRouteFromUrl() {
    const hash = decodeURIComponent(window.location.hash || "#/");
    const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);

    if (parts[0] === "login" || parts[0] === "signup") {
        switchView(parts[0], false);
    } else if (parts[0] === "novel" && parts[1]) {
        const targetNovel = NOVELS.find(n => n.id === parts[1]);
        if (!targetNovel) {
            switchView("home", true);
            return;
        }

        selectNovel(targetNovel);

        if (parts[2] === "chapter" && parts[3]) {
            switchView("reader", false);
            loadChapter(parts[3], false);
        } else {
            switchView("novel", false);
        }
    } else {
        switchView("home", false);
    }
}

window.addEventListener("popstate", handleRouteFromUrl);

document.getElementById("autoscroll-btn").addEventListener("click", toggleAutoScroll);

document.getElementById("autoadvance-btn").addEventListener("click", () => {
    autoAdvanceEnabled = !autoAdvanceEnabled;
    setProgressItem("autoAdvanceEnabled", String(autoAdvanceEnabled));
    if (!autoAdvanceEnabled) cancelAutoAdvance();
    updateAutoScrollUI();
});

document.getElementById("speed-dec").addEventListener("click", () => {
    let idx = SPEED_STEPS.findIndex(s => s >= autoScrollSpeed);
    if (idx === -1) idx = SPEED_STEPS.length - 1;
    if (idx > 0) {
        autoScrollSpeed = SPEED_STEPS[idx - 1];
        setProgressItem("autoScrollSpeed", autoScrollSpeed);
        updateAutoScrollUI();
    }
});

document.getElementById("speed-inc").addEventListener("click", () => {
    let idx = SPEED_STEPS.findIndex(s => s >= autoScrollSpeed);
    if (idx === -1) idx = 0;
    if (idx < SPEED_STEPS.length - 1) {
        autoScrollSpeed = SPEED_STEPS[idx + 1];
        setProgressItem("autoScrollSpeed", autoScrollSpeed);
        updateAutoScrollUI();
    }
});

function pauseOnLeave() {
    if (isAutoScrolling) {
        wasAutoScrollingBeforeHide = true;
        stopAutoScroll(false);
    }
}

function resumeOnReturn() {
    if ((wasAutoScrollingBeforeHide || autoScrollEnabled) && isReaderActive() && !isRestoringScroll && !autoAdvanceTimer) {
        wasAutoScrollingBeforeHide = false;
        if (!isAtPageBottom()) startAutoScroll(false);
    }
}

document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        flushScrollSave();
        pauseOnLeave();
    } else {
        resumeOnReturn();
    }
});

window.addEventListener("pagehide", flushScrollSave);
window.addEventListener("blur", pauseOnLeave);
window.addEventListener("focus", resumeOnReturn);

async function init() {
    migrateLegacyScrollPositions();
    updateAutoScrollUI();

    try {
        const response = await fetch("novels.json", { cache: "no-cache" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        NOVELS = await response.json();
    } catch (err) {
        console.error(err);
        document.getElementById("novel-grid").replaceChildren(createEl("div", "empty-library-msg",
            "Could not load the novel list. If you opened index.html directly from disk, serve the folder instead (see README)."));
        return;
    }

    NOVELS.forEach(novel => {
        const cached = readCachedCover(novel);
        if (cached && cached.cover) novel.cover = cached.cover;
    });
    activeNovel = NOVELS[0];
    NOVELS.forEach(novel => fetchCover(novel));
    handleRouteFromUrl();
}

init();
