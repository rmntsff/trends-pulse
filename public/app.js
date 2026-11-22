// Trends Pulse — клієнт Telegram Mini App. Дизайн за макетами Google Stitch, дані — лише справжні.
// Увесь текст із мережі вставляється через textContent (жодного innerHTML із даними).
import { ICONS, ICON_VIEWBOX } from "./icons.js";

const tg = window.Telegram?.WebApp;
const inTelegram = Boolean(tg?.initData);
const $ = (id) => document.getElementById(id);

const REGIONS = {
  UA: ["🇺🇦", "Україна", "в Україні"], US: ["🇺🇸", "США", "у США"], GB: ["🇬🇧", "Велика Британія", "у Великій Британії", "Британія"],
  DE: ["🇩🇪", "Німеччина", "у Німеччині"], PL: ["🇵🇱", "Польща", "у Польщі"], FR: ["🇫🇷", "Франція", "у Франції"],
  CA: ["🇨🇦", "Канада", "у Канаді"], JP: ["🇯🇵", "Японія", "в Японії"], IT: ["🇮🇹", "Італія", "в Італії"], ES: ["🇪🇸", "Іспанія", "в Іспанії"],
};
const EXPLORE_CHOICES = Object.keys(REGIONS).filter((code) => code !== "UA" && code !== "US");
const LANGUAGES = { uk: "Українська", en: "English" };
const LOAD_ERRORS = {
  network: "Немає з'єднання з Google Trends. Спробуйте трохи згодом.",
  http: "Google Trends тимчасово не відповідає. Спробуйте трохи згодом.",
  parse: "Google Trends повернув дані в неочікуваному форматі.",
  offline: "Немає з'єднання із сервером. Перевірте Інтернет.",
};
const AI_FAILURES = {
  rate_limited: "ліміт запитів Gemini", invalid_key: "ключ Gemini недійсний", model_not_found: "модель Gemini не знайдена",
  network: "немає зв'язку з Gemini", blocked: "Gemini відмовився відповідати", bad_response: "Gemini не дав відповіді",
  server: "сервер Gemini недоступний",
};
const NO_CONTEXT = "Google Trends не додав новин до цього запиту.";
const FEEDS = ["ukraine", "usa", "explore"];
const LIMITS = { ukraine: 5, usa: 5, explore: 10 };

// ---------- Налаштування (зберігаються на пристрої) ----------
function loadSettings() {
  const defaults = { exploreRegion: "GB", language: "uk", autoExplain: true, mode: "ai" };
  try {
    const saved = JSON.parse(localStorage.getItem("settings") ?? "{}");
    return {
      exploreRegion: EXPLORE_CHOICES.includes(saved.exploreRegion) ? saved.exploreRegion : defaults.exploreRegion,
      language: saved.language in LANGUAGES ? saved.language : defaults.language,
      autoExplain: typeof saved.autoExplain === "boolean" ? saved.autoExplain : defaults.autoExplain,
      mode: saved.mode === "headlines" ? "headlines" : "ai",
    };
  } catch {
    return defaults;
  }
}
function saveSettings() {
  try { localStorage.setItem("settings", JSON.stringify(state.settings)); } catch { /* приватний режим */ }
}

// ---------- Стан ----------
const settings = loadSettings();
const state = {
  settings,
  screen: "feed", // feed | detail | settings
  selected: "ukraine",
  detail: null, // { feed, key }
  feedScroll: 0,
  sections: { ukraine: newSection("UA"), usa: newSection("US"), explore: newSection(settings.exploreRegion) },
  /** `${lang}|${trendKey}` -> { status: 'loading' } | { status: 'ai', text, model } | { status: 'failed', reason, detail } */
  explanations: new Map(),
  ai: { enabled: false, model: "", fallbacks: [] },
  serverOnline: null,
  lastAiError: null,
  blocked: null, // { kind: 'not_telegram' | 'not_allowed' | 'misconfigured', userId }
  refreshing: false,
};
function newSection(region) {
  return { region, status: "loading", error: null, trends: [], updatedAt: null, token: 0 };
}
const keyFor = (trend, language = state.settings.language) => `${language}|${trend.key}`;
const explanationOf = (trend) => state.explanations.get(keyFor(trend));

// ---------- API ----------
class ApiError extends Error {
  constructor(status, data) { super(data?.error ?? `HTTP ${status}`); this.status = status; this.data = data ?? {}; }
}
async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), Authorization: `tma ${tg?.initData ?? ""}` },
    });
  } catch {
    state.serverOnline = false;
    throw new ApiError(0, { error: "offline" });
  }
  state.serverOnline = true;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data);
  return data;
}
function handleAuthError(error) {
  if (error.status === 403) state.blocked = { kind: "not_allowed", userId: error.data.userId };
  else if (error.status === 401) state.blocked = { kind: error.data.error === "server_misconfigured" ? "misconfigured" : "not_telegram" };
  else return false;
  render();
  return true;
}

// ---------- Завантаження ----------
async function loadSection(feed, { refresh = false } = {}) {
  const section = state.sections[feed];
  const token = ++section.token; // новіший запит робить старіші відповіді неактуальними
  section.status = "loading";
  render();
  try {
    const params = new URLSearchParams({ geo: section.region, limit: LIMITS[feed], ...(refresh ? { refresh: "1" } : {}) });
    const data = await api(`/api/trends?${params}`);
    if (section.token !== token) return;
    Object.assign(section, { status: "loaded", error: null, trends: data.trends, updatedAt: data.updatedAtMillis });
    state.ai = { fallbacks: [], ...data.ai };
    render();
    if (state.settings.autoExplain) await explain(feed);
  } catch (error) {
    if (section.token !== token || handleAuthError(error)) return;
    Object.assign(section, { status: "failed", error: error.status === 0 ? "offline" : (error.data.reason ?? "http") });
    render();
  }
}

async function refreshAll() {
  if (state.refreshing) return;
  state.refreshing = true;
  render();
  await Promise.all(FEEDS.map((feed) => loadSection(feed, { refresh: true })));
  state.refreshing = false;
  render();
}

/** Пояснення для вкладки або одного тренду (`only`: тоді кеш сервера оминається). */
async function explain(feed, only = null) {
  if (!state.ai.enabled) return;
  const section = state.sections[feed];
  const language = state.settings.language;
  const targets = only ? [only] : section.trends.filter((trend) => state.explanations.get(keyFor(trend, language))?.status !== "ai");
  if (targets.length === 0) return;

  for (const trend of targets) state.explanations.set(keyFor(trend, language), { status: "loading" });
  render();
  let results = {};
  let failure = null;
  try {
    const body = { geo: section.region, lang: language, keys: targets.map((t) => t.key), force: Boolean(only) };
    results = (await api("/api/explain", { method: "POST", body: JSON.stringify(body) })).explanations ?? {};
  } catch (error) {
    if (handleAuthError(error)) return;
    failure = { status: "failed", reason: "network", detail: error.status === 0 ? "Немає з'єднання із сервером" : `Сервер: ${error.message}` };
  }
  let anySuccess = false;
  let detail = null;
  for (const trend of targets) {
    const result = results[trend.key] ?? failure ?? { status: "failed", reason: "bad_response", detail: null };
    state.explanations.set(keyFor(trend, language), result);
    if (result.status === "ai") anySuccess = true;
    else detail ??= result.detail;
  }
  if (anySuccess) state.lastAiError = null;
  else if (detail) state.lastAiError = detail;
  render();
}

// ---------- Допоміжне ----------
const SVG_NS = "http://www.w3.org/2000/svg";
function icon(name, size = "") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", ICON_VIEWBOX);
  svg.setAttribute("class", `icon ${size}`.trim());
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name === "class") node.className = value;
    else if (name === "text") node.textContent = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(name, value === true ? "" : value);
  }
  node.append(...children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== ""));
  return node;
}
function relativeTime(millis) {
  const minutes = Math.max(0, Math.floor((Date.now() - millis) / 60_000));
  if (minutes < 1) return "щойно";
  if (minutes < 60) return `${minutes} хв тому`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} год тому`;
  return `${Math.floor(minutes / (24 * 60))} дн тому`;
}
const clock = (millis) => new Date(millis).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
const shortModel = (model) => (model ?? "").replace(/^gemini-/, "");
const traffic = (trend) => (trend.approxTraffic ? `${trend.approxTraffic} запитів` : "сплеск запитів");

function newsContext(trend) {
  const news = trend.news[0];
  if (!news) return null;
  if (news.snippet && news.snippet.toLowerCase() !== news.title.toLowerCase()) return `${news.title.replace(/\.$/, "")}. ${news.snippet}`;
  return news.title || null;
}
function isSafeUrl(url) {
  try { return ["https:", "http:"].includes(new URL(url).protocol); } catch { return false; }
}
function openUrl(url) {
  if (!isSafeUrl(url)) return;
  if (inTelegram && tg.openLink) tg.openLink(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
function shareTrend(trend) {
  const explanation = explanationOf(trend);
  const context = explanation?.status === "ai" ? explanation.text : (newsContext(trend) ?? "");
  const text = `${trend.title} — тренд Google ${REGIONS[trend.region][2]}\n${context}`.trim();
  const link = `https://t.me/share/url?url=${encodeURIComponent(trend.openUrl)}&text=${encodeURIComponent(text)}`;
  if (inTelegram && tg.openTelegramLink) tg.openTelegramLink(link);
  else if (navigator.share) navigator.share({ text, url: trend.openUrl }).catch(() => {});
  else window.open(link, "_blank", "noopener,noreferrer");
}
async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast("Не вдалося скопіювати", "close");
  }
}
let toastTimer = 0;
function toast(text, iconName = "check") {
  const node = $("toast");
  node.replaceChildren(icon(iconName, "sm"), el("span", { text }));
  node.classList.add("show");
  tg?.HapticFeedback?.notificationOccurred?.(iconName === "check" ? "success" : "error");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 2200);
}
const haptic = () => tg?.HapticFeedback?.selectionChanged?.();

// ---------- Навігація ----------
function go(screen, detail = null) {
  if (state.screen === "feed") state.feedScroll = window.scrollY;
  state.screen = screen;
  state.detail = detail;
  haptic();
  render();
  window.scrollTo({ top: screen === "feed" ? state.feedScroll : 0 });
}
const back = () => go("feed");

// ---------- Стрічка ----------
function renderExplanationBox(trend) {
  const explanation = explanationOf(trend);
  const mode = state.settings.mode;
  const context = newsContext(trend);

  if (mode === "headlines" || !state.ai.enabled) {
    return el("div", { class: "ai-box" },
      el("div", { class: "ai-label" }, el("span", {}, icon("news", "xs"), "Заголовок новини")),
      el("p", { class: "ai-text", text: context ?? NO_CONTEXT }));
  }
  if (explanation?.status === "ai") {
    return el("div", { class: "ai-box ai" },
      el("div", { class: "ai-label" }, el("span", {}, icon("spark", "xs"), "Пояснення Gemini"), el("span", { class: "model-tag", text: shortModel(explanation.model) })),
      el("p", { class: "ai-text", text: explanation.text }));
  }
  if (explanation?.status === "loading") {
    return el("div", { class: "ai-box ai" },
      el("div", { class: "ai-label" }, el("span", {}, el("span", { class: "spinner", "aria-hidden": "true" }), "Gemini готує пояснення…")),
      el("p", { class: "ai-text pending", text: context ?? NO_CONTEXT }));
  }
  const label = explanation?.status === "failed" ? `З новин · ${AI_FAILURES[explanation.reason] ?? "помилка Gemini"}` : "З новин";
  return el("div", { class: "ai-box" },
    el("div", { class: "ai-label" }, el("span", {}, icon("news", "xs"), label)),
    el("p", { class: "ai-text", text: context ?? NO_CONTEXT }));
}

function renderCard(trend, feed) {
  const open = () => go("detail", { feed, key: trend.key });
  const source = trend.news[0]?.source;
  return el("article", {
    class: "card tappable", tabindex: "0", "aria-label": `${trend.rank}. ${trend.title}. Відкрити деталі`,
    onclick: open, onkeydown: (event) => { if (event.key === "Enter" && event.target === event.currentTarget) open(); },
  },
    el("div", { class: "card-head" },
      el("span", { class: `rank${trend.rank === 1 ? " top" : ""}`, text: String(trend.rank), "aria-hidden": "true" }),
      el("div", { class: "card-title" },
        el("h2", { text: trend.title }),
        el("p", { class: "metrics" },
          el("span", { class: "up" }, icon("trending", "xs"), traffic(trend)),
          trend.publishedAtMillis && el("span", { text: `· ${relativeTime(trend.publishedAtMillis)}` }))),
      el("button", {
        class: "icon-btn", type: "button", "aria-label": `Поділитися: ${trend.title}`,
        onclick: (event) => { event.stopPropagation(); shareTrend(trend); },
      }, icon("send"))),
    renderExplanationBox(trend),
    el("div", { class: "card-foot" },
      source
        ? el("button", {
          class: "source", type: "button", "aria-label": `Відкрити новину: ${source}`,
          onclick: (event) => { event.stopPropagation(); openUrl(trend.openUrl); },
        }, icon("news", "sm"), el("span", { text: source }))
        : el("span", { class: "source" }, icon("globe", "sm"), el("span", { text: "Google Trends" })),
      el("span", { class: "pill-btn", "aria-hidden": "true" }, "Деталі", icon("forward", "xs"))));
}

function renderSkeleton() {
  return el("div", { class: "feed skeleton", "aria-busy": "true", "aria-label": "Завантаження" },
    [0, 1, 2].map(() => el("div", { class: "card" },
      el("div", { class: "bone w60" }), el("div", { class: "bone w30" }), el("div", { class: "bone" }), el("div", { class: "bone w80" }))));
}

function message(iconName, title, text, ...extra) {
  return el("div", { class: "message" },
    el("div", { class: "big-icon" }, icon(iconName)),
    el("h2", { text: title }),
    el("p", { text }),
    ...extra);
}

function renderFeed() {
  const feed = state.selected;
  const section = state.sections[feed];

  const controls = el("div", { class: "controls" },
    el("div", { class: "region-row" },
      el("div", { class: "chips-scroll", role: "tablist", "aria-label": "Країна" },
        FEEDS.map((f) => {
          const [flag, name, , short] = REGIONS[state.sections[f].region];
          return el("button", {
            class: "region-chip", type: "button", role: "tab", "aria-selected": String(f === feed),
            onclick: () => { state.selected = f; haptic(); render(); window.scrollTo({ top: 0 }); },
          }, el("span", { text: flag, "aria-hidden": "true" }), short ?? name);
        }),
        el("button", { class: "round-btn", type: "button", "aria-label": "Обрати іншу країну", onclick: openRegionSheet }, icon("globe", "sm")))),
    state.ai.enabled && el("div", { class: "mode-bar" },
      el("div", { class: "segmented", role: "group", "aria-label": "Що показувати під трендом" },
        el("button", { class: "segment", type: "button", "aria-pressed": String(state.settings.mode === "ai"), onclick: () => setMode("ai") }, icon("spark", "sm"), "Пояснення"),
        el("button", { class: "segment", type: "button", "aria-pressed": String(state.settings.mode === "headlines"), onclick: () => setMode("headlines") }, icon("news", "sm"), "Заголовки")),
      el("span", { class: "model-status" }, el("span", { class: "dot", "aria-hidden": "true" }), `${shortModel(state.ai.model)} · кеш`)));

  if (section.trends.length === 0 && section.status === "loading") return [controls, renderSkeleton()];
  if (section.trends.length === 0 && section.status === "failed") {
    return [controls, message("offline", "Не вдалося завантажити тренди", LOAD_ERRORS[section.error] ?? LOAD_ERRORS.http,
      el("button", { class: "cta", type: "button", onclick: () => loadSection(feed) }, "Спробувати знову"))];
  }
  return [
    controls,
    section.status === "failed" && el("div", { class: "banner", role: "status" },
      el("span", { text: "Не вдалося оновити — показано попередні дані." }),
      el("button", { type: "button", onclick: () => loadSection(feed) }, "Повторити")),
    section.trends.length === 0
      ? message("inbox", "Трендів немає", "Google Trends зараз не повертає трендів для цієї країни.")
      : el("div", { class: "feed" }, section.trends.map((trend) => renderCard(trend, feed))),
    el("p", { class: "feed-footer" }, el("span", { class: "live-dot", "aria-hidden": "true" }), "Дані: публічний RSS Google Trends · кеш 5 хв"),
  ];
}

function setMode(mode) {
  if (state.settings.mode === mode) return;
  state.settings.mode = mode;
  saveSettings();
  haptic();
  render();
}

// ---------- Деталі ----------
function renderDetail() {
  const { feed, key } = state.detail;
  const section = state.sections[feed];
  const trend = section.trends.find((t) => t.key === key);
  if (!trend) {
    return message("inbox", "Тренд більше не в списку", "Список оновився, і цього запиту в ньому вже немає.",
      el("button", { class: "cta", type: "button", onclick: back }, "До трендів"));
  }
  const explanation = explanationOf(trend);
  const context = newsContext(trend);
  const [flag] = REGIONS[trend.region];

  let why;
  if (!state.ai.enabled) {
    why = el("div", { class: "section" },
      el("h3", {}, icon("news", "sm"), "З новин"),
      el("p", { text: context ?? NO_CONTEXT }),
      el("p", { class: "note", text: "На сервері не задано ключ Gemini, тому показано заголовок новини." }));
  } else if (explanation?.status === "ai") {
    why = el("div", { class: "section" }, el("h3", {}, icon("spark", "sm"), "Чому це в тренді?"), el("p", { text: explanation.text }));
  } else if (explanation?.status === "loading") {
    why = el("div", { class: "section" }, el("h3", {}, el("span", { class: "spinner", "aria-hidden": "true" }), "Gemini готує пояснення…"), el("p", { class: "pending", text: context ?? NO_CONTEXT }));
  } else {
    why = el("div", { class: "section" },
      el("h3", {}, icon("news", "sm"), "З новин"),
      el("p", { text: context ?? NO_CONTEXT }),
      explanation?.status === "failed" && el("p", { class: "note", text: `Gemini не відповів: ${AI_FAILURES[explanation.reason] ?? "помилка"}. Спробуйте «Пояснити ще раз».` }));
  }

  const aiText = explanation?.status === "ai" ? explanation.text : null;
  const module = el("section", { class: "module", "aria-label": "Пояснення" },
    el("div", { class: "module-head" },
      el("div", { class: "tile", "aria-hidden": "true" }, icon("spark", "sm")),
      el("div", {},
        el("h2", { text: "Аналіз Gemini AI" }),
        el("p", { text: aiText ? `Модель: ${explanation.model}` : state.ai.enabled ? `Модель: ${state.ai.model}` : "Gemini вимкнено" }))),
    why,
    trend.news.length > 1 && el("div", { class: "section" },
      el("h3", {}, icon("news", "sm"), "Ключовий контекст"),
      el("p", { text: trend.news.slice(1).map((n) => n.title).join(" · ") })),
    el("div", { class: "module-foot" },
      el("span", { text: aiText ? "Згенеровано за заголовками новин" : "Джерело: Google Trends RSS" }),
      aiText && el("button", { class: "link-btn", type: "button", onclick: () => copyText(aiText, "Пояснення скопійовано") }, icon("copy", "sm"), "Скопіювати")));

  const news = trend.news.length > 0
    ? [
      el("div", { class: "list-title" },
        el("h2", {}, icon("news", "sm"), "Першоджерела"),
        el("span", { text: `${trend.news.length} ${trend.news.length === 1 ? "матеріал" : "матеріали"}` })),
      trend.news.map((article) => {
        const name = article.source || "Новина";
        const body = [
          el("div", { class: "article-head" },
            el("span", { class: "avatar", text: name.slice(0, 1).toUpperCase(), "aria-hidden": "true" }),
            el("span", { class: "name", text: name }),
            article.url && icon("external", "sm")),
          el("p", { text: article.title || article.snippet }),
        ];
        return article.url
          ? el("a", { class: "article", href: article.url, onclick: (event) => { event.preventDefault(); openUrl(article.url); } }, body)
          : el("div", { class: "article" }, body);
      }),
    ]
    : [];

  return [
    el("div", { class: "detail-top" },
      el("button", { class: "back-pill", type: "button", onclick: back }, icon("back", "sm"), "Назад до трендів")),
    el("div", { class: "badges" },
      el("span", { class: "badge rank-badge", text: `#${trend.rank} ${REGIONS[trend.region][2]} ${flag}` }),
      el("span", { class: "badge traffic" }, icon("trending", "xs"), traffic(trend)),
      trend.publishedAtMillis && el("span", { class: "badge" }, icon("schedule", "xs"), `почався ${relativeTime(trend.publishedAtMillis)}`)),
    el("div", { class: "detail-hero" },
      el("h1", { text: trend.title }),
      trend.imageUrl && isSafeUrl(trend.imageUrl) && el("img", { src: trend.imageUrl, alt: "", loading: "lazy", referrerpolicy: "no-referrer", onerror: (event) => event.target.remove() })),
    module,
    ...news,
    el("div", { class: "actions" },
      el("button", { class: "cta", type: "button", onclick: () => shareTrend(trend) }, icon("send", "sm"), "Поділитися"),
      state.ai.enabled && el("button", {
        class: "square-btn", type: "button", "aria-label": aiText ? "Пояснити ще раз" : "Пояснити з Gemini",
        disabled: explanation?.status === "loading", onclick: () => explain(feed, trend),
      }, icon("regenerate"))),
    el("button", { class: "secondary-btn", type: "button", onclick: () => openUrl(trend.searchUrl) }, icon("search", "sm"), "Шукати в Google"),
  ];
}

// ---------- Налаштування ----------
function renderSettings() {
  const user = tg?.initDataUnsafe?.user;
  const ua = state.sections.ukraine;
  const profile = el("section", { class: "panel" },
    el("div", { class: "panel-head" },
      el("div", {},
        el("p", { class: "kicker", text: "Профіль Telegram" }),
        el("div", { class: "id-row" },
          el("span", { class: "mono", text: user ? `ID: ${user.id}` : "ID недоступний" }),
          user && el("button", { class: "small-btn", type: "button", "aria-label": "Скопіювати ID", onclick: () => copyText(String(user.id), `ID ${user.id} скопійовано`) }, icon("copy", "sm")))),
      el("span", { class: "tag ok" }, icon("check", "xs"), "Доступ є")),
    el("p", { class: "note-text", text: "Доступ надається за запрошенням: власник бота додає ваш ID до списку." }));

  const prefs = el("section", { class: "panel" },
    el("div", { class: "panel-head" }, el("h2", {}, icon("settings", "sm"), "Стрічка")),
    el("button", { class: "row", type: "button", onclick: openRegionSheet },
      el("span", { class: "row-text" }, el("strong", { text: "Третя вкладка" }), el("small", { text: "Країна поруч з Україною та США" })),
      el("span", { class: "row-value" }, `${REGIONS[state.settings.exploreRegion][0]} ${REGIONS[state.settings.exploreRegion][1]}`, icon("forward", "xs"))),
    el("div", { class: "row" },
      el("span", { class: "row-text" }, el("strong", { text: "Мова пояснень" }), el("small", { text: "Якою мовою пише Gemini" })),
      el("span", { class: "mini-seg", role: "group", "aria-label": "Мова пояснень" },
        Object.entries(LANGUAGES).map(([code, label]) => el("button", {
          type: "button", "aria-pressed": String(state.settings.language === code), onclick: () => setLanguage(code),
        }, code === "uk" ? "UA" : "EN", el("span", { class: "sr-only", text: label }))))),
    el("label", { class: "row" },
      el("span", { class: "row-text" },
        el("strong", { text: "Пояснювати автоматично" }),
        el("small", { text: state.ai.enabled ? "Gemini пише 1–2 речення до кожного тренду" : "На сервері не задано ключ Gemini" })),
      el("span", { class: "switch" },
        el("input", { type: "checkbox", role: "switch", checked: state.settings.autoExplain && state.ai.enabled, disabled: !state.ai.enabled, onchange: (event) => setAutoExplain(event.target.checked) }),
        el("span", { "aria-hidden": "true" }))));

  const ai = el("section", { class: "panel" },
    el("div", { class: "panel-head" },
      el("h2", {}, icon("brain", "sm"), "Конфігурація ШІ"),
      el("span", { class: state.ai.enabled ? "tag" : "tag warn", text: state.ai.enabled ? "Gemini API" : "Вимкнено" })),
    el("div", { class: "box" },
      el("div", { class: "kv" }, el("span", { text: "Основна модель" }), state.ai.enabled ? el("span", { class: "tag ok", text: "активна" }) : el("span", { class: "tag warn", text: "немає ключа" })),
      el("p", { class: "mono model-name", text: state.ai.model || "—" })),
    state.ai.fallbacks.length > 0 && el("div", { class: "box" },
      el("div", { class: "kv" }, el("span", { text: "Резервні моделі (якщо основна перевантажена)" })),
      el("div", { class: "model-chips" }, state.ai.fallbacks.map((m) => el("span", { class: "model-chip" }, icon("route", "xs"), m)))),
    el("div", { class: "box" },
      el("div", { class: "kv" }, el("span", {}, icon("cloud", "sm"), "Сервер"), el("b", { text: state.serverOnline === false ? "недоступний" : state.serverOnline ? "онлайн" : "—" })),
      el("div", { class: "kv" }, el("span", {}, icon("cached", "sm"), "Тренди оновлено"), el("b", { text: ua.updatedAt ? `${relativeTime(ua.updatedAt)} (кеш 5 хв)` : "—" }))));

  const tools = el("section", { "aria-label": "Діагностика" },
    el("p", { class: "kicker tools-title", text: "Діагностика" }),
    el("button", { class: "tool", type: "button", onclick: checkConnection },
      icon("ping"),
      el("span", { class: "row-text" }, el("strong", { text: "Перевірити з'єднання" }), el("small", { text: "Запит до сервера й Google Trends" })),
      icon("forward", "sm")),
    el("button", { class: "tool", type: "button", onclick: openAiLog },
      icon("terminal"),
      el("span", { class: "row-text" }, el("strong", { text: "Остання відповідь Gemini" }), el("small", { text: state.lastAiError ? "Є помилка — натисніть, щоб побачити" : "Помилок не було" })),
      icon("forward", "sm")),
    el("p", { class: "note-text", text: "Google Trends RSS публікує лише поточні тренди (приблизно за добу) для всієї країни. Періоду, категорій і демографії в цьому джерелі немає." }));

  return [profile, prefs, ai, tools];
}

function setLanguage(code) {
  if (state.settings.language === code) return;
  state.settings.language = code;
  saveSettings();
  haptic();
  render();
  if (state.settings.autoExplain) for (const feed of FEEDS) if (state.sections[feed].status === "loaded") explain(feed);
}
function setAutoExplain(on) {
  state.settings.autoExplain = on;
  saveSettings();
  haptic();
  render();
  if (on) for (const feed of FEEDS) if (state.sections[feed].status === "loaded") explain(feed);
}
async function checkConnection() {
  const started = performance.now();
  try {
    await api(`/api/trends?geo=UA&limit=1`);
    toast(`Сервер відповів за ${Math.round(performance.now() - started)} мс`);
  } catch (error) {
    if (handleAuthError(error)) return;
    toast(error.status === 0 ? "Немає з'єднання із сервером" : "Google Trends не відповідає", "close");
  }
  render();
}

// ---------- Панелі ----------
function showSheet(dialog) {
  dialog.showModal();
  haptic();
}
for (const dialog of document.querySelectorAll("dialog")) {
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.querySelector("[data-close]")?.addEventListener("click", () => dialog.close());
}
function openRegionSheet() {
  $("region-options").replaceChildren(...EXPLORE_CHOICES.map((code) => el("button", {
    class: "region-chip", type: "button", role: "radio", "aria-checked": String(state.settings.exploreRegion === code),
    "aria-selected": String(state.settings.exploreRegion === code),
    onclick: () => { $("sheet-region").close(); setExploreRegion(code); },
  }, el("span", { text: REGIONS[code][0], "aria-hidden": "true" }), REGIONS[code][1])));
  showSheet($("sheet-region"));
}
function setExploreRegion(code) {
  if (state.settings.exploreRegion !== code) {
    state.settings.exploreRegion = code;
    saveSettings();
    state.sections.explore = newSection(code);
    loadSection("explore");
  }
  state.selected = "explore";
  if (state.screen !== "settings") go("feed");
  else render();
}
function openAiLog() {
  $("ai-log").textContent = state.lastAiError ?? "Помилок не було: остання відповідь Gemini успішна або запитів ще не було.";
  showSheet($("sheet-ai-log"));
}

// ---------- Рендер ----------
function renderBlocked() {
  const { kind, userId } = state.blocked;
  if (kind === "not_allowed") {
    return message("lock", "Немає доступу", "Надішліть цей номер власнику бота, щоб він додав вас до списку:",
      el("p", {}, el("span", { class: "mono", text: String(userId) })),
      el("button", { class: "cta", type: "button", onclick: () => copyText(String(userId), "Номер скопійовано") }, icon("copy", "sm"), "Скопіювати"));
  }
  if (kind === "misconfigured") {
    return message("settings", "Сервер не налаштовано", "Власнику: задайте секрет BOT_TOKEN у Cloudflare (Settings → Variables and Secrets).");
  }
  return message("send", "Відкрийте в Telegram", "Цей застосунок працює лише всередині Telegram: відкрийте його через кнопку бота.");
}

function renderNav() {
  const items = [["feed", "fire", "Тренди"], ["settings", "settings", "Налаштування"]];
  $("nav").replaceChildren(...items.map(([screen, iconName, label]) => el("button", {
    class: "nav-item", type: "button", "aria-current": state.screen === screen ? "page" : null,
    onclick: () => { if (state.screen !== screen) go(screen); else window.scrollTo({ top: 0, behavior: "smooth" }); },
  }, icon(iconName), label)));
}

function render() {
  const blocked = Boolean(state.blocked);
  const screen = blocked ? "blocked" : state.screen;
  const section = state.sections[state.selected];

  $("screen-title").textContent = screen === "detail" ? "Деталі тренду" : screen === "settings" ? "Налаштування" : "Trends Pulse";
  const sub = blocked ? "" : screen === "settings" ? "Доступ і конфігурація"
    : screen === "detail" ? REGIONS[state.sections[state.detail.feed].region].slice(0, 2).join(" ")
      : section.updatedAt ? `Оновлено о ${clock(section.updatedAt)}` : "Завантаження…";
  $("screen-sub").textContent = sub;
  $("status-dot").className = `live-dot${screen === "feed" ? " pulse" : ""}`;
  $("status-dot").hidden = !sub;
  const sync = $("sync");
  sync.hidden = screen !== "feed";
  sync.classList.toggle("spinning", state.refreshing);
  sync.lastElementChild.textContent = state.refreshing ? "Оновлення…" : section.updatedAt ? relativeTime(section.updatedAt) : "Оновити";

  const showNav = !blocked && screen !== "detail";
  $("nav").hidden = !showNav;
  document.body.classList.toggle("no-nav", !showNav);
  if (showNav) renderNav();

  if (tg?.BackButton) {
    if (screen === "detail") tg.BackButton.show();
    else tg.BackButton.hide();
  }

  const content = screen === "blocked" ? renderBlocked() : screen === "detail" ? renderDetail() : screen === "settings" ? renderSettings() : renderFeed();
  $("content").replaceChildren(...[content].flat(Infinity).filter(Boolean));
}

// ---------- Запуск ----------
function applyTheme() {
  const dark = inTelegram ? tg.colorScheme !== "light" : !window.matchMedia("(prefers-color-scheme: light)").matches;
  document.documentElement.classList.toggle("light", !dark);
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  try { tg?.setHeaderColor?.(bg); tg?.setBackgroundColor?.(bg); tg?.setBottomBarColor?.(bg); } catch { /* старий клієнт Telegram */ }
}
$("sync").prepend(icon("sync", "xs"));
$("sync").addEventListener("click", refreshAll);
tg?.ready?.();
tg?.expand?.();
tg?.onEvent?.("themeChanged", applyTheme);
tg?.BackButton?.onClick?.(back);
window.matchMedia("(prefers-color-scheme: light)").addEventListener?.("change", () => { if (!inTelegram) applyTheme(); });
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && state.screen === "detail" && !document.querySelector("dialog[open]")) back(); });
applyTheme();
render();
for (const feed of FEEDS) loadSection(feed);
// "5 хв тому" не має застигати.
setInterval(() => { if (!document.hidden && !document.querySelector("dialog[open]")) render(); }, 60_000);
