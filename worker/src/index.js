/**
 * Режим дня + ассистент в Telegram. Cloudflare Worker, без зависимостей.
 *
 * - cron каждую минуту: в момент подъёма — план на день (пары из журнала Top Academy,
 *   режим, проект, японский, еда, погода), дальше — напоминание за 5 минут до каждого блока;
 * - webhook Telegram: чат с нейросетью, которая отвечает на вопросы, меняет план на сегодня
 *   и работает репетитором японского.
 *
 * Состояние — в KV: "day" (план на сегодня), "hist" (последние сообщения чата).
 */

const GRID = 30; // сетка плана, минут
const EARLY = 5; // напоминание за столько минут до блока
const STALE = 20; // если опоздали сильнее — старое напоминание пропускаем
const BREAKS = " — с перерывами";
const HIST_LEN = 16;

const WEEKDAYS = ["понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье"];
const WEEKDAYS_NOM = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"];

const API = "https://msapi.top-academy.ru/api/v2";
const SITE = "https://journalka.top-academy.ru";
const APP_KEY = "6a56a5df2667e65aab73ce76d1dd737f7d1faef9c52e8b8c55ac75f565d8e8a6"; // публичный ключ сайта журнала

// Программа японского: неделя 1 начинается 9 ноября 2026
const JP_START = "2026-11-09";
const JP_WEEKS = [
  "хирагана, произношение", "катакана, приветствия",
  "Genki L1: XはYです, か, の, числа", "L2: これ/この/ここ, も, じゃない",
  "L3: глаголы на ます, を/で/に/へ, ～ませんか", "L4: あります/います, места, прошедшее время",
  "L5: い- и な-прилагательные, 好き, ～ましょう", "повторение L1–5 и тест",
  "L6: て-форма, ～てください, ～てもいい, ～てはいけない", "L7: ～ている, глагол + に行く",
  "L8: простая форма, ～と思う, ～ないでください", "L9: прошедшая простая форма, определительные предложения",
  "L10: より/のほうが, ～つもり, ～なる", "L11: ～たい, ～たり～たりする, ～ことがある",
  "L12: ～んです, ～すぎる, ～ほうがいい, ～ので, ～なければ", "пробный тест N5 и разбор",
  "L13: потенциальная форма, ～そう, ～てみる, なら", "L14: ほしい, かもしれない, あげる/くれる/もらう",
  "L15: волитивная форма, ～ておく", "L16: ～てあげる/くれる/もらう, ～時",
  "L17: ～そうです (слух), ～たら, ～なくてもいい, ～前に", "L18: переходные/непереходные, ～てしまう, ～ながら",
  "L19: уважительный кэйго", "L20: скромные выражения, ～やすい/にくい",
  "L21: пассив, ～てある", "L22: каузатив, ～ば, ～のに",
  "L23: каузативный пассив, ～ても, ～ことにする", "пробный N4 №1, слабые места",
  "добор слов и кандзи N4", "аудирование в формате экзамена",
  "пробный N4 №2", "похожие грамматические пары, ловушки",
  "пробный N4 №3", "лёгкое повторение перед экзаменом",
];

// ---------- настройки и время ----------

function cfg(env) {
  const mins = (v, d) => { const [h, m] = String(v || d).split(":").map(Number); return h * 60 + m; };
  const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d);
  return {
    tz: env.TZ_NAME || "Asia/Novosibirsk",
    wake: mins(env.WAKE, "06:30"),
    sleep: mins(env.SLEEP, "23:00"),
    commute: int(env.COMMUTE_MIN, 40),
    jp: int(env.JP_MIN, 180),
    projMax: int(env.PROJECT_MAX_MIN, 300),
    project: env.PROJECT_NAME || "Проект",
    deadline: env.PROJECT_DEADLINE || "2027-01-15",
    lat: env.LAT || "55.03",
    lon: env.LON || "82.92",
  };
}

function nowLocal(tz, at = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(at).map((x) => [x.type, x.value]),
  );
  const date = `${p.year}-${p.month}-${p.day}`;
  const wd = (new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7; // 0 — понедельник
  return { date, wd, min: Number(p.hour) * 60 + Number(p.minute) };
}

const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const hm = (s) => String(s || "").slice(0, 5);
const toMin = (s) => { const [h, m] = hm(s).split(":").map(Number); return h * 60 + m; };
const floorGrid = (m) => m - (m % GRID);
const ceilGrid = (m) => (m % GRID === 0 ? m : m + GRID - (m % GRID));
const ddmm = (date) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// ---------- построение плана ----------

/** lessons: [{s, e, name, room}] в минутах. Возвращает {events:[{s,e,t,r}], notes:[]} */
export function buildPlan(lessons, c) {
  const ev = [];
  const notes = [];
  const add = (s, e, t, r = null) => ev.push({ s, e, t, r });
  const windDown = c.sleep - 60;
  const bed = c.sleep - 30;
  const busy = [];

  let leave = null;
  let back = null;
  if (lessons.length) {
    leave = floorGrid(lessons[0].s - c.commute);
    back = ceilGrid(lessons[lessons.length - 1].e + c.commute);
    busy.push([leave, back]);
  }

  // Утро. Пары рано — сжимаем, но завтрак оставляем
  let morningEnd = c.wake + 90;
  if (leave !== null && leave < morningEnd) morningEnd = Math.max(leave, c.wake + 30);
  const breakfast = morningEnd - 30;
  const breakfastRemind = "🍳 Завтрак! Хоть немного, но с белком: яйца, творог, йогурт с бананом, овсянка";
  if (morningEnd - c.wake >= 90) {
    add(c.wake, c.wake + 30, "🏃 Подъём, зарядка, пробежка");
    add(c.wake + 30, breakfast, "🚿 Душ и сборы", "🚿 Пробежка всё — душ и сборы");
    add(breakfast, morningEnd, "🍳 Завтрак — обязательно", breakfastRemind);
  } else {
    notes.push("⚠️ Пары рано — пробежку сегодня перенеси на вечер");
    if (breakfast > c.wake) {
      add(c.wake, breakfast, "⏰ Подъём, душ, сборы");
      add(breakfast, morningEnd, "🍳 Завтрак — обязательно", breakfastRemind);
    } else {
      add(c.wake, morningEnd, "🍳 Подъём и завтрак — обязательно");
    }
  }
  busy.push([c.wake, morningEnd]);

  if (lessons.length) {
    const first = fmt(lessons[0].s);
    add(leave, back, `🚌 Пары (первая в ${first})`,
      `🚌 Пора выходить — первая пара в ${first}.\n🎧 В дорогу — японский в наушники`);
  }
  busy.push([windDown, 24 * 60]);

  const free = (s, e) => busy.every(([bs, be]) => e <= bs || s >= be);

  // Обед
  let lunch = null;
  if (free(780, 810)) lunch = 780;
  else if (leave !== null && leave >= 720 && leave <= 900 && free(leave - 30, leave)) lunch = leave - 30;
  else if (back !== null && back >= 690 && back <= 960) lunch = back;
  else notes.push("🥪 Обед — в перерыве между парами, возьми еду с собой");
  if (lunch !== null) { add(lunch, lunch + 30, "🥗 Обед", "🥗 Время обеда"); busy.push([lunch, lunch + 30]); }

  // Ужин
  let dinner = null;
  if (free(1140, 1170)) dinner = 1140;
  else if (back !== null && back + 30 <= windDown && free(back, back + 30)) dinner = back;
  else notes.push("🍽 Ужин — сразу как вернёшься, не позже чем за 2–3 часа до сна");
  if (dinner !== null) {
    add(dinner, dinner + 30, "🍽 Ужин", dinner >= 1200 ? "🍽 Ужин — лёгкий, до сна меньше 3 часов" : "🍽 Время ужина");
    busy.push([dinner, dinner + 30]);
  }

  // Свободные окна → блоки по 30–90 минут: проект и японский по очереди
  busy.sort((a, b) => a[0] - b[0]);
  const windows = [];
  let cur = c.wake;
  for (const [bs, be] of busy) {
    if (bs > cur) windows.push([cur, bs]);
    cur = Math.max(cur, be);
  }

  let jp = 0;
  let proj = 0;
  let next = "proj";
  for (const [ws, we] of windows) {
    let t = ws;
    while (we - t >= 30) {
      let len = Math.min(90, we - t);
      let kind = next;
      if (kind === "jp" && jp >= c.jp) kind = "proj";
      if (kind === "proj" && proj >= c.projMax) kind = jp < c.jp ? "jp" : "free";
      if (kind === "jp") {
        if (c.jp - jp >= 30) len = Math.min(len, c.jp - jp);
        add(t, t + len, "🇯🇵 Японский: задание дня + Renshuu", "🇯🇵 Японский: задание дня и повторение в Renshuu");
        jp += len;
        next = "proj";
      } else if (kind === "proj") {
        add(t, t + len, `💻 ${c.project}`,
          `💻 ${c.project}. Телефон экраном вниз 📵, перерыв 10 минут каждые полтора часа`);
        proj += len;
        next = "jp";
      } else {
        add(t, we, "🟢 Свободное время", "🟢 Всё по плану сделано — свободное время");
        break;
      }
      t += len;
    }
  }
  if (jp < c.jp) notes.push(`🇯🇵 Японского по плану ${jp} мин — добери фоном: подкаст, видео`);

  add(windDown, bed, "🌙 Закругляемся",
    "🌙 Закругляемся: экраны в сторону. Одежда для пробежки и завтрак на утро — готовы?");
  add(bed, c.sleep, "🛏 В кровать", `🛏 В кровать — отбой в ${fmt(c.sleep)}. Будильник на ${fmt(c.wake)} стоит?`);

  ev.sort((a, b) => a.s - b.s);
  const merged = [];
  for (const e of ev) {
    const last = merged[merged.length - 1];
    if (last && last.t.replace(BREAKS, "") === e.t && last.e === e.s) {
      last.e = e.e;
      if (!last.t.endsWith(BREAKS)) last.t += BREAKS;
      continue;
    }
    merged.push(e);
  }
  return { events: merged, notes };
}

export function renderPlan(st, c, { update = false, weather = null, nowMin = null } = {}) {
  const lines = [];
  const head = update ? "✏️ Обновлённый план" : "☀️ Доброе утро! План";
  lines.push(`${head} на ${WEEKDAYS[st.wd]}, ${ddmm(st.date)}`);
  const left = daysBetween(st.date, c.deadline);
  if (left >= 0) lines.push(`⏳ До дедлайна «${c.project}»: ${left} дн.`);
  lines.push("");
  for (const e of st.events) {
    const done = nowMin !== null && e.e <= nowMin ? "✓ " : "";
    lines.push(`${done}${fmt(e.s)}–${fmt(e.e)}  ${e.t}`);
    if (e.t.startsWith("🚌") && st.lessons?.length) {
      for (const l of st.lessons) lines.push(`      ${fmt(l.s)}–${fmt(l.e)}  ${l.name}${l.room ? " · " + l.room : ""}`);
    }
  }
  lines.push(`${fmt(c.sleep)}  😴 Отбой`);
  if (st.error) lines.push(`\n⚠️ Пары из журнала не получил (${st.error}) — план без них. Попробую ещё раз через полчаса`);
  if (st.notes?.length) lines.push("", ...st.notes);
  if (!update) {
    lines.push("\n🎧 Японский фоном: пробежка, дорога, еда");
    lines.push(st.events[0]?.t.startsWith("🏃")
      ? "\nПодъём! Стакан воды, 10 минут зарядки и на пробежку 🏃"
      : "\nПодъём! Стакан воды — и собираемся");
  }
  if (weather) lines.push("\n" + weather);
  return lines.join("\n");
}

// ---------- внешние сервисы ----------

async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.ok) throw new Error(`Telegram ${method}: ${String(d.description || r.status).slice(0, 150)}`);
  return d.result;
}

async function send(env, text) {
  for (let i = 0; i < text.length; i += 4000) {
    await tg(env, "sendMessage", { chat_id: env.TG_CHAT_ID, text: text.slice(i, i + 4000), disable_web_page_preview: true });
  }
}

async function journal(path, { body = null, token = null } = {}) {
  const headers = { Accept: "application/json", Origin: SITE, Referer: SITE + "/", "User-Agent": "Mozilla/5.0" };
  if (body) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = "Bearer " + token;
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(API + path, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined });
      const raw = await r.text();
      if (r.status >= 400 && r.status < 500) throw Object.assign(new Error(`HTTP ${r.status} ${raw.slice(0, 120)}`), { final: true });
      if (r.ok) return raw ? JSON.parse(raw) : null;
      last = new Error(`HTTP ${r.status}`);
    } catch (e) {
      if (e.final) throw e;
      last = e;
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  throw last;
}

async function getLessons(env, date) {
  const auth = await journal("/auth/login", {
    body: { application_key: APP_KEY, id_city: null, username: env.JOURNAL_LOGIN, password: env.JOURNAL_PASSWORD },
  });
  if (!auth?.access_token) throw new Error("вход прошёл, но токена нет");
  const data = await journal(`/schedule/operations/get-by-date?date_filter=${date}`, { token: auth.access_token });
  const list = Array.isArray(data) ? data : data?.data || [];
  return list
    .map((l) => ({ s: toMin(l.started_at), e: toMin(l.finished_at), name: l.subject_name || "—", room: l.room_name || "" }))
    .sort((a, b) => a.s - b.s);
}

async function weather(c) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&timezone=auto&forecast_days=1`
      + "&wind_speed_unit=ms&daily=temperature_2m_min,temperature_2m_max,apparent_temperature_min,"
      + "apparent_temperature_max,precipitation_probability_max,wind_speed_10m_max,snowfall_sum";
    const d = (await (await fetch(url)).json()).daily;
    const tmin = Math.round(d.temperature_2m_min[0]);
    const tmax = Math.round(d.temperature_2m_max[0]);
    const feels = Math.round((d.apparent_temperature_min[0] + d.apparent_temperature_max[0]) / 2);
    const rain = d.precipitation_probability_max[0] || 0;
    const wind = Math.round(d.wind_speed_10m_max[0]);
    const snow = d.snowfall_sum[0] || 0;
    let tip = feels <= -10 ? "🥶 очень холодно — шапка и перчатки" : feels <= 3 ? "🧥 холодно — одевайся тепло"
      : feels <= 12 ? "🧥 прохладно — куртка" : feels >= 25 ? "☀️ жарко — одевайся легко" : "👕 комфортно";
    if (rain >= 40) tip += snow > 0 ? ` · ❄️ снег (${rain}%)` : ` · ☔ зонт (${rain}%)`;
    if (wind >= 10) tip += " · 💨 ветер";
    if (feels <= -15) tip += " · 🏃 пробежку лучше заменить зарядкой подольше";
    return `🌦 Погода: ${tmin}…${tmax}°, осадки ${rain}%, ветер ${wind} м/с\n${tip}`;
  } catch {
    return null;
  }
}

// ---------- состояние ----------

const getJSON = async (env, key) => { try { return JSON.parse((await env.KV.get(key)) || "null"); } catch { return null; } };
const putJSON = (env, key, val) => env.KV.put(key, JSON.stringify(val));

/** Строит план на сегодня. retry — тихая повторная попытка, если журнал раньше не ответил. */
async function makePlan(env, c, now, { update = false, retry = false, silent = false } = {}) {
  let lessons = [];
  let error = null;
  try {
    lessons = await getLessons(env, now.date);
  } catch (e) {
    error = String(e.message || e).slice(0, 120);
  }
  if (retry && error) return null;
  const { events, notes } = buildPlan(lessons, c);
  for (const e of events) e.sent = !e.r || e.s - EARLY <= now.min; // прошедшее не дублируем
  const st = { date: now.date, wd: now.wd, events, notes, lessons, error, journalFailed: Boolean(error) };
  await putJSON(env, "day", st);
  if (!silent) await send(env, renderPlan(st, c, { update, weather: await weather(c), nowMin: update ? now.min : null }));
  return st;
}

// ---------- cron: план и напоминания ----------

export async function tick(env, at = new Date()) {
  const c = cfg(env);
  const now = nowLocal(c.tz, at);
  const st = await getJSON(env, "day");

  if (!st || st.date !== now.date) {
    if (now.min >= c.wake && now.min < c.sleep) await makePlan(env, c, now);
    return;
  }
  if (st.journalFailed && now.min % 30 === 0 && now.min < c.sleep) {
    if (await makePlan(env, c, now, { update: true, retry: true })) return;
  }
  let changed = false;
  for (const e of st.events) {
    if (e.sent || e.s - EARLY > now.min) continue;
    if (now.min - e.s <= STALE) await send(env, `⏰ ${fmt(e.s)}  ${e.r}`);
    e.sent = true;
    changed = true;
  }
  if (changed) await putJSON(env, "day", st);
}

// ---------- нейросеть ----------

/** Убирает служебную разметку моделей: размышления <think>, каналы gpt-oss (<|start|>assistant…final) */
export function cleanReply(t) {
  t = String(t || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "");
  if (/<\|(start|end|return|channel|message)\|>|^analysis/.test(t)) {
    const blocks = t.split(/<\|start\|>assistant/);
    const finals = blocks.filter((b) => /^\s*(<\|channel\|>)?final(?!\s*:)/.test(b));
    const pick = finals.length ? finals[finals.length - 1] : blocks[blocks.length - 1];
    t = pick.replace(/^\s*(<\|channel\|>)?final(<\|message\|>)?/, "");
  }
  return t.replace(/<\|[a-z_]+\|>/g, "").trim();
}

function extractText(r) {
  if (!r) return "";
  if (typeof r === "string") return r;
  if (typeof r.response === "string") return r.response;
  if (r.choices?.[0]?.message?.content) return r.choices[0].message.content;
  if (Array.isArray(r.output)) {
    return r.output
      .filter((o) => o.type === "message")
      .flatMap((o) => o.content || [])
      .map((p) => p.text || "")
      .join("");
  }
  if (r.result) return extractText(r.result);
  return "";
}

async function llm(env, messages) {
  const errors = [];
  if (env.AI) {
    const models = (env.LLM_MODEL || "@cf/qwen/qwen3-30b-a3b-fp8,@cf/meta/llama-3.3-70b-instruct-fp8-fast").split(",");
    for (const model of models) {
      try {
        const r = await env.AI.run(model.trim(), { messages, max_tokens: 1500 });
        const t = cleanReply(extractText(r));
        if (t) return t;
        errors.push(`${model}: пустой ответ`);
      } catch (e) {
        errors.push(`${model}: ` + String(e.message || e).slice(0, 100));
      }
    }
  }
  if (env.OPENROUTER_API_KEY) {
    for (const model of (env.OPENROUTER_MODELS || "openai/gpt-oss-120b:free,meta-llama/llama-3.3-70b-instruct:free").split(",")) {
      try {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: "Bearer " + env.OPENROUTER_API_KEY, "Content-Type": "application/json", "X-Title": "day-plan" },
          body: JSON.stringify({ model: model.trim(), messages, max_tokens: 2000 }),
        });
        const d = await r.json();
        const t = cleanReply(extractText(d));
        if (t) return t;
        errors.push(`${model}: ${String(d.error?.message || "пустой ответ").slice(0, 80)}`);
      } catch (e) {
        errors.push(`${model}: ${String(e.message || e).slice(0, 80)}`);
      }
    }
  }
  throw new Error(errors.join("; ") || "нейросеть не настроена");
}

function jpWeek(date) {
  const w = Math.floor(daysBetween(JP_START, date) / 7) + 1;
  if (w < 1) return "старт программы 9 ноября: пока можно начать хирагану";
  if (w > JP_WEEKS.length) return "программа N4 пройдена, дальше — N3";
  return `неделя ${w} из ${JP_WEEKS.length}: ${JP_WEEKS[w - 1]}`;
}

function systemPrompt(st, c, now) {
  const plan = st.events
    .map((e) => `${e.e <= now.min ? "[прошло] " : ""}${fmt(e.s)}–${fmt(e.e)} ${e.t}${e.r ? ` | напоминание: ${e.r.replace(/\n/g, " ")}` : ""}`)
    .join("\n");
  const lessons = st.lessons?.length ? st.lessons.map((l) => `${fmt(l.s)}–${fmt(l.e)} ${l.name}`).join("; ") : "пар нет";
  return `Ты — личный ассистент Павла в Telegram: ведёшь его режим дня и учишь японскому. Павел — студент колледжа, веб-разработчик, хочет работать C#-разработчиком в Японии.
Отвечай по-русски, коротко, как в мессенджере. Без markdown: никаких **, #, таблиц — обычный текст, эмодзи можно.

Сейчас: ${WEEKDAYS_NOM[now.wd]}, ${ddmm(now.date)}, ${fmt(now.min)}.
Режим: подъём ${fmt(c.wake)}, отбой ${fmt(c.sleep)}, утром зарядка и пробежка, завтрак обязателен. Дорога до колледжа ${c.commute} мин.
Проект «${c.project}», дедлайн ${c.deadline} (осталось ${daysBetween(now.date, c.deadline)} дн.).
Японский: цель — JLPT N4 в начале июля 2027, ${c.jp} мин активной учёбы в день плюс аудирование фоном. Сейчас ${jpWeek(now.date)}. Слова повторяет в Renshuu.
Пары сегодня: ${lessons}.

План на сегодня:
${plan}

Что ты умеешь:
1. Отвечать на любые вопросы.
2. Менять план на сегодня: перенести, добавить, убрать блок, облегчить день, если устал или заболел. Тогда в самом конце ответа добавь блок
\`\`\`plan
[{"start":"HH:MM","end":"HH:MM","title":"эмодзи + название","remind":"текст напоминания"}]
\`\`\`
с ПОЛНЫМ списком блоков от ${fmt(now.min)} до конца дня, включая неизменённые. Прошедшие блоки не включай. Время кратно 30 минутам. Сон и еду не выкидывай: ужин, «🌙 Закругляемся» за час до отбоя и «🛏 В кровать» за полчаса остаются. Если план не меняется — блок не добавляй. Меняй только то, о чём просят.
3. Быть репетитором японского: объяснять грамматику текущей недели, давать мини-задания, проверять его предложения (исправь и объясни ошибку), гонять по словам. Японские слова пиши каной или кандзи с чтением в скобках; ромадзи — только на неделях 1–2.

Всегда отвечай только на русском языке (японский — только как учебный материал). Не показывай свои рассуждения, сразу пиши ответ. /no_think`;
}

function parsePlanBlock(reply, now) {
  const m = reply.match(/```plan\s*([\s\S]*?)```/);
  if (!m) return { text: reply.trim(), events: null };
  const text = reply.replace(m[0], "").trim();
  try {
    const arr = JSON.parse(m[1]);
    if (!Array.isArray(arr)) throw new Error();
    const events = arr
      .map((x) => ({ s: toMin(x.start), e: toMin(x.end), t: String(x.title || "").trim(), r: String(x.remind || "").trim() || null }))
      .filter((x) => Number.isFinite(x.s) && Number.isFinite(x.e) && x.e > x.s && x.t && x.e > now.min)
      .sort((a, b) => a.s - b.s);
    return { text, events: events.length ? events : null };
  } catch {
    return { text, events: null };
  }
}

async function chat(env, text, at = new Date()) {
  const c = cfg(env);
  const now = nowLocal(c.tz, at);
  tg(env, "sendChatAction", { chat_id: env.TG_CHAT_ID, action: "typing" }).catch(() => {});

  let st = await getJSON(env, "day");
  if (!st || st.date !== now.date) st = await makePlan(env, c, now, { silent: true });

  const hist = (await getJSON(env, "hist")) || [];
  const messages = [{ role: "system", content: systemPrompt(st, c, now) }, ...hist, { role: "user", content: text }];
  let reply;
  try {
    reply = await llm(env, messages);
  } catch (e) {
    await send(env, `⚠️ Нейросеть сейчас не отвечает: ${String(e.message || e).slice(0, 200)}\nПопробуй ещё раз чуть позже.`);
    return;
  }

  const { text: answer, events } = parsePlanBlock(reply, now);
  let out = answer || "Готово.";
  if (events) {
    const kept = st.events.filter((e) => e.s < now.min && !events.some((n) => n.s === e.s));
    for (const e of events) e.sent = !e.r || e.s - EARLY <= now.min;
    st.events = [...kept, ...events].sort((a, b) => a.s - b.s);
    await putJSON(env, "day", st);
    out += "\n\n" + renderPlan(st, c, { update: true, nowMin: now.min });
  }
  await send(env, out);

  hist.push({ role: "user", content: text }, { role: "assistant", content: answer + (events ? "\n[план на сегодня обновлён]" : "") });
  await putJSON(env, "hist", hist.slice(-HIST_LEN));
}

// ---------- Telegram webhook ----------

async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const HELP = `Я веду твой режим дня и учу японскому.

Пиши как обычно:
• «перенеси японский на вечер», «я заболел, облегчи день», «что у меня дальше?»
• «объясни て-форму», «дай 10 слов на эту неделю», «проверь: わたしは学生です»

Команды:
/plan — план на сегодня
/replan — перестроить план (подтянуть пары из журнала)
/reset — забыть историю переписки`;

export async function handleUpdate(env, upd, at = new Date()) {
  const msg = upd.message;
  if (!msg || String(msg.chat?.id) !== String(env.TG_CHAT_ID)) return;
  const text = (msg.text || "").trim();
  if (!text) {
    await send(env, "Пока понимаю только текст 🙂");
    return;
  }
  const cmd = text.split(/[\s@]/)[0].toLowerCase();
  const c = cfg(env);
  const now = nowLocal(c.tz, at);

  if (cmd === "/start" || cmd === "/help") return send(env, HELP);
  if (cmd === "/reset") { await env.KV.delete("hist"); return send(env, "🧹 Историю переписки очистил"); }
  if (cmd === "/replan") { await makePlan(env, c, now, { update: true }); return; }
  if (cmd === "/plan") {
    let st = await getJSON(env, "day");
    if (!st || st.date !== now.date) st = await makePlan(env, c, now, { silent: true });
    return send(env, renderPlan(st, c, { update: true, nowMin: now.min }).replace("✏️ Обновлённый план", "📋 План"));
  }
  return chat(env, text, at);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/tg") {
      const expected = (await sha256hex(env.TG_TOKEN || "")).slice(0, 32);
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== expected) return new Response("forbidden", { status: 403 });
      const upd = await request.json().catch(() => ({}));
      ctx.waitUntil(handleUpdate(env, upd).catch((e) => send(env, `⚠️ Ошибка: ${String(e.message || e).slice(0, 200)}`).catch(() => {})));
      return new Response("ok");
    }
    return new Response("day-plan работает");
  },

  async scheduled(event, env, ctx) {
    const at = new Date(event.scheduledTime);
    ctx.waitUntil(tick(env, at).catch((e) => {
      // cron идёт каждую минуту — об ошибке пишем не чаще раза в полчаса
      if (at.getUTCMinutes() % 30 === 0) {
        return send(env, `⚠️ Режим дня: ошибка\n${String(e.message || e).slice(0, 200)}`).catch(() => {});
      }
    }));
  },
};
