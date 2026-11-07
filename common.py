"""Общее: вход в журнал Top Academy, расписание, погода, Telegram. Только стандартная библиотека."""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

API = "https://msapi.top-academy.ru/api/v2"
SITE = "https://journalka.top-academy.ru"
# Публичный ключ сайта журнала (не пользовательский секрет)
APP_KEY = os.getenv("APP_KEY") or "6a56a5df2667e65aab73ce76d1dd737f7d1faef9c52e8b8c55ac75f565d8e8a6"

TZ = ZoneInfo(os.getenv("TZ_NAME") or "Europe/Moscow")
LAT = os.getenv("LAT") or "55.75"
LON = os.getenv("LON") or "37.62"


def http(url, data=None, token=None):
    headers = {
        "Accept": "application/json",
        "Origin": SITE,
        "Referer": SITE + "/",
        "User-Agent": "Mozilla/5.0",
    }
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    short = url.split("/api/v2")[-1].split("?")[0]
    last_err = None
    for attempt in range(4):  # сервер иногда рвёт соединение — пробуем ещё раз
        req = urllib.request.Request(url, data=body, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read().decode()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            if e.code < 500:
                raise RuntimeError(f"{short}: HTTP {e.code} {e.read().decode()[:200]}")
            last_err = f"HTTP {e.code}"
        except Exception as e:  # SSL/сеть/таймаут
            last_err = str(e)
        time.sleep([5, 15, 30, 0][attempt])
    raise RuntimeError(f"{short}: сервер не ответил после 4 попыток ({last_err})")


def send_telegram(text):
    url = f"https://api.telegram.org/bot{os.environ['TG_TOKEN']}/sendMessage"
    data = json.dumps({"chat_id": os.environ["TG_CHAT_ID"], "text": text}).encode()
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
            urllib.request.urlopen(req, timeout=30).read()
            return
        except Exception:
            if attempt == 2:
                raise
            time.sleep(5)


def login():
    data = http(f"{API}/auth/login", {
        "application_key": APP_KEY,
        "id_city": None,
        "username": os.environ["JOURNAL_LOGIN"],
        "password": os.environ["JOURNAL_PASSWORD"],
    })
    token = (data or {}).get("access_token")
    if not token:
        raise RuntimeError("Вход прошёл, но токена в ответе нет")
    return token


def get_schedule(token, day):
    data = http(f"{API}/schedule/operations/get-by-date?date_filter={day}", token=token)
    lessons = data if isinstance(data, list) else (data or {}).get("data", [])
    return sorted(lessons, key=lambda l: str(l.get("started_at", "")))


def hm(s):
    return str(s or "")[:5]


def weather_for(i):
    url = (
        "https://api.open-meteo.com/v1/forecast"
        f"?latitude={LAT}&longitude={LON}&timezone=auto&forecast_days=2&wind_speed_unit=ms"
        "&daily=temperature_2m_min,temperature_2m_max,apparent_temperature_min,"
        "apparent_temperature_max,precipitation_probability_max,wind_speed_10m_max,"
        "snowfall_sum,rain_sum,showers_sum"
    )
    with urllib.request.urlopen(url, timeout=30) as r:
        d = json.loads(r.read().decode())["daily"]
    tmin, tmax = round(d["temperature_2m_min"][i]), round(d["temperature_2m_max"][i])
    feels = round((d["apparent_temperature_min"][i] + d["apparent_temperature_max"][i]) / 2)
    rain = d["precipitation_probability_max"][i] or 0
    wind = round(d["wind_speed_10m_max"][i])
    snow = d["snowfall_sum"][i] or 0
    liquid = (d["rain_sum"][i] or 0) + (d["showers_sum"][i] or 0)

    if feels <= -10:
        tip = "🥶 очень холодно — шапка и перчатки"
    elif feels <= 3:
        tip = "🧥 холодно — одевайся тепло"
    elif feels <= 12:
        tip = "🧥 прохладно — куртка"
    elif feels >= 25:
        tip = "☀️ жарко — одевайся легко"
    else:
        tip = "👕 комфортно"
    if rain >= 40:
        if snow > 0 and liquid > 0.2:
            tip += f" · 🌨 снег с дождём — зонт ({rain}%)"
        elif snow > 0:
            tip += f" · ❄️ снег ({rain}%)"
        else:
            tip += f" · ☔ зонт ({rain}%)"
        if snow > 0 and tmin <= 0 <= tmax:
            tip += " · ⚠️ скользко"
    if wind >= 10:
        tip += " · 💨 ветер"
    return f"🌦 Погода: {tmin}…{tmax}°, осадки {rain}%, ветер {wind} м/с\n{tip}"


WEEKDAYS = ["понедельник", "вторник", "среду", "четверг", "пятницу", "субботу", "воскресенье"]
