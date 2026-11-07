"""
Режим дня: утром — план на день (пары из журнала + режим), днём — напоминания
перед каждым блоком. Только стандартная библиотека Python.

Запускается cron-job.org каждые 30 минут (в :00 и :30) с 06:00 до 22:30.
Все блоки плана стоят на получасовой сетке, поэтому напоминание приходит
ровно к своему запуску. План строится один раз за день и хранится в daystate/.

Настройки (vars репозитория, всё необязательно):
  WAKE=06:30  SLEEP=23:00  COMMUTE_MIN=40  JP_MIN=180  PROJECT_MAX_MIN=300
  PROJECT_NAME=Проект  PROJECT_DEADLINE=2027-01-15
"""

import json
import os
import sys
from datetime import date, datetime

from common import TZ, WEEKDAYS, get_schedule, hm, login, send_telegram, weather_for

STATE_DIR = "daystate"
STATE_FILE = os.path.join(STATE_DIR, "day.json")
GRID = 30  # шаг сетки, минут — совпадает с частотой запусков
BREAKS = " — с перерывами"

EARLY = 10  # напоминание шлём, если до блока осталось не больше 10 минут
STALE = 20  # если запуск опоздал сильнее — старое напоминание молча пропускаем


def env_min(name, default):
    h, m = (os.getenv(name) or default).split(":")
    return int(h) * 60 + int(m)


def env_int(name, default):
    try:
        return int(os.getenv(name) or default)
    except ValueError:
        return default


WAKE = env_min("WAKE", "06:30")
SLEEP = env_min("SLEEP", "23:00")
COMMUTE = env_int("COMMUTE_MIN", 40)
JP_MIN = env_int("JP_MIN", 180)
PROJECT_MAX = env_int("PROJECT_MAX_MIN", 300)
PROJECT = os.getenv("PROJECT_NAME") or "Проект"
DEADLINE = os.getenv("PROJECT_DEADLINE") or "2027-01-15"


def to_min(s):
    h, m = hm(s).split(":")
    return int(h) * 60 + int(m)


def fmt(m):
    return f"{m // 60:02d}:{m % 60:02d}"


def floor_grid(m):
    return m - m % GRID


def ceil_grid(m):
    return m if m % GRID == 0 else m + GRID - m % GRID


# ---------- построение плана ----------

def build_plan(lessons):
    """Возвращает (события, заметки). Событие: [минута, конец, строка плана, напоминание]."""
    ev, notes = [], []
    add = lambda s, e, line, remind=None: ev.append([s, e, line, remind])

    wind_down, bed = SLEEP - 60, SLEEP - 30
    busy = []  # занятые интервалы [начало, конец)

    leave = back = None
    if lessons:
        first, last = to_min(lessons[0].get("started_at")), to_min(lessons[-1].get("finished_at"))
        leave, back = floor_grid(first - COMMUTE), ceil_grid(last + COMMUTE)
        busy.append((leave, back))

    # Утро. Если пары ранние — сжимаем, но завтрак не выкидываем.
    morning_end = WAKE + 90
    if leave is not None and leave < morning_end:
        morning_end = max(leave, WAKE + 30)
    breakfast = morning_end - 30
    breakfast_remind = "🍳 Завтрак! Хоть немного, но с белком: яйца, творог, йогурт с бананом, овсянка"
    run = morning_end - WAKE >= 90
    if run:  # первая строка приходит вместе с планом, отдельного напоминания нет
        add(WAKE, WAKE + 30, "🏃 Подъём, зарядка, пробежка")
        add(WAKE + 30, breakfast, "🚿 Душ и сборы", "🚿 Пробежка всё — душ и сборы")
        add(breakfast, morning_end, "🍳 Завтрак — обязательно", breakfast_remind)
    else:
        notes.append("⚠️ Пары рано — пробежку сегодня перенеси на вечер")
        if breakfast > WAKE:
            add(WAKE, breakfast, "⏰ Подъём, душ, сборы")
            add(breakfast, morning_end, "🍳 Завтрак — обязательно", breakfast_remind)
        else:
            add(WAKE, morning_end, "🍳 Подъём и завтрак — обязательно")
    busy.append((WAKE, morning_end))

    if lessons:
        add(leave, back, f"🚌 Пары (первая в {hm(lessons[0].get('started_at'))})",
            f"🚌 Пора выходить — первая пара в {hm(lessons[0].get('started_at'))}.\n"
            "🎧 В дорогу — японский в наушники")

    busy.append((wind_down, 24 * 60))

    def free(s, e):
        return all(e <= bs or s >= be for bs, be in busy)

    # Обед
    if free(13 * 60, 13 * 60 + 30):
        lunch = 13 * 60
    elif leave is not None and 12 * 60 <= leave <= 15 * 60 and free(leave - 30, leave):
        lunch = leave - 30  # пообедать перед выходом
    elif back is not None and 11 * 60 + 30 <= back <= 16 * 60:
        lunch = back
    else:
        lunch = None
        notes.append("🥪 Обед — в перерыве между парами, возьми еду с собой")
    if lunch is not None:
        add(lunch, lunch + 30, "🥗 Обед", "🥗 Время обеда")
        busy.append((lunch, lunch + 30))

    # Ужин
    if free(19 * 60, 19 * 60 + 30):
        dinner = 19 * 60
    elif back is not None and back + 30 <= wind_down and free(back, back + 30):
        dinner = back
    else:
        dinner = None
        notes.append("🍽 Ужин — сразу как вернёшься, не позже чем за 2–3 часа до сна")
    if dinner is not None:
        add(dinner, dinner + 30, "🍽 Ужин", "🍽 Ужин. Дальше лёгкая еда — до сна меньше 4 часов" if dinner >= 20 * 60 else "🍽 Время ужина")
        busy.append((dinner, dinner + 30))

    # Свободные окна → блоки по 30–90 минут: проект и японский по очереди
    busy.sort()
    windows, cur = [], WAKE
    for bs, be in busy:
        if bs > cur:
            windows.append((cur, bs))
        cur = max(cur, be)

    jp, proj, next_kind = 0, 0, "proj"
    for ws, we in windows:
        t = ws
        while we - t >= 30:
            length = min(90, we - t)
            kind = next_kind
            if kind == "jp" and jp >= JP_MIN:
                kind = "proj"
            if kind == "proj" and proj >= PROJECT_MAX:
                kind = "jp" if jp < JP_MIN else "free"
            if kind == "jp":
                length = min(length, JP_MIN - jp) if JP_MIN - jp >= 30 else length
                add(t, t + length, "🇯🇵 Японский: задание дня + Renshuu",
                    "🇯🇵 Японский: задание дня от Claude и повторение в Renshuu")
                jp += length
                next_kind = "proj"
            elif kind == "proj":
                add(t, t + length, f"💻 {PROJECT}",
                    f"💻 {PROJECT}. Телефон экраном вниз 📵, перерыв 10 минут каждые полтора часа")
                proj += length
                next_kind = "jp"
            else:
                add(t, we, "🟢 Свободное время", "🟢 Всё по плану сделано — свободное время")
                t = we
                break
            t += length

    if jp < JP_MIN:
        notes.append(f"🇯🇵 Японского по плану {jp} мин — добери фоном: подкаст, видео")

    add(wind_down, bed, "🌙 Закругляемся",
        "🌙 Закругляемся: экраны в сторону. Одежда для пробежки и завтрак на утро — готовы?")
    add(bed, SLEEP, "🛏 В кровать", f"🛏 В кровать — отбой в {fmt(SLEEP)}. Будильник на {fmt(WAKE)} стоит?")

    ev.sort(key=lambda x: x[0])
    # подряд идущие одинаковые блоки (обычно проект) показываем одной строкой
    merged = []
    for e in ev:
        if merged and merged[-1][2].replace(BREAKS, "") == e[2] and merged[-1][1] == e[0]:
            merged[-1][1] = e[1]
            if not merged[-1][2].endswith(BREAKS):
                merged[-1][2] += BREAKS
            continue
        merged.append(e)
    return merged, notes


def plan_message(today, lessons, events, notes, error=None):
    days_left = (date.fromisoformat(DEADLINE) - today).days
    lines = [f"☀️ Доброе утро! План на {WEEKDAYS[today.weekday()]}, {today.strftime('%d.%m')}"]
    if days_left >= 0:
        lines.append(f"⏳ До дедлайна «{PROJECT}»: {days_left} дн.")
    lines.append("")

    for s, e, line, _ in events:
        lines.append(f"{fmt(s)}–{fmt(e)}  {line}")
        if line.startswith("🚌") and lessons:
            for l in lessons:
                lines.append(f"      {hm(l.get('started_at'))}–{hm(l.get('finished_at'))}  "
                             f"{l.get('subject_name') or '—'}"
                             + (f" · {l['room_name']}" if l.get("room_name") else ""))
    lines.append(f"{fmt(SLEEP)}  😴 Отбой")

    if error:
        lines.append(f"\n⚠️ Пары из журнала не получил ({error}) — план без них")
    if notes:
        lines.append("")
        lines.extend(notes)
    lines.append("\n🎧 Японский фоном: пробежка, дорога, еда")
    if events and events[0][2].startswith("🏃"):
        lines.append("\nПодъём! Стакан воды, 10 минут зарядки и на пробежку 🏃")
    else:
        lines.append("\nПодъём! Стакан воды — и собираемся")
    try:
        lines.append("\n" + weather_for(0))
    except Exception:
        pass
    return "\n".join(lines)


# ---------- состояние ----------

def load_state():
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(state):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, ensure_ascii=False)


def main():
    os.makedirs(STATE_DIR, exist_ok=True)
    now = datetime.now(TZ)
    today, now_min = now.date(), now.hour * 60 + now.minute
    state = load_state()

    if state.get("date") != today.isoformat():
        if now_min < WAKE - EARLY:
            print("Ещё рано")
            return
        lessons, error = [], None
        try:
            lessons = get_schedule(login(), today.isoformat())
        except Exception as e:
            error = str(e)[:150]
        events, notes = build_plan(lessons)
        send_telegram(plan_message(today, lessons, events, notes, error))
        state = {"date": today.isoformat(),
                 "reminders": [[s, r] for s, _, _, r in events if r],
                 "sent": []}
        # всё, что уже прошло к моменту плана, не дублируем
        state["sent"] = [i for i, (s, _) in enumerate(state["reminders"]) if s <= now_min + EARLY]
        save_state(state)
        print("План отправлен")
        return

    sent = set(state.get("sent", []))
    for i, (s, text) in enumerate(state.get("reminders", [])):
        if i in sent or s > now_min + EARLY:
            continue
        if s >= now_min - STALE:
            send_telegram(f"⏰ {fmt(s)}  {text}")
        sent.add(i)
    state["sent"] = sorted(sent)
    save_state(state)
    print("Готово")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("Ошибка (подробности в Telegram)")
        try:
            send_telegram(f"⚠️ Режим дня: ошибка\n{e}")
        except Exception:
            pass
        sys.exit(1)
