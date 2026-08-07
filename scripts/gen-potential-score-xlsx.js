/**
 * Generate Potential scoring docs (Quy mô + Tăng trưởng) matching Template.xlsx layout.
 * Usage: node scripts/gen-potential-score-xlsx.js
 */
const XLSX = require("xlsx");
const path = require("path");

function sheetFromAoA(aoa, merges) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 32 },
    { wch: 44 },
    { wch: 50 },
    { wch: 24 },
    { wch: 54 },
    { wch: 58 },
    { wch: 42 },
  ];
  if (merges) ws["!merges"] = merges;
  ws["!rows"] = aoa.map((_, i) => (i === 0 ? { hpt: 22 } : { hpt: 96 }));
  return ws;
}

const header = [
  "Hạng mục (trọng số)",
  "Công thức tổng",
  "Lý do",
  "Thành phần",
  "Công thức",
  "Bảng điểm + căn cứ từ phân phối",
  "Bảng data chi tiết",
];

const quymo = [
  header,
  [
    "Audience / Quy mô (65% Reserve · 45% Launch)",
    "Điểm = Điểm nền quy mô + (Điểm cộng tăng trưởng × Hệ số điều chỉnh)",
    'Trọng số lớn nhất vì "quy mô hiện tại + tốc độ lớn" là tín hiệu tiềm năng rõ ràng nhất trên bảng Quy mô. Gộp base + tăng trong cùng trụ Audience để tránh tính trùng với bảng Tăng trưởng (bảng đó dùng percentile riêng).',
    "Điểm quy mô (base)",
    "Tra giá trị reserve (Reserve) hoặc download (Launch) cuối kỳ theo thư viện mốc điểm.\n\nNếu nằm giữa 2 mốc thì điểm tăng dần theo thang logarit (dựa trên tỉ lệ gấp mấy lần, không phải hiệu số). VD: 1.5M nằm giữa 1M (80đ) và 2M (94đ) → khoảng 88đ.",
    "10K → 38đ\n100K → 52đ\n500K → 68đ\n1M → 80đ\n1.5M → 88đ\n2M → 94đ\n3M+ → 98–100đ.\n\nCăn cứ phân phối reserve: phần lớn game dưới 10K; chỉ ~5% vượt 500K, ~2% vượt 1M → vượt 1M là nhóm đầu ngành nên điểm cao. Đỉnh lớn nên tách thêm mốc 2M/3M.",
    "https://sourcing-web.run.ingarena.net/distribution?tab=reserve&year=all",
  ],
  [
    "",
    "",
    "",
    "Điểm cộng tăng trưởng",
    "Lấy (giá trị cuối kỳ − giá trị đầu kỳ) rồi tra theo thư viện mốc tăng. Đây là phần phụ trong trụ Audience của bảng Quy mô (không phải điểm momentum của bảng Tăng trưởng).",
    "Giữ nguyên → 0đ\n+1–5K → +6đ\n+5–10K → +10đ\n+10–20K → +14đ\n+20–50K → +18đ\n+50–100K → +22đ\n+100K↑ → +28đ\nGiảm → −2 đến −20đ.\n\nCăn cứ phân phối tốc độ tăng: phần lớn game chỉ tăng vài nghìn/kỳ; tăng tuyệt đối >100K rất hiếm → cộng điểm cao hơn.",
    "",
  ],
  [
    "",
    "",
    "",
    "Hệ số điều chỉnh",
    "Hệ số = 25% + 75% × (phần còn thiếu để điểm nền đạt 100). Điểm nền càng cao → hệ số càng nhỏ → tăng trưởng tác động ít dần với game đã lớn.",
    "Điểm nền → Hệ số\n38 → 71%\n68 → 49%\n80 → 40%\n94 → 30%\n100 → 25% (sàn).\n\nLý do: game nhỏ thì tốc độ tăng là tín hiệu quan trọng nên giữ gần nguyên (~70–100%); game đã rất lớn tăng chậm là bình thường (gần bão hòa) nên còn ~25–30%; sàn 25% để vẫn phân biệt game còn tăng với game đứng yên.",
    "",
  ],
  [
    "Rating / Đánh giá (25% Reserve · 15% Launch)",
    "Điểm = Điểm nền + Điều chỉnh biến động",
    'Phản ánh chất lượng người chơi cảm nhận. Tách "điểm nền" và "biến động" để game đã có rating cao không bị thiệt chỉ vì hết dư địa tăng.',
    "Điểm nền",
    "Mốc gốc 5★ = 15đ, cứ thêm 1★ thì +15đ (tương đương mỗi 0.1★ = +1.5đ). Lấy mức rating đầu kỳ làm nền.",
    '8.0★ → 60đ\n9.0★ → 75đ\n9.5★ → 82.5đ\n10★ → 90đ.\n\nCăn cứ phân phối rating: trung bình ~7.6★, phần lớn game ≥8★ → đặt 8★ = 60đ làm mốc "khá phổ biến", 10★ = 90đ làm mốc xuất sắc. Không dùng xếp hạng phần trăm vì cách đó khiến game giữ nguyên 9.5★ bị tụt điểm vô lý.',
    "",
  ],
  [
    "",
    "",
    "",
    "Điều chỉnh biến động",
    "Mỗi 0.1★ thay đổi trong kỳ = ±5đ, cộng/trừ thẳng vào điểm nền.",
    "0.1★ → +5đ\n−0.1★ → −5đ\nGiữ nguyên → 0đ.\n\nLý do: điều chỉnh nhẹ để game 9.4★ giảm còn 9.3★ chỉ mất 5đ (vẫn rất tốt), không bị phạt nặng; game cải thiện rating được thưởng tương xứng.",
    "",
  ],
  [
    "Xếp hạng / Chất lượng hạng (10% Reserve · 20% Launch)",
    "Điểm = 0.4×vị trí + 0.2×%ngày top20 + 0.1×chuỗi top20 + 0.1×ổn định + 0.2×leo/giữ hạng",
    'Reserve chỉ 10% vì hạng đăng ký trước phản ánh "độ nóng tức thời", không phản ánh quy mô tích lũy. Launch nâng lên 20% vì hạng Pop/Hot/New gắn chặt hơn với sức sống sau mở.',
    "Điểm vị trí trung bình của chu kỳ",
    "Trung bình cộng điểm theo bậc hạng từng ngày trong cửa sổ 7/14/30 ngày (Reserve: hạng reserve; Launch: hạng board chính Pop>Hot>New).",
    'Top 1–10 → 100đ\n11–20 → 80đ\n21–50 → 55đ\n51–100 → 30đ\n101–200 → 12đ\nNgoài 200 → 0đ.\n\nLý do: chia mốc nghiêm để chỉ game đứng top 20 đều đặn mới đạt điểm cao; tránh tình trạng cũ cứ nằm trong top 200 đã tính "ổn định".',
    "",
  ],
  [
    "",
    "",
    "",
    "Tín hiệu phụ",
    "Cộng thêm:\n% ngày trong top 20\nchuỗi ngày liên tiếp top 20\nđộ ổn định (hạng ít dao động)\nleo hạng / giữ đỉnh.",
    "% ngày top 20 → 20%\nChuỗi top 20 → 10%\nỔn định → 10%\nLeo/giữ hạng → 20%.\n\nLý do: hạng cao một ngày chưa đủ, phải đứng cao đều đặn và ổn định; gộp mọi tín hiệu về hạng vào một hạng mục để không tính trùng.",
    "",
  ],
  [
    "Launch board (chỉ Launch · 15%)",
    "Điểm = 0.6×chất BXH + 0.25×consistency + 0.15×coverage",
    "Chỉ áp dụng bảng Launch: đo độ phủ và chất lượng trên Pop / Hot / New (ưu tiên Pop > Hot > New).",
    "Chất BXH / Consistency / Coverage",
    "Chất BXH: base theo board chính × hệ số hạng.\nConsistency: tỉ lệ ngày có mặt Pop/Hot/New.\nCoverage: số board đang active cùng lúc.",
    "Coverage gợi ý: Pop+Hot+New = 100; Pop+Hot = 85; chỉ Pop = 55; chỉ Hot = 25; chỉ New = 10.\n\nPre-launch (+5% Launch): bonus nhỏ từ tăng reserve trước ngày launch đầu trong cửa sổ.",
    "",
  ],
  [
    "Điểm tổng bảng Quy mô",
    "Reserve: 0.65×Audience + 0.25×Rating + 0.10×RankQuality\nLaunch: 0.45×Audience + 0.15×Rating + 0.20×RankQuality + 0.15×LaunchBoard + 0.05×PreLaunch",
    "Thứ hạng bảng Quy mô = sắp xếp theo compositeScore. Có sàn bảo vệ: nếu Audience ≥ 70 và Rating ≥ 55 thì hạng BXH không kéo composite xuống dưới trung bình 2 trụ đó − 2.",
    "Sàn bảo vệ",
    "Khi Audience & Rating đủ mạnh, composite = max(composite thô, (Audience+Rating)/2 − 2).",
    "Audience ≥ 70 và Rating ≥ 55 → kích hoạt sàn. Mục tiêu: game quy mô lớn + rating tốt không bị hạng tạm thời kéo tụt quá sâu.",
    "",
  ],
];

const quymoMerges = [
  { s: { r: 1, c: 0 }, e: { r: 3, c: 0 } },
  { s: { r: 1, c: 1 }, e: { r: 3, c: 1 } },
  { s: { r: 1, c: 2 }, e: { r: 3, c: 2 } },
  { s: { r: 4, c: 0 }, e: { r: 5, c: 0 } },
  { s: { r: 4, c: 1 }, e: { r: 5, c: 1 } },
  { s: { r: 4, c: 2 }, e: { r: 5, c: 2 } },
  { s: { r: 6, c: 0 }, e: { r: 7, c: 0 } },
  { s: { r: 6, c: 1 }, e: { r: 7, c: 1 } },
  { s: { r: 6, c: 2 }, e: { r: 7, c: 2 } },
  { s: { r: 1, c: 6 }, e: { r: 9, c: 6 } },
];

const tangtruong = [
  header,
  [
    "Tăng trưởng chuẩn hóa (60%)",
    "growthNorm = min(Percentile cùng kỳ, Trần tuyệt đối theo ngày)\nmomentum = 0.6×growthNorm + 0.2×Rating + 0.2×RankQuality",
    "Trọng số lớn nhất trên bảng Tăng trưởng. Dùng percentile + trần tuyệt đối thay vì cộng thẳng vào quy mô, để game tăng nhẹ không được điểm cao chỉ vì ít đối thủ cùng kỳ tăng, và game tăng mạnh vẫn được phân biệt rõ.",
    "Percentile cùng kỳ",
    "Lấy Δ tuyệt đối trong cửa sổ (cuối − đầu): Reserve dùng reserveCount, Launch dùng downloadCount.\nXếp hạng percentile trong cohort cùng bảng (Reserve hoặc Launch) + cùng cửa sổ ngày (7/14/30…).",
    'Percentile 0–100 (mid-rank khi hòa).\nVD: đứng giữa cohort → ~50đ; top đầu về Δ tuyệt đối → gần 100đ.\n\nCăn cứ: so với các game đang xếp cùng bảng tiềm năng trong cùng kỳ — phản ánh "ai đang nóng hơn trong nhóm đang xét".',
    "Phân phối / potential board theo cửa sổ ngày đang chọn trên FE",
  ],
  [
    "",
    "",
    "",
    "Trần tuyệt đối (absCap)",
    "Đổi mức tăng thành tốc độ mỗi ngày (tăng bao nhiêu ÷ số ngày đang xét), rồi so với phổ tốc độ tăng của mọi game trong toàn bộ lịch sử dữ liệu (trượt các kỳ 7/14/30 ngày từ trước tới giờ) → ra mức điểm trần. Không so với chỉ các game đang cùng kỳ hiện tại.",
    "Tăng nhanh/ngày so với lịch sử → trần cao (gần 100).\nTăng chậm/ngày → trần thấp.\n\nNếu hệ thống chưa kịp gom phổ lịch sử: tạm lấy ~50đ rồi cộng thêm theo bậc tăng (quy về cửa sổ 14 ngày).\n\nLý do có trần: chỉ xếp hạng trong kỳ hiện tại thì dễ ảo — kỳ ít game tăng, tăng vài nghìn cũng thành \"top\". Trần buộc mức tăng phải đủ mạnh theo chuẩn từ trước tới giờ mới được điểm cao.",
    "",
  ],
  [
    "",
    "",
    "",
    "growthNorm (điểm trụ)",
    "Điểm trụ tăng trưởng = điểm thấp hơn giữa hai thước đo: xếp hạng trong kỳ hiện tại, và trần theo tốc độ tăng/ngày trên phổ toàn lịch sử. Giữ trong khoảng 0–100.",
    "Hai thước đo:\n(1) Trong kỳ này, game tăng mạnh hơn bao nhiêu game cùng bảng? (cùng kỳ)\n(2) Tốc độ tăng/ngày có đủ mạnh so với toàn bộ lịch sử không? (từ trước tới giờ)\n\nLấy mức thấp hơn → vừa phải \"nóng hơn đồng nghiệp kỳ này\", vừa phải \"tăng thật sự đáng kể theo chuẩn lịch sử\".\n\nTrên UI chi tiết game có thêm mốc tham chiếu phổ tốc độ/ngày (p50 / p75 / p90 / p95).",
    "",
  ],
  [
    "Rating / Đánh giá (20%)",
    "Cùng công thức bảng Quy mô: Điểm nền + Điều chỉnh biến động",
    "Giữ rating trong bảng Tăng trưởng (20%) để game tăng số nhưng rating kém không chiếm top; game tăng kèm chất lượng được ưu tiên hơn.",
    "Điểm nền + biến động",
    "Nền: 5★=15đ, mỗi +1★ = +15đ (đầu kỳ).\nBiến động: mỗi ±0.1★ trong kỳ = ±5đ.",
    "8.0★ → 60đ · 9.0★ → 75đ · 9.5★ → 82.5đ · 10★ → 90đ.\n±0.1★ → ±5đ.\n\nCùng căn cứ phân phối rating với bảng Quy mô; chỉ khác trọng số trong blend momentum.",
    "",
  ],
  [
    "Xếp hạng / Chất lượng hạng (20%)",
    "Cùng công thức bảng Quy mô: 0.4×vị trí + 0.2×%top20 + 0.1×chuỗi + 0.1×ổn định + 0.2×leo/giữ",
    '20% (cao hơn Reserve trên bảng Quy mô) vì trên bảng Tăng trưởng cần kết hợp "số đang tăng" với "hạng có cải thiện / đứng cao ổn".',
    "Vị trí + tín hiệu phụ",
    "Trung bình bậc hạng theo ngày trong cửa sổ; cộng %ngày top20, streak top20, ổn định, leo/giữ đỉnh.",
    "Top 1–10 → 100đ · 11–20 → 80đ · 21–50 → 55đ · 51–100 → 30đ · 101–200 → 12đ.\nPhụ: presence 20% · streak 10% · volatility 10% · movement 20%.",
    "",
  ],
  [
    "Điểm tổng bảng Tăng trưởng",
    "momentumScore = 0.6×growthNorm + 0.2×Rating + 0.2×RankQuality",
    'Thứ hạng bảng Tăng trưởng = sắp xếp theo momentumScore. Không dùng compositeScore của bảng Quy mô. Hai bảng độc lập để tách "đã lớn" vs "đang tăng mạnh".',
    "Khác biệt với bảng Quy mô",
    "Quy mô: Audience gộp base tier + growth bonus (trọng số 65%/45%).\nTăng trưởng: không dùng điểm Audience đó; dùng growthNorm percentile + absCap (60%).",
    "Cùng Rating & RankQuality làm đầu vào, nhưng trọng số khác.\nLaunch board / pre-launch chỉ nằm ở bảng Quy mô (Launch), không vào momentum.",
    "",
  ],
];

const ttMerges = [
  { s: { r: 1, c: 0 }, e: { r: 3, c: 0 } },
  { s: { r: 1, c: 1 }, e: { r: 3, c: 1 } },
  { s: { r: 1, c: 2 }, e: { r: 3, c: 2 } },
  { s: { r: 1, c: 6 }, e: { r: 6, c: 6 } },
];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, sheetFromAoA(quymo, quymoMerges), "Bang Quy Mo");
XLSX.utils.book_append_sheet(wb, sheetFromAoA(tangtruong, ttMerges), "Bang Tang Truong");

const out =
  process.argv[2] ||
  path.join(
    process.env.USERPROFILE || ".",
    "Downloads",
    "Potential_QuyMo_TangTruong.xlsx",
  );

XLSX.writeFile(wb, out);
console.log("Wrote", out);
