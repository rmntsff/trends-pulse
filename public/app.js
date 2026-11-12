// Trends Pulse — клієнт Telegram Mini App. Без фреймворків і без етапу збірки.
// Увесь текст із мережі вставляється лише через textContent (жодного innerHTML із даними).

const tg = window.Telegram?.WebApp;
const $ = (id) => document.getElementById(id);

const REGIONS = {
  UA: ["🇺🇦", "Україна"], US: ["🇺🇸", "США"], GB: ["🇬🇧", "Велика Британія"], DE: ["🇩🇪", "Німеччина"],
  PL: ["🇵🇱", "Польща"], FR: ["🇫🇷", "Франція"], CA: ["🇨🇦", "Канада"], JP: ["🇯🇵", "Японія"],
  IT: ["🇮🇹", "Італія"], ES: ["🇪🇸", "Іспанія"],
};
const EXPLORE_CHOICES = Object.keys(REGIONS).filter((code) => code !== "UA" && code !== "US");
const LANGUAGES = { uk: "🇺🇦 Українська", en: "🇬🇧 English" };
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
  const defaults = { exploreRegion: "GB", language: "uk", autoExplain: true };
  try {
    const saved = JSON.parse(localStorage.getItem("settings") ?? "{}");
    return {
      exploreRegion: EXPLORE_CHOICES.includes(saved.exploreRegion) ? saved.exploreRegion : defaults.exploreRegion,
      language: saved.language in LANGUAGES ? saved.language : defaults.language,
      autoExplain: typeof saved.autoExplain === "boolean" ? saved.autoExplain : defaults.autoExplain,
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
  selected: "ukraine",
  query: "",
  /** feed -> { region, status: 'loading'|'loaded'|'failed', error, trends, updatedAt, token } */
  sections: {
    ukraine: newSection("UA"),
    usa: newSection("US"),
    explore: newSection(settings.exploreRegion),
  },
  /** `${lang}|${trendKey}` -> { status: 'loading' } | { status: 'ai', text, model } | { status: 'failed', reason, detail } */
  explanations: new Map(),
  ai: { enabled: false, model: "" },
  lastAiError: null,
  /** null | { kind: 'not_telegram' | 'not_allowed' | 'misconfigured', userId } — екран замість списку */
  blocked: null,
  refreshing: false,
};
function newSection(region) {
  return { region, status: "loading", error: null, trends: [], updatedAt: null, token: 0 };
}
const explanationKey = (trend) => `${state.settings.language}|${trend.key}`;

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
    throw new ApiError(0, { error: "offline" });
  }
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
    state.ai = data.ai;
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

/** Пояснення для вкладки (або одного тренду, якщо задано `only`; тоді кеш сервера оминається). */
async function explain(feed, only = null) {
  if (!state.ai.enabled) return;
  const section = state.sections[feed];
  const language = state.settings.language;
  const key = (trend) => `${language}|${trend.key}`;
  const targets = only ? [only] : section.trends.filter((trend) => state.explanations.get(key(trend))?.status !== "ai");
  if (targets.length === 0) return;

  for (const trend of targets) state.explanations.set(key(trend), { status: "loading" });
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
    state.explanations.set(key(trend), result);
    if (result.status === "ai") anySuccess = true;
    else detail ??= result.detail;
  }
  if (anySuccess) state.lastAiError = null;
  else if (detail) state.lastAiError = detail;
  render();
}

// ---------- Допоміжне ----------
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (name === "class") node.className = value;
    else if (name === "text") node.textContent = value;
    else if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(name, value === true ? "" : value);
  }
  node.append(...children.filter(Boolean));
  return node;
}
function relativeTime(millis) {
  const minutes = Math.max(0, Math.floor((Date.now() - millis) / 60_000));
  if (minutes < 1) return "щойно";
  if (minutes < 60) return `${minutes} хв тому`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} год тому`;
  return `${Math.floor(minutes / (24 * 60))} дн тому`;
}
const clock = (millis) => new Date(millis).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const regionLabel = (code) => `${REGIONS[code][0]} ${REGIONS[code][1]}`;
const shortModel = (model) => model.replace(/^gemini-/, "");

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
  if (tg?.openLink && tg.initData) tg.openLink(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
function shareTrend(trend) {
  const explanation = state.explanations.get(explanationKey(trend));
  const context = explanation?.status === "ai" ? explanation.text : (newsContext(trend) ?? "");
  const text = `${trend.title} — тренд Google (${REGIONS[trend.region][1]})\n${context}`.trim();
  const link = `https://t.me/share/url?url=${encodeURIComponent(trend.openUrl)}&text=${encodeURIComponent(text)}`;
  if (tg?.openTelegramLink && tg.initData) tg.openTelegramLink(link);
  else if (navigator.share) navigator.share({ text, url: trend.openUrl }).catch(() => {});
  else window.open(link, "_blank", "noopener,noreferrer");
}

// ---------- Рендер ----------
function visibleTrends(section) {
  const query = state.query.trim().toLowerCase();
  if (!query) return section.trends;
  return section.trends.filter((trend) => {
    const explanation = state.explanations.get(explanationKey(trend));
    return trend.title.toLowerCase().includes(query)
      || trend.news.some((n) => n.title.toLowerCase().includes(query))
      || (explanation?.status === "ai" && explanation.text.toLowerCase().includes(query));
  });
}

function renderCard(trend, feed) {
  const explanation = state.explanations.get(explanationKey(trend));
  const context = newsContext(trend) ?? NO_CONTEXT;
  let label, labelClass = "source-label", text = context, textClass = "explanation";
  if (explanation?.status === "ai") {
    label = `✨ Gemini · ${shortModel(explanation.model)}`; labelClass += " ai"; text = explanation.text;
  } else if (explanation?.status === "loading") {
    label = "✨ Gemini готує пояснення…"; textClass += " pending";
  } else if (explanation?.status === "failed") {
    label = `📰 З новин · ${AI_FAILURES[explanation.reason] ?? "помилка Gemini"}`;
  } else {
    label = "📰 З новин";
  }
  const meta = [trend.news[0]?.source, trend.publishedAtMillis ? relativeTime(trend.publishedAtMillis) : null].filter(Boolean).join(" · ");
  const open = () => openUrl(trend.openUrl);

  return el("article", { class: "card" },
    el("div", {
      class: "card-main", role: "link", tabindex: "0", onclick: open,
      onkeydown: (event) => { if (event.key === "Enter") open(); },
    },
      el("div", { class: "card-head" },
        el("span", { class: "rank", text: String(trend.rank), "aria-hidden": "true" }),
        el("div", { class: "card-title" },
          el("h3", { text: trend.title }),
          trend.approxTraffic && el("p", { class: "traffic", text: `🔥 ${trend.approxTraffic} пошуків` }),
        ),
        trend.imageUrl && isSafeUrl(trend.imageUrl)
          && el("img", { class: "thumb", src: trend.imageUrl, alt: "", loading: "lazy", referrerpolicy: "no-referrer", onerror: (event) => event.target.remove() }),
      ),
      el("div", { class: "card-body" },
        el("p", { class: labelClass, text: label }),
        el("p", { class: textClass, text }),
      ),
    ),
    el("div", { class: "card-foot" },
      el("span", { class: "meta", text: meta }),
      el("button", { class: "icon-btn more-btn", type: "button", "aria-label": `Інші дії: ${trend.title}`, onclick: () => openActions(trend, feed) },
        el("span", { text: "⋮", "aria-hidden": "true" })),
    ),
  );
}

function message(emoji, title, text, action) {
  return el("div", { class: "message" },
    el("div", { class: "emoji", text: emoji, "aria-hidden": "true" }),
    el("h2", { text: title }),
    el("p", { text }),
    action,
  );
}
const retryButton = (feed) => el("button", { class: "primary-btn", type: "button", text: "Спробувати знову", onclick: () => loadSection(feed) });

function renderSkeleton() {
  const list = el("div", { class: "list skeleton", "aria-busy": "true", "aria-label": "Завантаження" });
  for (let i = 0; i < 4; i++) {
    list.append(el("div", { class: "card" }, el("div", { class: "bone title" }), el("div", { class: "bone short" }), el("div", { class: "bone" }), el("div", { class: "bone mid" })));
  }
  return list;
}

function renderBlocked() {
  const { kind, userId } = state.blocked;
  if (kind === "not_allowed") {
    return message("🔒", "Немає доступу", "Надішліть цей номер власнику бота, щоб він додав вас до списку:", el("code", { text: String(userId) }));
  }
  if (kind === "misconfigured") {
    return message("🛠️", "Сервер не налаштовано", "Власнику: задайте секрет BOT_TOKEN командою «npx wrangler secret put BOT_TOKEN».");
  }
  return message("✈️", "Відкрийте в Telegram", "Цей застосунок працює лише всередині Telegram: відкрийте його через кнопку бота.");
}

function renderContent() {
  if (state.blocked) return renderBlocked();
  const feed = state.selected;
  const section = state.sections[feed];
  if (section.trends.length === 0 && section.status === "loading") return renderSkeleton();
  if (section.trends.length === 0 && section.status === "failed") {
    return message("☁️", "Не вдалося завантажити тренди", LOAD_ERRORS[section.error] ?? LOAD_ERRORS.http, retryButton(feed));
  }
  const fragment = document.createDocumentFragment();
  if (section.status === "failed") {
    fragment.append(el("div", { class: "banner", role: "status" },
      el("span", { text: "Не вдалося оновити — показано попередні дані." }),
      el("button", { class: "text-btn", type: "button", text: "Повторити", onclick: () => loadSection(feed) })));
  }
  const visible = visibleTrends(section);
  if (section.trends.length === 0) {
    fragment.append(message("📭", "Трендів немає", "Google Trends зараз не повертає трендів для цієї країни."));
  } else if (visible.length === 0) {
    fragment.append(message("🔎", "Нічого не знайдено", `Немає трендів зі словом «${state.query.trim()}».`));
  } else {
    fragment.append(el("div", { class: "list" }, ...visible.map((trend) => renderCard(trend, feed))));
  }
  fragment.append(el("p", { class: "footer-note", text: "Дані: публічний RSS Google Trends (неофіційне джерело)" }));
  return fragment;
}

function render() {
  const section = state.sections[state.selected];
  $("subtitle").textContent = state.blocked ? "" : section.updatedAt ? `Оновлено о ${clock(section.updatedAt)}` : section.status === "loading" ? "Завантаження…" : "";
  // Без доступу показуємо лише повідомлення: вкладки й кнопки нічого б не робили.
  $("tabs").hidden = Boolean(state.blocked);
  for (const id of ["btn-ai", "btn-search", "btn-refresh", "btn-settings"]) $(id).hidden = Boolean(state.blocked);
  if (state.blocked) $("search-row").hidden = true;
  $("btn-ai").classList.toggle("on", state.ai.enabled);
  $("btn-refresh").classList.toggle("spinning", state.refreshing);

  const tabs = FEEDS.map((feed) => el("button", {
    class: "tab", type: "button", role: "tab", "aria-selected": String(state.selected === feed),
    text: regionLabel(state.sections[feed].region),
    onclick: () => { state.selected = feed; render(); window.scrollTo({ top: 0 }); },
  }));
  $("tabs").replaceChildren(...tabs);
  $("content").replaceChildren(renderContent());
}

// ---------- Панелі ----------
function showSheet(dialog) {
  dialog.showModal();
  tg?.HapticFeedback?.impactOccurred?.("light");
}
for (const dialog of document.querySelectorAll("dialog")) {
  // Клік по затемненню закриває панель.
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.querySelector("[data-close]")?.addEventListener("click", () => dialog.close());
}

let actionTarget = null;
function openActions(trend, feed) {
  actionTarget = { trend, feed };
  const explanation = state.explanations.get(explanationKey(trend));
  $("actions-title").textContent = trend.title;
  const explainButton = $("action-explain");
  explainButton.hidden = !state.ai.enabled;
  explainButton.disabled = explanation?.status === "loading";
  explainButton.textContent = explanation?.status === "ai" ? "Пояснити ще раз" : "Пояснити з Gemini";
  showSheet($("sheet-actions"));
}
$("sheet-actions").addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action || !actionTarget) return;
  const { trend, feed } = actionTarget;
  $("sheet-actions").close();
  if (action === "search") openUrl(trend.searchUrl);
  else if (action === "share") shareTrend(trend);
  else if (action === "explain") explain(feed, trend);
});

function chipGroup(container, options, selected, onSelect) {
  container.replaceChildren(...options.map(([value, label]) => el("button", {
    class: "chip", type: "button", role: "radio", "aria-checked": String(value === selected), text: label,
    onclick: () => { onSelect(value); chipGroup(container, options, value, onSelect); },
  })));
}
let draft = null;
$("btn-settings").addEventListener("click", () => {
  draft = { ...state.settings };
  chipGroup($("region-chips"), EXPLORE_CHOICES.map((code) => [code, regionLabel(code)]), draft.exploreRegion, (v) => { draft.exploreRegion = v; });
  chipGroup($("lang-chips"), Object.entries(LANGUAGES), draft.language, (v) => { draft.language = v; });
  const auto = $("auto-explain");
  auto.checked = draft.autoExplain && state.ai.enabled;
  auto.disabled = !state.ai.enabled;
  $("auto-hint").textContent = state.ai.enabled ? "Gemini пише 1–2 речення до кожного тренду" : "На сервері не задано ключ Gemini";
  showSheet($("sheet-settings"));
});
$("settings-apply").addEventListener("click", () => {
  const old = state.settings;
  const next = { ...draft, autoExplain: state.ai.enabled ? $("auto-explain").checked : old.autoExplain };
  state.settings = next;
  saveSettings();
  $("sheet-settings").close();

  if (next.exploreRegion !== old.exploreRegion) {
    state.sections.explore = newSection(next.exploreRegion);
    state.selected = "explore";
    loadSection("explore");
  }
  // Нова мова або щойно ввімкнене авто-пояснення: пояснюємо вже завантажені вкладки.
  if (next.autoExplain && (next.language !== old.language || !old.autoExplain)) {
    for (const feed of FEEDS) if (state.sections[feed].status === "loaded") explain(feed);
  }
  render();
});

$("btn-ai").addEventListener("click", () => {
  $("ai-status").textContent = state.ai.enabled ? `✅ Gemini підключено · модель ${state.ai.model}` : "🔑 На сервері не задано ключ Gemini — показуються лише заголовки новин";
  $("ai-error-box").hidden = !state.lastAiError;
  $("ai-error").textContent = state.lastAiError ?? "";
  showSheet($("sheet-ai"));
});

$("btn-search").addEventListener("click", () => {
  const row = $("search-row");
  row.hidden = !row.hidden;
  $("btn-search").setAttribute("aria-expanded", String(!row.hidden));
  if (row.hidden) { state.query = ""; $("search").value = ""; render(); } else $("search").focus();
});
$("search").addEventListener("input", (event) => { state.query = event.target.value; render(); });
$("btn-refresh").addEventListener("click", refreshAll);

// ---------- Запуск ----------
function applyTheme() {
  const scheme = tg?.initData ? tg.colorScheme : null;
  document.documentElement.classList.toggle("dark", scheme === "dark");
  document.documentElement.classList.toggle("light", scheme === "light");
}
tg?.ready?.();
tg?.expand?.();
tg?.onEvent?.("themeChanged", applyTheme);
applyTheme();
render();
for (const feed of FEEDS) loadSection(feed);
// "5 хв тому" не має застигати.
setInterval(() => { if (!document.hidden && !document.querySelector("dialog[open]")) render(); }, 60_000);
