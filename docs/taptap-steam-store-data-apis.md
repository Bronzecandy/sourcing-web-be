# TapTap & Steam — technical guide for rankings and catalog ingest

Standalone API notes so another team can call these endpoints and adapt them to their own stack. Independent of the Sourcing codebase.

**Recommended scope**

| Platform | Stable to pull | Do not expect |
|---|---|---|
| **TapTap** | All public **ranking boards** (main + genre) plus per-`appId` detail/reviews | A dump of *every* game on TapTap — **there is no catalog API** |
| **Steam** | **Every Store app** (`GetAppList`) plus per-app detail/reviews; optional most-played chart | A single GET that returns full metadata + all reviews for the entire catalog |

Last updated: 2026-09-17.

---

## 0. Official / community documentation indexes

### Steam (official docs exist)

| Topic | URL |
|---|---|
| Web API overview (`key`, `input_json`) | https://partner.steamgames.com/doc/webapi_overview |
| **Full Steamworks Web API interface list** | https://partner.steamgames.com/doc/webapi |
| Store catalog — `IStoreService/GetAppList` | https://partner.steamgames.com/doc/webapi/IStoreService |
| Apps — `ISteamApps` (`GetAppList` v2 is **deprecated**) | https://partner.steamgames.com/doc/webapi/ISteamApps |
| User review dump (Store) | https://partner.steamgames.com/doc/store/getreviews |
| Free Web API key | https://steamcommunity.com/dev/apikey |
| Community mirror (many methods missing from partner docs) | https://steamapi.xpaw.me/ |

Store endpoints under `store.steampowered.com/api/*` and `/appreviews/*` are **not** in the full Steamworks table. Valve documents reviews on the Get List page above.

### TapTap (no public catalog API)

| Topic | URL |
|---|---|
| Developer portal / docs (Open API for **your own games**, store KPIs — **not** a public ranking dump) | https://developer.taptap.cn/docs/ |
| Ranking metric definitions (some Android boards cap at 150, iOS at 50) | https://developer.taptap.cn/docs/en/store/operation/metrics/ |
| Web ranking pages (use Network tab to confirm `type_name`) | https://www.taptap.cn/top/download |
| Unofficial web JSON family (same origin as the site) | `https://www.taptap.cn/webapiv2/...` |

**TapTap does not publish an OpenAPI for rankings.** Every ranking/detail/review path below is an **internal taptap.cn web API** (`webapiv2`), reverse-engineered from the web client. Paths, fields, and `type_name` values can change without notice. Datacenter IPs often hit WAF/403 — call from a residential IP or a sidecar proxy.

---

## 1. TapTap — ranking boards (primary use case)

### 1.1 Endpoint

```
GET https://www.taptap.cn/webapiv2/app-top/v2/hits
```

Same family as `https://www.taptap.cn/top/{slug}`.

### 1.2 Headers and `X-UA` (required)

Missing `X-UA` usually returns **HTTP 400**. Send it as a query param and set a browser-like `User-Agent`.

Example `X-UA` (generate a new `UID` per session):

```
V=1&PN=WebApp&LANG=zh_CN&VN_CODE=102&LOC=CN&PLT=PC&DS=Android&UID=<uuid>&OS=Windows&OSV=10&DT=PC
```

Suggested headers:

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36
Referer: https://www.taptap.cn/
Accept: application/json, text/plain, */*
```

### 1.3 Query parameters

| Param | Required | Meaning |
|---|---|---|
| `type_name` | Yes | Board id — see §1.4 |
| `from` | Yes | Offset, start at `0` |
| `limit` | Yes | Page size. The web client typically uses `10`. Keep it small (try 10–30). |
| `X-UA` | Yes | Client fingerprint (§1.2) |
| `platform` | No | `android` or `ios` — split charts by OS when the site requires it |

Typical response:

```json
{
  "success": true,
  "data": {
    "total": 200,
    "list": [
      {
        "app": {
          "id": 1390,
          "title": "...",
          "icon": { "url": "https://..." },
          "stat": {
            "rating": { "score": "8.5" },
            "hits_total": 1000000,
            "play_total": 0,
            "review_count": 0,
            "fans_count": 0,
            "reserve_count": 0
          },
          "tags": [{ "id": 1, "value": "开放世界" }]
        }
      }
    ]
  }
}
```

- `data.total` = board length (often ~150–200 depending on board/OS).
- Rank = `from + index` (1-based).
- App id = `data.list[i].app.id`.
- The nested `app` object is close to the detail payload (title/icon/tags/stats).

### 1.4 `type_name` — main boards + genre boards

Public scrapers use two slug families. **Prefer the slug that matches the URL** `/top/{slug}`. If `success=false` or the list is empty, try the “akshare alias” column.

**Main boards**

| Label on site | URL | `type_name` (slug) | Alias used by some crawlers |
|---|---|---|---|
| 热门榜 (Hot / downloads) | `/top/download` | `download` | `hot` |
| 热玩榜 (Most played) | `/top/played` | `played` | `pop` |
| 新品榜 (New) | `/top/new` | `new` | `new` |
| 预约榜 (Pre-register) | `/top/reserve` | `reserve` | `reserve` |
| 热卖榜 (Top selling) | `/top/sell` | `sell` | `sell` |
| 独家榜 (Exclusive) | `/top/exclusive` | `exclusive` | — |

**Genre boards** (same `app-top/v2/hits` endpoint; slug = `type_name`)

`action`, `strategy`, `idle`, `single`, `casual`, `sandbox`, `management`, `unriddle`, `shooter`, `multiplayer`, `acgn`, `music`, `scenario`, `swordsman`, `otome`, `independent`, `roguelike`

When TapTap adds a board: open `https://www.taptap.cn/top/<slug>`, DevTools → Network → filter `app-top/v2/hits` → read `type_name`.

To pull **all rankings**: iterate every slug above × (`platform` android/ios if needed) × paginate until `total`.

### 1.5 Ranking pagination

```
from = 0
loop:
  GET ...?type_name={slug}&from={from}&limit=10&X-UA=...
  append data.list
  if list empty or len(collected) >= data.total: break
  from += len(list)
  sleep 400–1500 ms
```

### 1.6 curl — one page of the Hot board

```bash
XUA='V=1&PN=WebApp&LANG=zh_CN&VN_CODE=102&LOC=CN&PLT=PC&DS=Android&UID=00000000-0000-0000-0000-000000000001&OS=Windows&OSV=10&DT=PC'

curl -sG 'https://www.taptap.cn/webapiv2/app-top/v2/hits' \
  --data-urlencode "type_name=download" \
  --data-urlencode "from=0" \
  --data-urlencode "limit=10" \
  --data-urlencode "X-UA=${XUA}" \
  -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36' \
  -H 'Referer: https://www.taptap.cn/'
```

### 1.7 Python — fetch an entire board

```python
import time, uuid, urllib.parse, urllib.request, json

BASE = "https://www.taptap.cn/webapiv2/app-top/v2/hits"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36"

def xua():
    return (
        "V=1&PN=WebApp&LANG=zh_CN&VN_CODE=102&LOC=CN&PLT=PC&DS=Android"
        f"&UID={uuid.uuid4()}&OS=Windows&OSV=10&DT=PC"
    )

def fetch_board(type_name: str, limit: int = 10, pause_s: float = 0.5):
    rows, offset = [], 0
    total = None
    while True:
        qs = urllib.parse.urlencode({
            "type_name": type_name,
            "from": offset,
            "limit": limit,
            "X-UA": xua(),
        })
        req = urllib.request.Request(
            f"{BASE}?{qs}",
            headers={"User-Agent": UA, "Referer": "https://www.taptap.cn/", "Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        data = payload.get("data") or {}
        batch = data.get("list") or []
        if total is None:
            total = data.get("total")
        if not batch:
            break
        rows.extend(batch)
        if total is not None and len(rows) >= int(total):
            break
        offset += len(batch)
        time.sleep(pause_s)
    return rows
```

All boards:

```python
MAIN = ["download", "played", "new", "reserve", "sell", "exclusive"]
GENRE = [
    "action", "strategy", "idle", "single", "casual", "sandbox", "management",
    "unriddle", "shooter", "multiplayer", "acgn", "music", "scenario",
    "swordsman", "otome", "independent", "roguelike",
]
# for slug in MAIN + GENRE: fetch_board(slug)
```

If `download` is empty, try `hot`. If `played` is empty, try `pop`.

### 1.8 Detail + reviews (after you have `appId` from a board)

Not required if you only need rankings; use these to enrich.

**Detail (one app)**

```
GET https://www.taptap.cn/webapiv2/app/v4/detail?id={appId}&X-UA=...
```

Older clients still use: `GET .../app/v2/detail-by-id/{appId}?X-UA=...`

Returns JSON `data` (title, icon, tags, stat, screenshots, `information` / publisher rows, …).

**Reviews (one app)**

```
GET https://www.taptap.cn/webapiv2/review/v2/list-by-app
  ?app_id={appId}&sort=new&from={offset}&limit=10&X-UA=...
```

- Practical `limit` is ~10.
- Increase `from` by 10 each page.
- **`from` caps around 9900** → roughly **≤ 1000 reviews** per game; not an unlimited dump.
- Useful items usually have `type == "moment"` → `moment.review.contents.text`, `moment.review.score` (1–5), `moment.publish_time` (unix).

### 1.9 Search / hot keywords (not rankings; optional)

```
GET https://www.taptap.cn/webapiv2/mix-search/v1/by-keyword?kw={keyword}&X-UA=...
GET https://www.taptap.cn/webapiv2/search/v4/placeholder?X-UA=...
```

Use to pick up ids outside rankings. **Not** a full-platform catalog.

### 1.10 TapTap operational constraints

- Unofficial → watch `success` and `data.list[].app`.
- Rate limit: 400ms–2s between requests; one worker if the IP is 403-prone.
- Datacenter IPs: use a proxy (Sourcing pattern: a sidecar that calls `webapiv2` for the backend).
- Official ranking KPIs (TapTap developer docs): some Android boards max 150, iOS max 50 — web `total` can differ; treat `data.total` as the source of truth for that call.

---

## 2. Steam — full Store catalog and related APIs

Two layers:

1. **Catalog** (name + appid for every Store item) — official, needs a **key**.
2. **Detail / reviews / most-played chart** — per app or a small chart.

### 2.1 Pull **all apps** — `IStoreService/GetAppList`

This is the correct API for a full Steam catalog. `ISteamApps/GetAppList/v2` is **deprecated** and often 404s.

```
GET https://api.steampowered.com/IStoreService/GetAppList/v1/
```

(Alternate host in Valve docs: `https://partner.steam-api.com/IStoreService/GetAppList/v1/`.)

Interfaces named `*Service` can also take args as URL-encoded `input_json`. Plain query strings still work.

| Param | Required | Meaning |
|---|---|---|
| `key` | Yes | Web API key from https://steamcommunity.com/dev/apikey |
| `include_games` | No | Default: **games only**. `true`/`false` |
| `include_dlc` | No | Default off |
| `include_software` | No | Default off |
| `include_videos` | No | Default off |
| `include_hardware` | No | Default off |
| `max_results` | No | Default ~10k, **max 50_000** per call |
| `last_appid` | No | Last appid from the previous page — pagination |
| `if_modified_since` | No | Unix time — incremental sync |
| `have_description_language` | No | Description language filter (e.g. `english`) |

Response (trimmed):

```json
{
  "response": {
    "apps": [
      { "appid": 10, "name": "Counter-Strike", "last_modified": 1710000000, "price_change_number": 1 }
    ],
    "have_more_results": true,
    "last_appid": 123456
  }
}
```

**Catalog loop**

```
last_appid = unset on first request
loop:
  GET ...&include_games=true&include_dlc=false&max_results=50000&last_appid={last}
  append response.apps
  if not response.have_more_results: break
  last = response.last_appid
```

You only get `appid` + `name` (+ `last_modified`). **No** genre, reviews, or header image.

curl:

```bash
curl -sG 'https://api.steampowered.com/IStoreService/GetAppList/v1/' \
  --data-urlencode "key=YOUR_STEAM_WEB_API_KEY" \
  --data-urlencode "include_games=true" \
  --data-urlencode "include_dlc=false" \
  --data-urlencode "include_software=false" \
  --data-urlencode "include_videos=false" \
  --data-urlencode "include_hardware=false" \
  --data-urlencode "max_results=50000"
```

Python:

```python
import urllib.parse, urllib.request, json, time

KEY = "YOUR_STEAM_WEB_API_KEY"
URL = "https://api.steampowered.com/IStoreService/GetAppList/v1/"

def get_all_games(key: str):
    apps, last = [], None
    while True:
        params = {
            "key": key,
            "include_games": "true",
            "include_dlc": "false",
            "include_software": "false",
            "include_videos": "false",
            "include_hardware": "false",
            "max_results": "50000",
        }
        if last:
            params["last_appid"] = str(last)
        qs = urllib.parse.urlencode(params)
        with urllib.request.urlopen(f"{URL}?{qs}", timeout=60) as r:
            body = json.loads(r.read().decode("utf-8"))
        resp = body.get("response") or {}
        batch = resp.get("apps") or []
        apps.extend(batch)
        if not resp.get("have_more_results"):
            break
        last = resp.get("last_appid")
        if last is None:
            break
        time.sleep(0.3)
    return apps
```

Incremental: store `max(last_modified)` from the last run, then pass `if_modified_since=<unix>`.

### 2.2 App detail — Store `appdetails` (no key)

```
GET https://store.steampowered.com/api/appdetails?appids={appid}&l=english
```

- HTTP 200 does **not** mean the app is valid. Read `{appid}.success`, then `{appid}.data`.
- Filter `data.type === "game"` if the catalog also contains DLC/tools (`music`, `dlc`, `tool`).
- Includes name, developers, publishers, genres, categories, header_image, about_the_game, price… **No** review text.
- Practical rate limit (community): about **~200 requests / 5 minutes / IP** → ~1.5s per app for a large crawl. Use `filters=basic` for a smaller payload.

```bash
curl -s 'https://store.steampowered.com/api/appdetails?appids=570&l=english'
```

### 2.3 Reviews — Store `appreviews` (no key)

Docs: https://partner.steamgames.com/doc/store/getreviews

```
GET https://store.steampowered.com/appreviews/{appid}?json=1
```

| Param | Suggested for a dump |
|---|---|
| `json` | `1` |
| `filter` | `recent` or `updated` when paging with `cursor` (`all` = helpfulness — **not** suitable for sequential dumps) |
| `language` | `all` |
| `review_type` | `all` |
| `purchase_type` | `all` |
| `num_per_page` | max **100** |
| `cursor` | first page `*` (URL-encode); later pages = `cursor` from JSON |
| `filter_offtopic_activity` | `0` for a fuller set |

`query_summary`: `total_positive`, `total_negative`, `total_reviews`, `review_score_desc`.

Each review: `recommendationid`, `review`, `voted_up` (bool — Steam has **no** 1–5 star scale), `timestamp_created`.

Stop when `reviews` is empty or `cursor` does not change.

```bash
curl -sG 'https://store.steampowered.com/appreviews/570' \
  --data-urlencode 'json=1' \
  --data-urlencode 'filter=recent' \
  --data-urlencode 'language=all' \
  --data-urlencode 'review_type=all' \
  --data-urlencode 'purchase_type=all' \
  --data-urlencode 'num_per_page=100' \
  --data-urlencode 'cursor=*' \
  --data-urlencode 'filter_offtopic_activity=0'
```

### 2.4 Steam charts (optional; not a substitute for the catalog)

Catalog ≠ chart. For “most played right now”:

```
GET https://api.steampowered.com/ISteamChartsService/GetMostPlayedGames/v1/
```

- Community usage often works **without** a key; xpaw may mark `key` as required depending on the method — try without a key first.
- Returns `response.ranks[]`: `rank`, `appid`, concurrent/peak — **no names**. Resolve names via `appdetails`.
- Community index: https://steamapi.xpaw.me/ISteamChartsService

Featured/deals (not a full chart):

```
GET https://store.steampowered.com/api/featuredcategories/
```

### 2.5 Steam operational constraints

- Keep the key on the server; never embed it in a frontend.
- Catalog: a few 50k pages finish the list.
- Full detail for every game: **days**, because of `appdetails` rate limits.
- Full reviews for every game: even heavier; cap per product (e.g. 10k/app as in Sourcing).
- Map `voted_up` onto a 5-star scale if you need TapTap parity (Sourcing: true → 5, false → 2).

---

## 3. Suggested pipeline for another project

```
TapTap
  for each type_name in MAIN ∪ GENRE:
    paginate app-top/v2/hits  → snapshot (date, board, rank, appId, raw app)
  optional: app/v4/detail + review/v2/list-by-app for ids in the snapshot

Steam
  paginate IStoreService/GetAppList     → catalog table (appid, name, last_modified)
  optional: ISteamChartsService          → most-played chart
  optional queue: appdetails + appreviews per appid (throttled)
```

Store snapshots by **date + board** (TapTap) / **appid + last_modified** (Steam) for incremental runs.

Concurrency: TapTap **1** (proxy on 403). Steam catalog is cheap; detail **1 request / ≥1.5s**.

---

## 4. API checklist

**TapTap rankings**

- [x] `GET /webapiv2/app-top/v2/hits` — every board via `type_name` + `from`/`limit` + `X-UA`
- [x] Main + genre slug tables
- [x] Detail `app/v4/detail`, reviews `review/v2/list-by-app` (enrichment)

**Steam all apps**

- [x] `GET /IStoreService/GetAppList/v1` + `last_appid` pagination
- [x] `appdetails`, `appreviews` (optional)
- [x] Links: Steamworks index + GetReviews + xpaw

**Does not exist**

- TapTap: list every appid on the platform
- Steam: one endpoint that dumps full detail + reviews for the entire store
