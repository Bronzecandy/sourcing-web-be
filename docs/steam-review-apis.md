# API Steam đang dùng để kéo review

Tài liệu này ghi **đúng những gì backend Sourcing đang gọi** khi phân tích game Steam. Không dùng Steamworks Web API, không cần API key.

Code: `be/src/services/steam-client.service.ts`.  
Gọi từ `POST /api/analysis/analyze-external` khi `platform = "steam"`.

Input hợp lệ: URL `https://store.steampowered.com/app/{appId}/...` hoặc số App ID.

---

## Tóm tắt

| API | Có key? | Dùng để |
|---|---|---|
| `GET /api/appdetails` | Không | Metadata game (tên, studio, tag, mô tả, ảnh). **Không** có nội dung review. |
| `GET /appreviews/{appId}` | Không | Toàn bộ review text dùng cho phân tích AI. |

Cả hai gọi song song lúc bấm Phân tích. Prepare (chọn genre pack trước khi chạy AI) **chỉ** gọi `appdetails`.

Header mọi request:

```
Accept: application/json
User-Agent: Chrome 127 (override bằng env STEAM_USER_AGENT)
```

Retry tối đa 4 lần. HTTP 403/429 backoff dài hơn.

---

## 1. App detail — metadata, không phải review

```
GET https://store.steampowered.com/api/appdetails?appids={appId}&l=english
```

### Query

| Param | Giá trị đang gửi | Ý nghĩa |
|---|---|---|
| `appids` | App ID | Một game mỗi request |
| `l` | `english` | Ngôn ngữ mô tả store |

### Response dùng

`{ "{appId}": { "success": true, "data": { ... } } }`

| Field | Mục đích |
|---|---|
| `name` | Tên game trên UI và prompt AI |
| `header_image` | Icon / ảnh bìa |
| `developers[0]` | Điểm tiêu chí developer |
| `publishers[0]` | Nhà phát hành khi không có developer |
| `genres[].description` | Tag / genre pack |
| `categories[].description` | Tag bổ sung (cùng list với genre) |
| `short_description` | Mô tả ngắn trong ngữ cảnh AI |
| `about_the_game` | Mô tả dài, cắt 12.000 ký tự, bỏ HTML |

`success !== true` thì coi như không có metadata. Phân tích vẫn chạy nếu review kéo được, tên fallback `Steam App {id}`.

---

## 2. App reviews — nguồn review cho AI

```
GET https://store.steampowered.com/appreviews/{appId}?{query}
```

Tài liệu Valve (biến thể partner, khác endpoint community này):  
https://partner.steamgames.com/doc/store/getreviews

### Query đang gửi

| Param | Giá trị | Mục đích |
|---|---|---|
| `json` | `1` | Trả JSON |
| `filter` | `recent` | Mới nhất trước |
| `language` | `all` | Mọi ngôn ngữ |
| `review_type` | `all` | Cả recommend và not recommend |
| `purchase_type` | `all` | Cả mua game và nhận miễn phí |
| `num_per_page` | `100` | Tối đa Valve cho một trang |
| `cursor` | `*` rồi cursor trang sau | Phân trang |
| `filter_offtopic_activity` | `0` | Giữ review bị Steam đánh off-topic |

### Vòng lặp

1. Gọi trang đầu `cursor=*`.
2. Lấy `reviews[]`, bỏ trùng `recommendationid`.
3. Review ngắn hơn 5 ký tự thì bỏ.
4. Lấy `cursor` mới. Hết review, cursor không đổi, hoặc đủ cap thì dừng.
5. Nghỉ `STEAM_REVIEW_PAGE_DELAY_MS` (mặc định **350ms**) giữa các trang.

Cap: `STEAM_MAX_REVIEWS`, mặc định **10.000**, trần code **100.000**.

### Field từng review

| Field | Dùng thế nào |
|---|---|
| `review` | Nội dung gửi LLM |
| `voted_up` | Steam không có sao 1–5. `true` → 5★ Very Positive, `false` → 2★ Negative, để cùng thang với review TapTap |
| `timestamp_created` | Unix giây → ngày `YYYY-MM-DD`. Lọc theo cửa sổ review (all / 7–60 ngày / from–to) |
| `recommendationid` | Chống trùng khi lật trang |
| `cursor` (cấp response) | Trang tiếp theo |

Sau khi lọc cửa sổ ngày, danh sách này là input của rubric AI (`source = "steam"`).

---

## 3. API nội bộ Sourcing kích hoạt 2 call trên

| Endpoint | Khi nào | Steam nào được gọi |
|---|---|---|
| `POST /api/analysis/prepare` body `{ source: "external", platform: "steam", input }` | Mở màn hình chọn genre pack | Chỉ `appdetails` |
| `POST /api/analysis/analyze-external` body `{ platform: "steam", input, reviewWindow? }` | Bấm Phân tích | `appdetails` + `appreviews` |

Không lưu review Steam vào `AppReview`. Chỉ lưu kết quả AI.

---

## 4. Không dùng

Các API này có trong tài liệu catalog chung (`docs/taptap-steam-store-data-apis.md`) nhưng **app không gọi**:

- `IStoreService/GetAppList` — dump toàn catalog
- `ISteamApps/GetAppList`
- `ISteamChartsService/GetMostPlayedGames`
- Bất kỳ endpoint `api.steampowered.com` cần Web API key
