const NOVELS = [
    {
        id: "smys",
        title: "SWORDMASTER'S YOUNGEST SON",
        siteDomain: "blackseatls.wordpress.com",
        infoSlug: "swordmasters-youngest-son-2",
        cover: "https://images.unsplash.com/photo-1579783900882-c0d3dad7b119?auto=format&fit=crop&w=600&q=80",
        type: "Web Novel",
        genres: ["Action", "Adventure", "Fantasy", "Martial Arts", "Shounen"],
        author: "Emperor Penguin / 황제펭귄",
        status: "46 Volumes / 1147 chapters (Complete)",
        description: [
            "Jin Runcandel is the youngest son of the greatest Swordmaster. After he gets himself kicked out of their clan, he meets a tragic fate...but before he dies, a God gives him a second chance. Now he must use his new power for good.",
            "Will Jin become the world's strongest Swordmaster and live up to his greatest potential?"
        ],
        associatedNames: [
            "SMYS",
            "The Swordmaster's Son",
            "The Youngest Son of a Renowned Family of Swordsmen",
            "검술명가 막내아들"
        ],
        defaultChapter: 301,
        minChapter: 1,
        maxChapter: 5000
    }
];

let activeNovel = NOVELS[0];
let currentChapter = Number(localStorage.getItem(`lastRead_${activeNovel.id}`)) || activeNovel.defaultChapter;
let minChapter = activeNovel.minChapter;
let maxChapter = activeNovel.maxChapter;
let detectedMaxChapter = 948;
let sortDescending = true;
let readerFontSize = Number(localStorage.getItem("readerFontSize")) || 20;

const homeView = document.getElementById("home-view");
const novelView = document.getElementById("novel-view");
const readerView = document.getElementById("reader-view");
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

function getApiBase(novel) {
    return `https://public-api.wordpress.com/rest/v1.1/sites/${novel.siteDomain}/posts/`;
}

function getRecentChapters(novelId) {
    try {
        const raw = localStorage.getItem(`recentChapters_${novelId}`);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function addRecentChapter(novelId, chapNum) {
    const num = Number(chapNum);
    if (!num) return;
    let list = getRecentChapters(novelId).filter(c => c !== num);
    list.unshift(num);
    if (list.length > 10) list = list.slice(0, 10);
    localStorage.setItem(`recentChapters_${novelId}`, JSON.stringify(list));
}

function renderRecentChapters() {
    const container = document.getElementById("recent-chapters-list");
    const clearBtn = document.getElementById("clear-recent-btn");
    if (!container) return;

    const recent = getRecentChapters(activeNovel.id);
    container.innerHTML = "";

    if (recent.length === 0) {
        clearBtn.style.display = "none";
        container.innerHTML = `<div class="recent-empty">No chapters viewed yet. Pick a chapter below to begin reading.</div>`;
        return;
    }

    clearBtn.style.display = "inline-block";
    recent.forEach((chapNum, idx) => {
        const chip = document.createElement("div");
        chip.className = "recent-chip" + (idx === 0 ? " latest" : "");
        chip.innerHTML = `
            <span class="recent-chip-num">Chapter ${chapNum}</span>
            ${idx === 0 ? `<span class="recent-chip-badge">Last Read</span>` : ""}
        `;
        chip.addEventListener("click", () => {
            switchView("reader");
            loadChapter(chapNum);
        });
        container.appendChild(chip);
    });
}

function switchView(viewName) {
    homeView.classList.remove("active");
    novelView.classList.remove("active");
    readerView.classList.remove("active");
    document.body.classList.remove("reader-mode");

    headerBackGroup.style.display = "none";
    backToNovelBtn.style.display = "none";
    backToLibraryBtn.style.display = "none";

    if (viewName === "home") {
        homeView.classList.add("active");
        renderLibraryGrid();
    } else if (viewName === "novel") {
        novelView.classList.add("active");
        headerBackGroup.style.display = "flex";
        backToLibraryBtn.style.display = "inline-flex";
        renderNovelDetails(activeNovel);
    } else if (viewName === "reader") {
        readerView.classList.add("active");
        document.body.classList.add("reader-mode");
        headerBackGroup.style.display = "flex";
        backToNovelBtn.style.display = "inline-flex";
        backToLibraryBtn.style.display = "inline-flex";
        document.getElementById("reader-novel-kicker").textContent = activeNovel.title;
        applyFontSize();
    }
    window.scrollTo(0, 0);
}

function applyFontSize() {
    contentEl.style.fontSize = `${readerFontSize}px`;
    document.getElementById("font-size-display").textContent = `${readerFontSize}px`;
    localStorage.setItem("readerFontSize", readerFontSize);
}

function renderLibraryGrid() {
    const grid = document.getElementById("novel-grid");
    grid.innerHTML = "";

    for (const novel of NOVELS) {
        const savedChap = localStorage.getItem(`lastRead_${novel.id}`);
        const card = document.createElement("div");
        card.className = "novel-card";
        card.innerHTML = `
            <div class="card-cover-wrap">
                <img id="card-img-${novel.id}" src="${novel.cover}" alt="${novel.title}">
                <div class="card-badge">${novel.type}</div>
                ${savedChap ? `<div class="card-continue">Ch. ${savedChap}</div>` : ""}
            </div>
            <div class="card-body">
                <h3 class="card-title">${novel.title}</h3>
                <div class="card-sub">${novel.author}</div>
            </div>
        `;
        card.addEventListener("click", () => {
            activeNovel = novel;
            switchView("novel");
        });
        grid.appendChild(card);
    }
}

async function fetchCoverAndBounds(novel) {
    const apiBase = getApiBase(novel);
    try {
        const [slugResp, latestResp, oldestResp] = await Promise.all([
            fetch(`${apiBase}slug:${novel.infoSlug}?fields=content,featured_image`),
            fetch(`${apiBase}?number=10&order=DESC&fields=title,content`),
            fetch(`${apiBase}?number=10&order=ASC&fields=title,content`)
        ]);

        if (slugResp.ok) {
            const slugData = await slugResp.json();
            const parser = new DOMParser();
            const doc = parser.parseFromString(slugData.content || "", "text/html");
            const firstImg = doc.querySelector("img");
            if (firstImg && firstImg.src) {
                novel.cover = firstImg.src.split("?")[0];
            } else if (slugData.featured_image) {
                novel.cover = slugData.featured_image;
            }
            const cardImg = document.getElementById(`card-img-${novel.id}`);
            if (cardImg) cardImg.src = novel.cover;
            const detailImg = document.getElementById("detail-cover");
            if (detailImg) detailImg.src = novel.cover;
        }

        const latestData = await latestResp.json();
        const oldestData = await oldestResp.json();

        const latestNums = (latestData.posts || []).map(extractChapterNum).filter(Boolean);
        const oldestNums = (oldestData.posts || []).map(extractChapterNum).filter(Boolean);

        if (latestNums.length > 0) detectedMaxChapter = Math.max(...latestNums);
        if (oldestNums.length > 0) minChapter = Math.min(...oldestNums);
    } catch (err) {
        console.error(err);
    }

    renderNovelChapterList(document.getElementById("novel-chapter-search").value);
    renderDropdownItems("");
    updateNavButtons();
}

function renderNovelDetails(novel) {
    const savedChap = Number(localStorage.getItem(`lastRead_${novel.id}`)) || novel.defaultChapter;
    currentChapter = savedChap;

    document.getElementById("detail-cover").src = novel.cover;
    document.getElementById("detail-title").textContent = novel.title;
    document.getElementById("detail-type").textContent = novel.type;
    document.getElementById("detail-author").textContent = novel.author;
    document.getElementById("detail-status").textContent = novel.status;

    const continueBtn = document.getElementById("continue-reading-btn");
    continueBtn.textContent = localStorage.getItem(`lastRead_${novel.id}`)
        ? `Continue Reading (Chapter ${savedChap})`
        : `Start Reading (Chapter ${savedChap})`;

    const genresEl = document.getElementById("detail-genres");
    genresEl.innerHTML = novel.genres.map(g => `<span class="genre-tag">${g}</span>`).join("");

    const descEl = document.getElementById("detail-description");
    descEl.innerHTML = novel.description.map(p => `<p>${p}</p>`).join("");

    const altEl = document.getElementById("detail-alt-names");
    altEl.innerHTML = novel.associatedNames.map(n => `<li>• ${n}</li>`).join("");

    renderRecentChapters();
    renderNovelChapterList(document.getElementById("novel-chapter-search").value);
}

function renderNovelChapterList(filterText = "") {
    const listEl = document.getElementById("novel-chapter-list");
    const countLabel = document.getElementById("chapter-count-label");
    if (!listEl) return;

    listEl.innerHTML = "";
    const cleanFilter = filterText.replace(/[^0-9]/g, "");
    const upperBound = detectedMaxChapter || 948;
    const lowerBound = minChapter || 1;
    const recentList = getRecentChapters(activeNovel.id);
    const savedChap = Number(localStorage.getItem(`lastRead_${activeNovel.id}`));

    countLabel.textContent = `List of Chapters (${lowerBound} – ${upperBound})`;

    const chapters = [];
    for (let i = lowerBound; i <= upperBound; i++) {
        if (cleanFilter && !String(i).includes(cleanFilter)) continue;
        chapters.push(i);
    }

    if (sortDescending) {
        chapters.reverse();
    }

    const fragment = document.createDocumentFragment();
    for (const chapNum of chapters) {
        const isLast = chapNum === savedChap;
        const isVisited = recentList.includes(chapNum);
        const pill = document.createElement("div");
        pill.className = "chapter-pill" + (isLast ? " last-read" : "");
        pill.innerHTML = `
            <span class="chapter-pill-num">Chapter ${chapNum}</span>
            ${isLast ? `<span class="chapter-pill-tag">LAST</span>` : (isVisited ? `<span class="chapter-pill-tag">READ</span>` : "")}
        `;
        pill.addEventListener("click", () => {
            switchView("reader");
            loadChapter(chapNum);
        });
        fragment.appendChild(pill);
    }
    listEl.appendChild(fragment);
}

function extractChapterNum(post) {
    const titleMatch = (post.title || "").match(/\b(\d{1,4})\b/);
    if (titleMatch) return Number(titleMatch[1]);

    const parser = new DOMParser();
    const doc = parser.parseFromString(post.content || "", "text/html");
    const firstP = doc.querySelector("p");
    if (firstP) {
        const pMatch = firstP.textContent.trim().match(/\b(\d{1,4})\b/);
        if (pMatch) return Number(pMatch[1]);
    }
    return null;
}

function renderDropdownItems(filterText) {
    dropdownMenu.innerHTML = "";
    const cleanFilter = filterText.replace(/[^0-9]/g, "");
    const upperLimit = detectedMaxChapter || maxChapter;

    for (let i = minChapter; i <= upperLimit; i++) {
        if (cleanFilter && !String(i).includes(cleanFilter)) continue;

        const item = document.createElement("div");
        item.className = "dropdown-item" + (i === currentChapter ? " active" : "");
        item.dataset.chapter = i;
        item.textContent = `Chapter ${i}`;
        item.addEventListener("click", () => {
            closeDropdown();
            loadChapter(i);
        });
        dropdownMenu.appendChild(item);
    }
}

function openDropdown() {
    renderDropdownItems("");
    dropdownMenu.classList.add("open");
    const activeItem = dropdownMenu.querySelector(".dropdown-item.active");
    if (activeItem) {
        activeItem.scrollIntoView({ block: "center" });
    }
}

function closeDropdown() {
    dropdownMenu.classList.remove("open");
    chapterInput.value = `Chapter ${currentChapter}`;
}

function updateNavButtons() {
    const atMin = currentChapter <= minChapter;
    const atMax = currentChapter >= maxChapter;
    document.getElementById("prev-top").disabled = atMin;
    document.getElementById("prev-bottom").disabled = atMin;
    document.getElementById("next-top").disabled = atMax;
    document.getElementById("next-bottom").disabled = atMax;
}

async function loadChapter(chapterNum) {
    const num = Number(String(chapterNum).replace(/[^0-9]/g, ""));
    if (!num) return;

    currentChapter = num;
    localStorage.setItem(`lastRead_${activeNovel.id}`, currentChapter);
    addRecentChapter(activeNovel.id, currentChapter);
    chapterInput.value = `Chapter ${currentChapter}`;
    updateNavButtons();

    titleEl.textContent = `Loading Chapter ${currentChapter}...`;
    debugUrlEl.innerHTML = "Fetching chapter from source...";
    contentEl.innerHTML = "";
    window.scrollTo(0, 0);

    try {
        const apiBase = getApiBase(activeNovel);
        const response = await fetch(`${apiBase}?search=${currentChapter}&number=20`);
        const data = await response.json();

        const post = findMatchingPost(data.posts || [], currentChapter);

        if (!post) {
            titleEl.textContent = `Chapter ${currentChapter} Not Found`;
            debugUrlEl.textContent = "No matching source post";
            contentEl.innerHTML = `<p>Could not find a verified match for Chapter ${currentChapter} in search results.</p>`;
            return;
        }

        titleEl.innerHTML = post.title || `Chapter ${currentChapter}`;
        debugUrlEl.innerHTML = `<a href="${post.URL}" target="_blank" rel="noopener">Source: ${post.URL} ↗</a>`;
        contentEl.innerHTML = cleanChapterContent(post.content);

    } catch (err) {
        titleEl.textContent = "Error Loading Chapter";
        contentEl.innerHTML = `<p>${err.message}</p>`;
    }
}

function findMatchingPost(posts, targetNum) {
    const exactRegex = new RegExp(`\\b${targetNum}\\b`);

    for (const post of posts) {
        if (exactRegex.test(post.title)) {
            return post;
        }
    }

    const parser = new DOMParser();
    for (const post of posts) {
        const doc = parser.parseFromString(post.content, "text/html");
        const paragraphs = doc.querySelectorAll("p");
        for (let i = 0; i < Math.min(3, paragraphs.length); i++) {
            const text = paragraphs[i].textContent.trim();
            if (text === String(targetNum) || new RegExp(`^chapter\\s+${targetNum}\\b`, "i").test(text)) {
                return post;
            }
        }
    }

    return null;
}

function cleanChapterContent(rawHtml) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, "text/html");
    const paragraphs = Array.from(doc.querySelectorAll("p"));

    const cutPatterns = [
        /\[?\s*T\/L\s*:/i,
        /ko-fi/i,
        /buymeacoffee/i,
        /previous\s+chapter/i,
        /next\s+chapter/i
    ];

    const cleanedHtml = [];

    for (const p of paragraphs) {
        const text = p.textContent.trim();
        if (!text) continue;

        const shouldCut = cutPatterns.some(pattern => pattern.test(text));
        if (shouldCut) continue;

        for (const a of p.querySelectorAll("a")) {
            a.remove();
        }

        if (p.textContent.trim()) {
            cleanedHtml.push(`<p>${p.innerHTML}</p>`);
        }
    }

    return cleanedHtml.join("");
}

document.getElementById("nav-home").addEventListener("click", () => switchView("home"));
backToLibraryBtn.addEventListener("click", () => switchView("home"));
backToNovelBtn.addEventListener("click", () => switchView("novel"));

document.getElementById("clear-recent-btn").addEventListener("click", () => {
    localStorage.removeItem(`recentChapters_${activeNovel.id}`);
    renderRecentChapters();
    renderNovelChapterList(document.getElementById("novel-chapter-search").value);
});

document.getElementById("continue-reading-btn").addEventListener("click", () => {
    switchView("reader");
    loadChapter(currentChapter);
});

document.getElementById("novel-chapter-search").addEventListener("input", (e) => {
    renderNovelChapterList(e.target.value);
});

document.getElementById("sort-toggle-btn").addEventListener("click", (e) => {
    sortDescending = !sortDescending;
    e.target.textContent = sortDescending ? "Sort: Newest ↓" : "Sort: Oldest ↑";
    renderNovelChapterList(document.getElementById("novel-chapter-search").value);
});

document.getElementById("font-dec").addEventListener("click", () => {
    if (readerFontSize > 14) {
        readerFontSize -= 2;
        applyFontSize();
    }
});

document.getElementById("font-inc").addEventListener("click", () => {
    if (readerFontSize < 32) {
        readerFontSize += 2;
        applyFontSize();
    }
});

chapterInput.addEventListener("focus", () => {
    chapterInput.value = "";
    openDropdown();
});

chapterInput.addEventListener("input", () => {
    dropdownMenu.classList.add("open");
    renderDropdownItems(chapterInput.value);
});

chapterInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        const val = chapterInput.value.trim();
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
    if (!readerView.classList.contains("active")) return;
    if (document.activeElement === chapterInput) return;
    if (e.key === "ArrowLeft" && currentChapter > minChapter) {
        loadChapter(currentChapter - 1);
    } else if (e.key === "ArrowRight" && currentChapter < maxChapter) {
        loadChapter(currentChapter + 1);
    }
});

window.addEventListener("scroll", () => {
    if (!readerView.classList.contains("active")) return;
    const scrollTop = window.scrollY;
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const pct = docHeight > 0 ? Math.min(100, Math.max(0, (scrollTop / docHeight) * 100)) : 0;
    progressBar.style.width = `${pct}%`;
});

document.getElementById("prev-top").addEventListener("click", () => loadChapter(currentChapter - 1));
document.getElementById("next-top").addEventListener("click", () => loadChapter(currentChapter + 1));
document.getElementById("prev-bottom").addEventListener("click", () => loadChapter(currentChapter - 1));
document.getElementById("next-bottom").addEventListener("click", () => loadChapter(currentChapter + 1));

renderLibraryGrid();
fetchCoverAndBounds(activeNovel);