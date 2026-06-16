# Điểm Tiềm Năng (Potential) — Bản thuyết trình ngắn gọn

> Phiên bản công thức: **Reserve v9** · **Launch v15** · Breakdown v9

---

## 1. Một câu tóm tắt

Điểm tiềm năng (0–100) trả lời câu hỏi: **"Game này đang mạnh và đang lên tới mức nào so với mặt bằng chung?"**

Chúng ta chấm theo **3 trụ điểm** chính (+ Launch), rồi nhân với **độ tin cậy dữ liệu**.

---

## 2. Ba trụ điểm chính (+ Launch)

| Trụ | Trả lời câu hỏi | Reserve | Launch |
|-----|-----------------|:------:|:------:|
| **Quy mô & tăng trưởng** | Game lớn cỡ nào và có đang lên không? | **65%** | 45% |
| **Đánh giá (Rating)** | Người chơi chấm chất lượng ra sao? | **25%** | 15% |
| **Chất lượng hạng** | Đứng cao và ổn định trên BXH không? | **10%** | 20% |
| *BXH Launch* | Mạnh trên Pop/Hot/New không? | — | 15% |
| *Bonus Reserve trước launch* | Trước khi ra mắt có hype không? | — | 5% |

> **v9:** Giảm trọng số hạng BXH Reserve (25% → 10%) vì hạng đăng ký trước phản ánh *tốc độ hot gần đây*, không phản ánh quy mô tích lũy — tránh phạt oan game lớn nhưng hạng tầm trung.

### Quy mô & tăng trưởng (gộp)
- **Base** theo quy mô tuyệt đối, **nội suy log** trong từng mốc (không còn "vách đứng" giữa các bucket).
- Mốc chính: 100K→52, 500K→68, 1M→80, **2M→94**, **3M→98**, 10M→100.
- **Bonus tăng trưởng** theo mốc tốc độ tăng Phân phối (cộng/trừ).
- Game **đã lớn** thì bonus tăng trưởng được **giảm trọng số** — tăng chậm trên nền 2M+ không bị trừ nặng.

### Đánh giá (Rating)
- **Base từ rating đầu kỳ**: 8★ → 60, 10★ → 90 (công thức `(rating−5)×15+15`).
- **±5 điểm mỗi 0.1** thay đổi trong kỳ.
- 9.5★ giữ nguyên → ~82.5 điểm (không còn bị ~51 vì "không tăng").

### Sàn bảo vệ (v9)
- Khi **Quy mô ≥ 70** và **Đánh giá ≥ 55**, điểm thô **không được thấp hơn** trung bình (Quy mô + Đánh giá) − 2.
- Hạng BXH vẫn có thể **đẩy điểm lên**, nhưng không kéo game lớn/chất lượng xuống.

---

## 3. Điểm mới quan trọng so với bản cũ

### a) Bỏ chồng chéo (overlap)
- **Bỏ hẳn Fan** khỏi công thức.
- **Gộp xếp hạng về một chỗ** — trụ "Chất lượng hạng" duy nhất.

### b) Chấm theo mốc phân phối + nội suy mượt
- Quy mô dùng **mốc cố định** từ tab Phân phối, **nội suy log** trong bucket → game 2M và 5M không còn cùng điểm 94.
- Tăng trưởng theo **số lượng tăng tuyệt đối**, không dùng %.

### c) Ổn định "gắt" hơn — thưởng top 10 / top 20
- Top 10 = 100, Top 20 = 80, Top 50 = 55, Top 100 = 30, Top 200 = 12.
- Cộng % ngày trong Top 20 và chuỗi ngày liên tiếp Top 20.

### d) Không phạt oan game lớn vì hạng BXH (v9)
- QA thực tế: game 5M reserve nhưng hạng #43, Fortnite 2M reserve hạng #96 — hạng BXH đăng ký trước không phản ánh quy mô.
- Giải pháp: giảm trọng số hạng (10%) + sàn bảo vệ khi Quy mô & Đánh giá đều mạnh.

---

## 4. Công thức tổng

```
Điểm thô = Quy mô×W1 + Đánh giá×W2 + Chất lượng hạng×W3
           (+ BXH Launch×W4 + Bonus Reserve×W5 cho game đã ra mắt)

Nếu Quy mô ≥ 70 và Đánh giá ≥ 55:
  Điểm thô = max(Điểm thô, trung bình(Quy mô, Đánh giá) − 2)

Điểm cuối = Điểm thô × Hệ số tin cậy (×0.3 → ×1.0 theo độ phủ dữ liệu)
```

- Trụ nào **thiếu dữ liệu** thì **bỏ ra và chia lại trọng số** cho các trụ còn lại.
- **Hệ số tin cậy**: càng nhiều ngày dữ liệu trong kỳ → càng đáng tin.

---

## 5. Điều này giúp gì cho công việc

- **Công bằng giữa game lớn và nhỏ**: game nhỏ không "ăn may" 100 điểm nhờ % tăng ảo; game lớn không bị hạng BXH nhiễu kéo xuống.
- **Phân biệt đầu bảng thật**: 2M vs 5M reserve có điểm nền khác nhau.
- **Ít trùng lặp, dễ giải thích**: 3 trụ rõ ràng, mỗi trụ một câu hỏi.

---

## 6. Liên hệ với tab "Phân phối" và "Tóm tắt AI"

- **Tab Phân phối** là "thước đo" hiệu chỉnh mốc Quy mô/Tăng trưởng.
- **Tóm tắt AI (Review)** mở đầu bằng **khối số liệu chính xác**; "Xu hướng gần đây" = **~60 ngày gần nhất**.
