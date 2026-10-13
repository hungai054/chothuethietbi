# PROMPT CHO CLAUDE CODE: NỀN TẢNG THƯƠNG MẠI QUẢN LÝ CHO THUÊ THIẾT BỊ

> **Trước khi dán vào Claude Code**, sửa các chỗ trong [ngoặc vuông]. Nếu không sửa, Claude Code dùng giá trị mặc định ghi bên cạnh.
>
> - Tên sản phẩm: [TÊN SẢN PHẨM] (mặc định: "RentPro")
> - Tên miền chính: [VD: rentpro.vn] (mặc định: `rentpro.local` khi dev)
> - Ngành khách hàng mục tiêu: [VD: cho thuê máy ảnh, âm thanh ánh sáng, sự kiện, xây dựng…]
> - Các gói bán: [VD: Cơ bản / Chuyên nghiệp / Doanh nghiệp] (mặc định như mục 2.5)
> - Cổng thu tiền thuê bao: [PayOS / chuyển khoản VietQR thủ công / khác] (mặc định: adapter cho cả hai)

---

## 1. Vai trò và mục tiêu

Bạn là kiến trúc sư phần mềm kiêm kỹ sư full-stack cấp cao. Hãy xây dựng **một sản phẩm phần mềm thương mại (SaaS)** quản lý cho thuê thiết bị, bán cho nhiều cửa hàng tại Việt Nam.

Mục tiêu kinh doanh quyết định kiến trúc:
1. **Một bộ mã nguồn duy nhất** phục vụ mọi khách hàng. Tuyệt đối không fork code theo khách hàng.
2. Chủ sản phẩm (tôi) **quản trị tập trung** mọi khách hàng: tạo tài khoản, đổi gói, bật/tắt tính năng, theo dõi sử dụng, hỗ trợ, khóa/mở.
3. **Tùy biến theo từng khách hàng** dễ dàng, an toàn: ưu tiên cấu hình; khi buộc phải viết code riêng thì code đó nằm trong module mở rộng tách biệt, nâng cấp lõi không làm hỏng tùy biến.
4. Hỗ trợ hai cách bán: **thuê bao trên nền tảng chung** và **cài đặt riêng** (máy chủ riêng cho khách lớn) — cùng một bộ code, khác cấu hình triển khai.

Yêu cầu chung:
- Giao diện mặc định **tiếng Việt**, kiến trúc sẵn sàng đa ngôn ngữ (có bản tiếng Anh). Múi giờ và tiền tệ là cấu hình theo từng khách hàng (mặc định `Asia/Ho_Chi_Minh`, VND lưu số nguyên).
- Responsive: quầy dùng máy tính, kho/kỹ thuật dùng điện thoại để quét mã.
- Chất lượng sản phẩm thương mại: kiểu dữ liệu chặt, có test, có tài liệu, có giám sát lỗi, có sao lưu.

## 2. Kiến trúc thương mại hóa (phần cốt lõi, làm đúng ngay từ đầu)

### 2.1. Đa khách hàng (multi-tenant)
- Mỗi cửa hàng là một **tenant**. Mọi bảng dữ liệu nghiệp vụ có cột `tenant_id`.
- Cách ly dữ liệu **hai lớp**:
  1. Prisma Client Extension tự động gắn `tenant_id` vào mọi truy vấn từ ngữ cảnh request.
  2. **PostgreSQL Row Level Security (RLS)** trên mọi bảng nghiệp vụ, đặt `app.tenant_id` qua `SET LOCAL` trong mỗi transaction. Kể cả code quên lọc thì DB vẫn chặn.
- Xác định tenant theo **subdomain** (`cuahang-a.rentpro.vn`) hoặc **tên miền riêng** của khách (bảng `tenant_domain`, có hướng dẫn trỏ DNS và cấp SSL).
- Bộ test bắt buộc **"rò rỉ chéo tenant"**: với mọi endpoint/service, dùng người dùng tenant A truy cập dữ liệu tenant B phải bị từ chối. Test này chạy trong CI và không được phép bỏ qua.
- Biến môi trường `DEPLOY_MODE=shared | dedicated`. Ở chế độ `dedicated` hệ thống chạy với đúng một tenant, ẩn phần đăng ký, nhưng code giống hệt.

### 2.2. Bốn tầng tùy biến theo khách hàng (dùng theo thứ tự, tầng trên làm được thì không xuống tầng dưới)

1. **Cấu hình (Settings)**: thông tin cửa hàng, quy tắc tính giá, ân hạn, phí trễ, mức cọc, thời gian giữ chỗ, mẫu mã số, khung giờ gửi tin… Lưu dạng JSON có schema Zod và phiên bản, có giá trị mặc định ở cấp hệ thống, tenant chỉ ghi đè phần khác biệt.
2. **Cờ tính năng (Feature flags)**: mỗi tính năng lớn có một khóa (VD: `booking.timeline`, `maintenance.usage_based`, `notify.zalo`, `reports.roi`, `contract.e_signature`, `multi_branch`). Giá trị hiệu lực = mặc định của gói ⟶ ghi đè theo tenant. Kiểm tra cờ ở **cả server và UI** qua một hàm duy nhất `can(tenant, featureKey)`.
3. **Tùy biến không cần code**:
   - **Trường tùy chỉnh** (custom fields) cho thiết bị, khách hàng, đơn thuê, hợp đồng: kiểu text/số/ngày/chọn/có-không/file; hiển thị trong form, danh sách, tìm kiếm, xuất Excel, chèn vào mẫu hợp đồng.
   - **Mẫu tài liệu**: hợp đồng, biên bản giao nhận, phiếu thu, tem nhãn, tin nhắn, email — tenant tự sửa, có xem trước.
   - **Nhãn và thuật ngữ**: đổi tên gọi (VD "Thiết bị" → "Sản phẩm", "Đơn thuê" → "Booking").
   - **Vai trò tùy chỉnh** với ma trận quyền chi tiết (gói cao).
   - **Thương hiệu (white-label)**: logo, màu chủ đạo, favicon, tên hiển thị, email gửi đi, chân trang PDF; gói cao được ẩn thương hiệu [TÊN SẢN PHẨM].
4. **Module mở rộng bằng code (Extensions)** — chỉ dùng khi ba tầng trên không đáp ứng:
   - Lõi định nghĩa **SDK** (`packages/extension-sdk`) với các điểm móc có kiểu rõ ràng, ví dụ:
     - `hooks.pricing.adjust(ctx, quote) → quote` (quy tắc giá đặc thù)
     - `hooks.booking.beforeCreate / afterConfirm / afterReturn`
     - `hooks.deposit.suggest(ctx, booking) → amount`
     - `hooks.notification.beforeSend(ctx, message) → message | null`
     - `hooks.contract.extraVariables(ctx, contract) → Record<string, string>`
     - `registerReport({ key, title, query, columns })` (báo cáo riêng)
     - `registerPage({ path, title, component, permission })` (trang riêng trong menu)
     - `registerJob({ name, cron, handler })` (tác vụ nền riêng)
     - `registerWebhook / registerIntegration` (kết nối phần mềm kế toán, CRM của khách)
   - Mỗi extension là một gói trong `extensions/<ma-khach-hang>/` có `manifest` (tên, phiên bản, phiên bản SDK tương thích, các điểm móc dùng, cấu hình riêng, migration riêng nếu cần — chỉ thêm bảng mới có tiền tố `ext_<ma>_`, không sửa bảng lõi).
   - Extension được **đăng ký tại build time** qua một registry, và **bật cho tenant nào** do cấu hình trong cổng quản trị quyết định. Lỗi trong extension phải được cô lập (try/catch, timeout, ghi log), không làm sập luồng lõi trừ móc được đánh dấu bắt buộc.
   - **Quy tắc cứng**: trong code lõi cấm mọi điều kiện kiểu `if (tenant.slug === 'abc')`. Viết một **ESLint rule tùy chỉnh** chặn so sánh với slug/ID tenant cụ thể, và rule cấm `packages/*` import từ `extensions/*`.
   - Có lệnh sinh khung: `pnpm ext:new <ma-khach-hang>` tạo sẵn cấu trúc, manifest, ví dụ một hook và test.
   - Làm sẵn **một extension mẫu** (VD: khách hàng tính giá cuối tuần +20% và có báo cáo riêng) để minh họa.

### 2.3. Gói dịch vụ và giới hạn
- Bảng `plan` cấu hình được trong cổng quản trị (không cứng trong code): giá theo tháng/năm, tập cờ tính năng, giới hạn.
- Mặc định 3 gói:
  - **Cơ bản**: 1 chi nhánh, 3 người dùng, 300 thiết bị, nhắc nhở qua email, báo cáo cơ bản.
  - **Chuyên nghiệp**: 3 chi nhánh, 10 người dùng, 2.000 thiết bị, Zalo ZNS/SMS, lịch timeline, bảo trì theo giờ sử dụng, toàn bộ báo cáo, trường tùy chỉnh.
  - **Doanh nghiệp**: không giới hạn, vai trò tùy chỉnh, white-label, tên miền riêng, extension riêng, API, cài đặt riêng.
- **Đo lường sử dụng** (usage metering): số thiết bị, người dùng, chi nhánh, tin nhắn đã gửi/tháng, dung lượng file. Kiểm tra giới hạn trong service khi tạo mới; vượt giới hạn hiển thị thông báo nâng cấp rõ ràng; cảnh báo khi dùng 80%.
- Hỗ trợ **gói riêng cho từng khách** (giá, giới hạn, tính năng tùy chỉnh) cho hợp đồng doanh nghiệp.

### 2.4. Thu tiền thuê bao
- Dùng thử miễn phí (mặc định 14 ngày, cấu hình được), không cần thẻ.
- Chu kỳ tháng/năm, tự sinh hóa đơn thuê bao, nhắc gia hạn trước 7 và 1 ngày.
- Thanh toán qua `BillingProvider` adapter: **PayOS** (webhook tự kích hoạt) và **chuyển khoản VietQR** (quản trị viên xác nhận thủ công). Có mã giảm giá, gia hạn thủ công cho hợp đồng ký ngoài.
- Hết hạn: ân hạn N ngày (cấu hình được) → chuyển **chỉ đọc** (xem và xuất dữ liệu được, không tạo mới) → khóa sau N ngày nữa. Không bao giờ tự xóa dữ liệu.
- Nâng/hạ gói giữa kỳ tính phí theo tỷ lệ ngày còn lại.

### 2.5. Cổng quản trị hệ thống (dành cho chủ sản phẩm)
Ứng dụng riêng `apps/admin`, đăng nhập riêng, bắt buộc xác thực 2 lớp (TOTP). Vai trò nền tảng: `SUPER_ADMIN`, `SUPPORT` (chỉ xem và hỗ trợ), `SALES` (tạo tenant, đổi gói).

Chức năng:
- **Danh sách khách hàng**: tìm, lọc theo gói/trạng thái/ngày hết hạn; chỉ số nhanh (số đơn tháng này, lần đăng nhập cuối, mức sử dụng so với giới hạn).
- **Tạo khách hàng thủ công** (cho bán hàng trực tiếp): chọn gói, subdomain, gửi email mời chủ cửa hàng, tùy chọn nạp dữ liệu mẫu theo ngành.
- **Chi tiết khách hàng**: đổi gói, ghi đè cờ tính năng, ghi đè giới hạn, bật/tắt extension và sửa cấu hình extension, quản lý tên miền, lịch sử thanh toán, ghi chú nội bộ, người phụ trách.
- **Đăng nhập thay (impersonate)** để hỗ trợ: bắt buộc nhập lý do, có thời hạn, hiện băng rôn cảnh báo trong phiên, ghi audit log, tenant xem được lịch sử truy cập hỗ trợ; không được xem giấy tờ tùy thân trong phiên này.
- **Tạm khóa / mở khóa / chuyển chỉ đọc** tenant.
- **Xuất toàn bộ dữ liệu** của một tenant (ZIP gồm JSON + Excel + file đính kèm) và **xóa tenant** (xóa mềm, giữ 30 ngày, xác nhận 2 bước).
- **Quản lý gói, mã giảm giá, hóa đơn thuê bao**.
- **Thông báo hệ thống** tới tất cả hoặc nhóm tenant (bảo trì, tính năng mới).
- **Báo cáo kinh doanh của tôi**: MRR, ARR, số tenant theo gói, khách mới, khách rời bỏ, tỷ lệ chuyển từ dùng thử sang trả phí, doanh thu theo tháng, khách sắp hết hạn.
- **Sức khỏe hệ thống**: hàng đợi tác vụ, lỗi gần đây theo tenant, tỷ lệ gửi tin thành công, dung lượng.
- **Kênh phát hành**: gán tenant vào `stable` hoặc `beta` để thử tính năng mới trên một nhóm khách trước.

### 2.6. Đăng ký và khởi tạo tự phục vụ
- Trang giới thiệu sản phẩm + bảng giá + đăng ký (ở chế độ `shared`).
- Đăng ký → xác thực email → **trình hướng dẫn khởi tạo**: thông tin cửa hàng, logo, chi nhánh, chọn ngành (nạp danh mục mẫu tương ứng), **nhập thiết bị từ file Excel** (có file mẫu, kiểm tra lỗi từng dòng, xem trước trước khi nhập), bảng giá, mời nhân viên.
- Danh sách việc "Bắt đầu sử dụng" trên dashboard cho tới khi hoàn tất.

### 2.7. Phiên bản, phát hành, nâng cấp
- Đánh phiên bản **SemVer**, `CHANGELOG.md`, tag git cho mỗi bản phát hành.
- Migration theo nguyên tắc **expand → migrate → contract** để nâng cấp không gián đoạn; migration phải chạy được trên mọi tenant cùng lúc.
- Cấu hình (settings, template) có số phiên bản và hàm nâng cấp schema khi lõi thay đổi.
- Extension SDK có phiên bản riêng; khi build, kiểm tra mọi extension tương thích với SDK hiện tại, không tương thích thì build thất bại.
- Bản cài đặt riêng có thể ghim phiên bản; có script nâng cấp một lệnh.

### 2.8. Vận hành và bảo mật
- Log có cấu trúc (pino), mọi dòng log mang `tenantId`, `userId`, `requestId`. Không log dữ liệu nhạy cảm.
- Giám sát lỗi Sentry (gắn tag tenant), endpoint `/healthz`, `/readyz`.
- Giới hạn tốc độ (rate limit) theo tenant và theo IP.
- **Bí mật riêng của từng tenant** (khóa Zalo OA, SMS, SMTP, PayOS…) mã hóa bằng khóa chủ trong biến môi trường (AES-256-GCM, có xoay khóa).
- Sao lưu DB tự động hằng ngày, giữ 30 ngày, có tài liệu và script khôi phục; khôi phục được một tenant riêng lẻ từ bản xuất.
- **API công khai** (gói Doanh nghiệp): REST có API key theo tenant, phạm vi quyền, tài liệu OpenAPI tự sinh; **webhook đi** khi có sự kiện (đơn mới, trả thiết bị, thanh toán) có ký HMAC và thử lại.
- Điều khoản sử dụng, chính sách quyền riêng tư, xác nhận đồng ý xử lý dữ liệu cá nhân (Nghị định 13/2023/NĐ-CP) có phiên bản và lưu thời điểm đồng ý.

## 3. Cách làm việc (bắt buộc)

1. **Lập kế hoạch trước**: đọc toàn bộ đặc tả, viết `docs/PLAN.md` gồm kiến trúc, ERD (Mermaid), ranh giới các gói, danh sách giai đoạn. Rồi bắt đầu làm luôn, chỉ dừng hỏi khi có điểm mâu thuẫn thật sự.
2. Làm theo **từng giai đoạn** (mục 11). Hết mỗi giai đoạn: chạy `typecheck`, `lint`, `test` (gồm test cách ly tenant); sửa hết lỗi; commit rõ ràng.
3. Logic nghiệp vụ nằm trong `packages/core` (thuần TypeScript, không phụ thuộc Next.js), có unit test. UI chỉ gọi service.
4. Không để `TODO` hay dữ liệu cứng. Tích hợp ngoài: adapter thật + bản giả lập, chuyển bằng biến môi trường.
5. Duy trì `CLAUDE.md` ở gốc repo: quy ước, lệnh, quyết định kiến trúc, **cách thêm tính năng mới (luôn kèm feature flag) và cách làm tùy biến cho khách hàng** — để các phiên sau làm đúng.
6. Mỗi tính năng mới phải trả lời: thuộc gói nào (feature key), có cần cấu hình không, có cần điểm móc cho extension không.

## 4. Cấu trúc repo (pnpm workspace + Turborepo)

```
apps/
  web/          # Ứng dụng cho cửa hàng (Next.js)
  admin/        # Cổng quản trị hệ thống (Next.js)
  worker/       # Tác vụ nền (pg-boss)
  marketing/    # Trang giới thiệu, bảng giá, đăng ký (có thể gộp vào web)
packages/
  core/             # Nghiệp vụ: booking, pricing, deposit, maintenance, reports
  db/               # Prisma schema, migrations, RLS, seed
  tenancy/          # Ngữ cảnh tenant, phân giải domain, feature flags, giới hạn gói
  extension-sdk/    # Kiểu và API cho extension
  notifications/    # Zalo ZNS, SMS, Email, Console
  billing/          # PayOS, VietQR, hóa đơn thuê bao
  ui/               # Thành phần giao diện dùng chung (shadcn/ui)
  i18n/             # Bản dịch, nhãn tùy biến
  config/           # eslint (gồm rule cấm hardcode tenant), tsconfig, tailwind
extensions/
  _template/        # Khung mẫu cho ext:new
  demo-weekend/     # Extension mẫu
docs/
```

## 5. Công nghệ

- **Next.js (App Router) + TypeScript** strict, **pnpm + Turborepo**
- **PostgreSQL** + **Prisma** (SQL thủ công cho RLS và exclusion constraint)
- **Tailwind CSS + shadcn/ui**, **Recharts**, **TanStack Table**
- **Auth.js** (email/mật khẩu băm argon2; tùy chọn đăng nhập Google; TOTP cho admin)
- **Zod** cho mọi input, **date-fns-tz**
- **pg-boss** cho hàng đợi và tác vụ định kỳ (job luôn mang `tenantId`)
- **bwip-js** (Code128, QR), **@zxing/browser** (quét bằng camera), hỗ trợ máy quét USB
- **@react-pdf/renderer** (PDF), **exceljs** (Excel)
- Lưu file: adapter cục bộ khi dev, S3-compatible khi production; đường dẫn file luôn có tiền tố `tenant_id`
- **pino**, **Sentry**, **OpenAPI** (zod-to-openapi)
- Test: **Vitest**, **Playwright**
- **Docker**: image dùng chung cho cả `shared` và `dedicated`, docker-compose cho dev và cho cài đặt riêng; GitHub Actions CI (typecheck, lint, test, build, kiểm tra tương thích extension)

## 6. Phân quyền

- **Cấp nền tảng** (cổng quản trị): `SUPER_ADMIN`, `SUPPORT`, `SALES` (mục 2.5).
- **Cấp cửa hàng** (mặc định, tenant chỉnh được ở gói cao):

| Vai trò | Quyền |
|---|---|
| Chủ cửa hàng (OWNER) | Toàn quyền, thanh toán thuê bao, xóa/xuất dữ liệu |
| Quản lý (MANAGER) | Toàn quyền nghiệp vụ, cài đặt, báo cáo, xem giấy tờ tùy thân |
| Nhân viên quầy (STAFF) | Khách hàng, đặt lịch, hợp đồng, giao/nhận, thu tiền |
| Kỹ thuật (TECHNICIAN) | Thiết bị, kiểm tra, bảo trì; không xem tiền và giấy tờ tùy thân |

- Quyền dạng chuỗi chi tiết (VD `booking.create`, `deposit.refund`, `customer.id_document.view`), vai trò là tập quyền. Kiểm tra ở server. Có thể giới hạn người dùng theo chi nhánh.

## 7. Chức năng nghiệp vụ

Mỗi mục ghi feature key chính trong ngoặc. Mọi chức năng đều chạy trong phạm vi tenant.

### 7.1. Danh mục & tồn kho (`inventory`)
- **Danh mục** dạng cây; **Mẫu thiết bị** (tên, hãng, thông số, ảnh, bảng giá, phụ kiện kèm theo, chu kỳ bảo trì); **Thiết bị cụ thể** (serial, mã vạch nội bộ duy nhất trong tenant, chi nhánh, ngày mua, giá nhập, giá trị bồi thường, tình trạng, lịch sử); **Hàng theo số lượng** (không quản lý từng chiếc).
- **Máy trạng thái** thiết bị, chỉ cho phép chuyển hợp lệ, ghi log ai/lúc nào/lý do:
  `AVAILABLE` (rảnh) → `RESERVED` → `RENTED` (đang thuê) → `INSPECTING` → `AVAILABLE` hoặc `MAINTENANCE` (bảo trì) → `AVAILABLE`; ngoài ra `RETIRED`, `LOST`.
- **Mã vạch** (`inventory.barcode`): tự sinh theo mẫu cấu hình (VD `CAM-000123`); in tem hàng loạt (khổ tem cấu hình được, Code128 + QR + tên); màn hình quét bằng máy quét USB hoặc camera → mở chi tiết hoặc thêm vào đơn đang giao/nhận.
- **Kiểm kê** (`inventory.stocktake`): quét thiết bị trong kho, báo thiếu/thừa/sai vị trí.
- **Nhập/xuất Excel** danh mục và thiết bị.
- Danh sách lọc theo danh mục, trạng thái, chi nhánh, tình trạng, trường tùy chỉnh; trang chi tiết gồm lịch thuê, lịch sử thuê, lịch sử bảo trì, doanh thu tích lũy.

### 7.2. Lịch cho thuê & giữ lịch (`booking`, `booking.timeline`)
Phải đúng tuyệt đối kể cả khi hai nhân viên đặt cùng lúc.
- Đơn đặt có thời gian bắt đầu/kết thúc và các dòng: một thiết bị cụ thể, hoặc một mẫu + số lượng (phân bổ chiếc cụ thể lúc giao).
- **Thời gian đệm** theo mẫu (VD 2 giờ vệ sinh sau khi trả) tính vào khoảng chiếm dụng. Lịch bảo trì cũng chiếm khoảng thời gian.
- **Ràng buộc ở DB**: bảng `unit_allocation` với cột `tstzrange` và exclusion constraint dùng `btree_gist`:
  `EXCLUDE USING gist (tenant_id WITH =, unit_id WITH =, period WITH &&) WHERE (status IN ('HOLD','CONFIRMED','ACTIVE','MAINTENANCE'))`.
  Bắt lỗi vi phạm → thông báo tiếng Việt dễ hiểu, gợi ý chiếc khác cùng mẫu còn rảnh hoặc khung giờ trống gần nhất.
- Hàng theo số lượng: kiểm tra tổng đã đặt trong khoảng giao nhau ≤ tồn kho, dùng transaction `SERIALIZABLE` hoặc khóa hàng.
- **Giữ chỗ tạm (HOLD)** có thời hạn (mặc định 24 giờ, cấu hình được); hết hạn chưa cọc → tác vụ nền tự hủy và giải phóng lịch.
- Trạng thái đơn: `QUOTE` → `HOLD` → `CONFIRMED` → `ACTIVE` → `RETURNED` → `CLOSED`; hoặc `CANCELLED`. Hỗ trợ **gia hạn** (kiểm tra trùng phần kéo dài) và **trả sớm**.
- Giao diện: **timeline/Gantt** (hàng = thiết bị, cột = thời gian, kéo thả tạo/dời đơn có kiểm tra trùng); tra cứu nhanh số chiếc còn rảnh theo mẫu + khoảng thời gian; bảng "Hôm nay" (cần giao, cần nhận, quá hạn).

### 7.3. Hợp đồng & đặt cọc (`contract`, `deposit`, `contract.e_signature`)
- **Khách hàng**: cá nhân hoặc doanh nghiệp (tên công ty, MST, người đại diện); họ tên, SĐT (duy nhất trong tenant, chuẩn hóa định dạng VN), email, địa chỉ, Zalo; mức tin cậy, danh sách đen kèm lý do; lịch sử thuê, công nợ.
- **Giấy tờ tùy thân**: loại (CCCD/hộ chiếu/GPLX), số, ngày cấp, nơi cấp, ảnh hai mặt. Ảnh lưu vùng riêng tư, chỉ truy cập qua URL ký có thời hạn; số giấy tờ mã hóa khi lưu; mỗi lần xem ghi nhật ký; có xác nhận đồng ý của khách; có chức năng xóa/ẩn danh khi khách yêu cầu.
- **Hợp đồng**: tạo từ đơn, số tự tăng theo mẫu (VD `HD-2026-00001`), mẫu hợp đồng là template có biến (gồm biến từ trường tùy chỉnh và extension), xuất PDF, ký trên màn hình của khách và nhân viên.
- **Biên bản giao nhận**: ảnh tình trạng, tick phụ kiện, ghi tình trạng từng thiết bị; so sánh giao ↔ nhận để phát hiện thiếu/hỏng.
- **Đặt cọc** nhiều hình thức trong một đơn: tiền mặt, chuyển khoản, **tài sản cọc** (giữ CCCD gốc, xe máy, laptop… kèm mô tả, giá trị ước tính, ảnh, vị trí cất giữ). Gợi ý mức cọc theo quy tắc cấu hình (và hook extension). **Quyết toán**: cọc − tiền thuê còn thiếu − phí trễ − phí hư hỏng/mất = số hoàn lại hoặc số khách còn phải trả; ghi nhận trả tài sản cọc kèm xác nhận. Sổ theo dõi tiền cọc và tài sản cọc đang giữ.

### 7.4. Tính phí tự động & nhắc nợ (`pricing`, `payments`, `notify.*`)
- **Bảng giá** theo mẫu: giờ, ngày, tuần, tháng; số giờ tối thiểu. Hỗ trợ nhiều bảng giá (VD giá khách lẻ, giá đối tác).
- **Động cơ tính giá** là hàm thuần trong `packages/core`:
  - Chọn **tổ hợp đơn vị rẻ nhất cho khách** (VD 9 ngày = 1 tuần + 2 ngày nếu rẻ hơn; giờ lẻ vượt giá 1 ngày thì tính 1 ngày).
  - Quy tắc ngày thuê cấu hình được (mốc 24 giờ hoặc ngày lịch).
  - **Ân hạn** trả trễ, sau đó **phí trễ hạn** (theo giờ hoặc % giá ngày).
  - Giảm giá theo đơn/nhóm khách, phí giao nhận, VAT bật/tắt.
  - Chạy hook `pricing.adjust` của extension (nếu có) ở bước cuối, ghi rõ dòng điều chỉnh.
  - Trả về bảng chi tiết từng dòng.
  - Unit test tối thiểu: 3 giờ, 1 ngày, 25 giờ, 9 ngày, 35 ngày, qua đêm, trễ trong ân hạn, trễ ngoài ân hạn, gia hạn, trả sớm, giảm giá + VAT, có extension điều chỉnh.
- **Thanh toán & công nợ**: nhiều lần thanh toán mỗi đơn; **QR VietQR** theo số tiền và nội dung là số hợp đồng (tài khoản ngân hàng của từng tenant); trạng thái chưa thanh toán / một phần / đủ / hoàn tiền.
- **Nhắc nhở tự động** (tác vụ nền): trước hạn trả X giờ; đến hạn chưa trả; quá hạn lặp theo chu kỳ và báo quản lý; còn công nợ sau khi đóng đơn; giữ chỗ sắp hết hạn.
  - Mẫu tin có biến (`{ten_khach}`, `{thiet_bi}`, `{han_tra}`, `{so_tien}`, `{link_thanh_toan}`), tenant tự sửa.
  - Gửi qua interface `NotificationProvider`: Zalo ZNS, SMS (eSMS/SpeedSMS), Email (SMTP), Console giả lập. **Mỗi tenant dùng tài khoản Zalo OA/SMS riêng** (khóa mã hóa), hoặc dùng tài khoản chung của nền tảng và bị tính vào hạn mức tin nhắn của gói.
  - Nhật ký gửi (kênh, nội dung, trạng thái, lỗi), gửi lại thủ công, chống gửi trùng (idempotency key), không gửi trong khung giờ nghỉ.

### 7.5. Bảo trì & sửa chữa (`maintenance`, `maintenance.usage_based`)
- **Kế hoạch bảo trì định kỳ** theo mẫu hoặc từng thiết bị, kích hoạt theo số ngày, **số giờ đã cho thuê** hoặc **số lượt thuê** — điều kiện nào đến trước.
- Tác vụ nền hằng ngày tạo phiếu khi đến hạn; phiếu **chiếm lịch** thiết bị và cảnh báo nếu trùng đơn đã đặt.
- **Phiếu sửa chữa** phát sinh từ biên bản nhận có hư hỏng hoặc tạo thủ công: loại, mô tả, kỹ thuật viên, đơn vị sửa ngoài, checklist, linh kiện, chi phí, ảnh trước/sau, thời gian, trạng thái (Chờ → Đang làm → Hoàn thành / Không sửa được → Thanh lý).
- Chi phí do khách gây ra chuyển thành khoản phí trên đơn thuê.
- Bảng việc cho kỹ thuật viên trên điện thoại, quét mã để mở phiếu.

### 7.6. Báo cáo (`reports.basic`, `reports.advanced`)
Bộ lọc thời gian, chi nhánh, danh mục; biểu đồ + bảng; **xuất Excel**; tính bằng truy vấn tổng hợp ở server. Extension đăng ký thêm báo cáo riêng được.
1. **Dashboard**: doanh thu hôm nay/tháng, đơn đang thuê, thiết bị theo trạng thái, đơn quá hạn, tiền cọc đang giữ, việc hôm nay. *(cơ bản)*
2. **Doanh thu** theo thời gian, danh mục, mẫu, nhân viên, chi nhánh; tách tiền thuê, phí trễ, phí hư hỏng, giảm giá; phân biệt ghi nhận và thực thu. *(cơ bản)*
3. **Quá hạn & công nợ**, tuổi nợ 0–7 / 8–30 / >30 ngày. *(cơ bản)*
4. **Tiền cọc & tài sản cọc** đang giữ. *(cơ bản)*
5. **Hiệu suất sử dụng thiết bị**: tỷ lệ thời gian được thuê; thiết bị ít thuê (gợi ý thanh lý), thường hết hàng (gợi ý mua thêm). *(nâng cao)*
6. **Hoàn vốn (ROI)** từng thiết bị: doanh thu − chi phí bảo trì so với giá nhập. *(nâng cao)*
7. **Bảo trì**: chi phí, số lần hỏng, thời gian chết, phiếu quá hạn. *(nâng cao)*
8. **Khách hàng**: thuê nhiều nhất, khách mới, hay trả trễ. *(nâng cao)*
9. **Tồn kho / kiểm kê**. *(cơ bản)*

## 8. Yêu cầu chung khác
- **Audit log** cho mọi thay đổi quan trọng (đơn, thanh toán, trạng thái thiết bị, xem giấy tờ, bảng giá, cài đặt, phiên hỗ trợ của admin) — tenant xem log của mình, admin xem toàn bộ.
- **Tìm kiếm toàn cục** (Ctrl+K): khách theo tên/SĐT, đơn theo số, thiết bị theo tên/serial/mã vạch.
- **Trung tâm thông báo** trong app (thông báo nghiệp vụ + thông báo hệ thống từ admin + nhắc gia hạn thuê bao).
- Xóa mềm dữ liệu nghiệp vụ; không xóa cứng đơn đã có thanh toán.
- Thời gian lưu UTC, hiển thị theo múi giờ tenant. Phân trang server, index có `tenant_id` đứng đầu.
- Xử lý lỗi thân thiện, trạng thái loading/rỗng, validate form bằng tiếng Việt.

## 9. Kiểm thử bắt buộc
- Unit test: pricing, máy trạng thái, quyết toán cọc, lịch bảo trì, kiểm tra giới hạn gói, phân giải feature flag, chạy hook extension (gồm trường hợp extension ném lỗi).
- Integration test: **cách ly tenant** cho mọi service và route; RLS chặn truy vấn thiếu ngữ cảnh tenant.
- Playwright E2E:
  1. Đăng ký → trình khởi tạo → nhập thiết bị từ Excel.
  2. Luồng thuê trọn vẹn: tra lịch → báo giá → giữ chỗ → cọc + giấy tờ → ký hợp đồng → quét mã giao → nhắc trả → trả trễ có hư hỏng → tính phí → quyết toán → đóng đơn → phiếu sửa chữa.
  3. Hai người đặt cùng thiết bị cùng lúc: chỉ một người thành công.
  4. Vượt giới hạn gói → thông báo nâng cấp; tính năng tắt theo gói không truy cập được kể cả gọi API trực tiếp.
  5. Admin: tạo tenant, đổi gói, bật extension, đăng nhập thay có băng rôn và audit log; tenant hết hạn chuyển chỉ đọc.

## 10. Dữ liệu mẫu và bàn giao

**Seed** (cố định, lặp lại được):
- 1 tài khoản `SUPER_ADMIN` cho cổng quản trị.
- 3 tenant: một gói Cơ bản đang dùng thử, một gói Chuyên nghiệp, một gói Doanh nghiệp có white-label và bật extension mẫu.
- Mỗi tenant: người dùng đủ vai trò (mật khẩu in trong README), chi nhánh, ~30 mẫu thiết bị phù hợp ngành [NGÀNH], ~120 thiết bị, ~50 khách tên Việt, ~200 đơn trải 6 tháng ở mọi trạng thái (gồm quá hạn, còn nợ), phiếu bảo trì, thanh toán, nhật ký tin nhắn.
- Lịch sử thuê bao để báo cáo MRR/churn trong cổng quản trị có số liệu.
- Bộ dữ liệu mẫu theo ngành dùng cho trình khởi tạo.

**Tài liệu và công cụ**:
- `README.md`: chạy dev, chạy docker-compose một lệnh, test, biến môi trường.
- `docs/ARCHITECTURE.md`: kiến trúc, ERD, đa tenant, RLS, chống trùng lịch, động cơ tính giá.
- `docs/CUSTOMIZATION.md`: **quy trình tùy biến cho khách hàng** — cây quyết định chọn tầng tùy biến (cấu hình → cờ → không-code → extension), cách dùng `pnpm ext:new`, danh sách hook có sẵn, quy tắc nâng cấp extension khi lõi đổi.
- `docs/ADMIN_GUIDE.md`: hướng dẫn dùng cổng quản trị (tạo khách, đổi gói, hỗ trợ, xuất dữ liệu, xử lý thanh toán).
- `docs/DEPLOY.md`: triển khai nền tảng chung; triển khai **cài đặt riêng** cho khách (một lệnh), cấu hình tên miền riêng, sao lưu/khôi phục, nâng cấp phiên bản.
- `docs/RELEASE.md`: quy trình phát hành, kênh beta/stable, migration an toàn.
- Script: `pnpm db:reset`, `pnpm tenant:create`, `pnpm tenant:export <slug>`, `pnpm ext:new <slug>`, `pnpm release`.
- Không còn lỗi `typecheck`, `lint`; toàn bộ test xanh; CI chạy được.

## 11. Thứ tự giai đoạn

1. **Nền móng**: monorepo, docker-compose, CI, Prisma schema đầy đủ, RLS, ngữ cảnh tenant, phân giải subdomain, auth + phân quyền hai cấp, feature flags + giới hạn gói, ESLint rule cấm hardcode tenant, test cách ly tenant, layout app + admin.
2. **Cổng quản trị tối thiểu**: tạo/sửa tenant, gói, cờ tính năng, đăng nhập thay có audit.
3. **Tồn kho**: danh mục, mẫu, thiết bị, máy trạng thái, mã vạch, in tem, quét, kiểm kê, nhập Excel.
4. **Khách hàng & giá**: khách hàng, giấy tờ tùy thân (bảo mật), bảng giá, pricing service + test.
5. **Đặt lịch**: giữ chỗ, chống trùng lịch, timeline, tra cứu còn trống.
6. **Hợp đồng & tiền**: hợp đồng, PDF, chữ ký, cọc, giao/nhận, quyết toán, thanh toán, VietQR.
7. **Tác vụ nền & thông báo**: hết hạn giữ chỗ, nhắc trả, quá hạn, công nợ; providers theo tenant; nhật ký.
8. **Bảo trì & sửa chữa**.
9. **Báo cáo** + dashboard + xuất Excel.
10. **Tùy biến**: trường tùy chỉnh, mẫu tài liệu, nhãn, vai trò tùy chỉnh, white-label, tên miền riêng.
11. **Extension SDK**: registry, các hook, `ext:new`, extension mẫu, kiểm tra tương thích khi build.
12. **Thương mại**: trang giới thiệu, đăng ký, trình khởi tạo, thuê bao, PayOS/VietQR, chỉ đọc khi hết hạn, báo cáo MRR/churn, xuất/xóa dữ liệu tenant, API công khai + webhook.
13. **Hoàn thiện**: audit log, tìm kiếm toàn cục, trung tâm thông báo, Sentry, sao lưu, E2E đầy đủ, seed đầy đủ, toàn bộ tài liệu.

Bắt đầu bằng bước lập kế hoạch (mục 3.1), sau đó thực hiện lần lượt các giai đoạn cho đến khi hoàn tất.
