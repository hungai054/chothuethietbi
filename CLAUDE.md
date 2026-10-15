# RentPro – quy ước cho phiên làm việc

SaaS đa khách hàng quản lý cho thuê thiết bị (Việt Nam). Kế hoạch: `docs/PLAN.md`. Đặc tả gốc: `prompt-webapp-cho-thue-thiet-bi.md`.

## Lệnh

```bash
pnpm install
pnpm typecheck && pnpm lint
TEST_PG_SERVER_URL=postgresql://postgres:<mk>@localhost:5433/postgres pnpm test   # test DB tạo database riêng mỗi lần chạy
pnpm e2e                                                                          # build web+admin rồi chạy Playwright (Chrome có sẵn)
DATABASE_ADMIN_URL=<url quản trị> pnpm --filter @rentpro/db migrate               # áp migration + seed
pnpm --filter @rentpro/web dev      # http://<slug>.localhost:3000   (tenant demo: demo.localhost:3000)
pnpm --filter @rentpro/admin dev    # http://localhost:3001
```
Thông tin kết nối dev nằm trong `.env`, `apps/*/.env.local` (không commit). Tài khoản seed: `<role>@demo.local` / `Demo@12345678`; admin: `admin@rentpro.local`.

## Kiến trúc (không phá vỡ)

- `packages/core`: logic thuần TS (giá, trạng thái, quyền, Excel…), KHÔNG phụ thuộc Next hay DB. Có unit test.
- `packages/db`: migration SQL (`migrations/NNNN_*.sql`), service nghiệp vụ nhận `ServiceCtx`, test tích hợp trên Postgres thật.
- `packages/tenancy`: cờ tính năng, giới hạn gói, mã hóa, ngữ cảnh tenant.
- `apps/web` (cửa hàng), `apps/admin` (chủ sản phẩm). UI chỉ gọi service, không viết SQL trong trang.
- Cách ly tenant 2 lớp: mọi truy vấn nghiệp vụ chạy trong `withTenantId` (đặt `app.tenant_id`) + RLS trên mọi bảng có `tenant_id`.
- Cấm `if (tenant.slug === '…')` và cấm `packages/*` import `extensions/*` (ESLint rule, chạy trong `pnpm lint`).

## Thêm một tính năng mới (luôn đủ các bước)

1. Trả lời 3 câu: thuộc gói nào (feature key)? cần cấu hình không? cần điểm móc cho extension không?
2. Thêm key vào `packages/tenancy/src/features.ts`, đưa vào gói trong `packages/db/src/seed.ts`, chạy lại migrate để cập nhật gói.
3. Bảng mới: tạo migration mới (KHÔNG sửa migration đã áp dụng). Mọi bảng nghiệp vụ có `tenant_id`, bật `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy `tenant_isolation`, `GRANT` đúng quyền cho `rentpro_app` (chỉ thêm với bảng nhật ký) và `rentpro_admin`. Index bắt đầu bằng `tenant_id`. Thêm `CHECK` ở DB cho bất biến quan trọng.
4. Logic thuần → `packages/core` + test. Truy cập DB → service trong `packages/db`, gọi `guard(ctx, quyền, feature, { write: true })` ở đầu mỗi hàm (quyền, gói, chế độ chỉ đọc kiểm tra ở SERVER, không chỉ ở UI), ghi `audit(...)` khi thay đổi.
5. Test tích hợp bắt buộc: cô lập tenant, thiếu quyền, tính năng tắt theo gói, tenant chỉ đọc, đầu vào sai (thông báo tiếng Việt).
6. UI: trang trong `apps/web/src/app/(app)/…`; đặt `layout.tsx` gọi `requireAccess(feature, quyền)`; server action dùng `run(failTo, fn)` (lỗi nghiệp vụ → thông báo trên trang) và `withService`. Thêm mục vào menu ở `(app)/layout.tsx`.
7. E2E Playwright cho luồng chính; chạy `pnpm e2e`.

## Làm tùy biến cho một khách hàng (theo thứ tự, tầng trên làm được thì không xuống tầng dưới)

1. Cấu hình (`tenant.settings`, schema zod có phiên bản, ví dụ `settings/pricing-settings.ts`).
2. Cờ tính năng / ghi đè theo tenant trong cổng quản trị.
3. Không-code: trường tùy chỉnh, mẫu tài liệu, nhãn, vai trò, white-label (Giai đoạn 10).
4. Extension bằng code (Giai đoạn 11) trong `extensions/<ma-khach-hang>/`, không bao giờ sửa lõi theo khách.

## Bài học đã trả giá (đừng lặp lại)

- Auth.js và Next dựng URL chuyển hướng từ địa chỉ nội bộ → mất subdomain tenant. Đăng nhập/đăng xuất làm ở client với `redirect:false` rồi `location.assign('/')`; lấy host qua `hostOf()` (ưu tiên `x-forwarded-host`).
- React xóa ô `<input type=file>` sau mỗi lần gửi form → giữ `File` trong state nếu cần dùng lại.
- Postgres: `CREATE DATABASE` đồng thời bị chặn; test DB dùng `TEST_PG_SERVER_URL` và đã chịu được chạy song song. Turbo lọc biến môi trường → khai báo trong `turbo.json` (`globalPassThroughEnv`).
- `git add -A` đã từng kéo file bộ cài và file mật khẩu vào commit. Luôn `git add` theo đường dẫn cụ thể.
- Tiền là số nguyên VND. Thời gian lưu UTC, hiển thị và tính ngày lịch theo múi giờ của tenant (`zonedTimeToUtc`).
- Số giấy tờ tùy thân mã hóa AES-GCM (`MASTER_KEY`), tìm trùng bằng chỉ mục mù HMAC, ảnh ở kho riêng tư truy cập qua URL ký 120 giây và luôn ghi nhật ký. Production bắt buộc `MASTER_KEY`.

## Đặt lịch (Giai đoạn 5): quy tắc không được phá

- **Nguồn sự thật về lịch** là `unit_allocation` (từng chiếc, exclusion constraint) và `qty_allocation` (hàng theo số lượng). `equipment_unit.status` chỉ là tình trạng vật lý HIỆN TẠI, đổi lúc giao/nhận (Giai đoạn 6), KHÔNG đổi khi đặt lịch.
- **Mọi chỗ ghi lịch phải gọi `lockModels(ctx, modelIds)` trước** (khóa advisory theo mẫu, sắp xếp id). Nếu không, hai giao dịch cùng chèn lịch trùng vào exclusion constraint sẽ chờ nhau và Postgres hủy một bên bằng "deadlock detected" sau 1 giây. Bảo trì (Giai đoạn 8) cũng phải tuân thủ.
- Khóa dòng mẫu để kiểm tồn kho dùng `FOR NO KEY UPDATE`, KHÔNG dùng `FOR UPDATE` (xung đột với KEY SHARE của khóa ngoại → deadlock).
- Câu lệnh có thể vi phạm exclusion chạy qua `attempt()` (savepoint) để còn truy vấn gợi ý (chiếc rảnh, khung trống) trước khi báo lỗi.
- Giá đã chốt lưu trong đơn (`quote`, `pricing_input`); gia hạn/trả sớm/dời lịch tính lại từ đó, không đọc lại bảng giá hiện tại.
- Giữ chỗ hết hạn được hủy "lười" (`releaseExpiredHolds`) ở đầu mọi thao tác đặt lịch/tra cứu; tác vụ nền Giai đoạn 7 chỉ gọi lại hàm này.
- Số đơn cấp ở CUỐI giao dịch (bộ đếm `doc_counter`) để khóa bộ đếm giữ ngắn; đơn lỗi không tiêu số.

## Bài học thêm (giao diện)

- Server action KHÔNG được bắt hàm cục bộ trong closure (Next phải mã hóa biến closure). Hàm hỗ trợ như `okUrl()` đặt ở phạm vi module; chỉ bắt chuỗi/số.
- Playwright: `page.request` chạy bằng Node và phụ thuộc DNS của hệ điều hành, có máy không phân giải được `*.localhost`. Dùng `pageFetch()` (e2e/tests/helpers.ts) để gọi HTTP từ trong trình duyệt.
- Locator tiếng Việt dễ khớp nhầm chuỗi con ("Giữ chỗ" khớp cả "Lưu báo giá (chưa giữ chỗ)"): dùng `exact: true` hoặc `getByPlaceholder`.
- Sau thao tác kéo thả, toast hiện TRƯỚC khi lịch vẽ lại: test phải chờ trạng thái cuối (`expect.poll`), không dựa vào toast.
- Trang cần quyền thì dùng `requireAccess(feature, quyền)` để người dùng thấy lý do thay vì bị chuyển về trang chủ trống.

## Tiền, hợp đồng, giao/nhận (Giai đoạn 6): quy tắc không được phá

- Sổ `payment`/`booking_fee` chỉ thêm, không sửa/xóa; sai thì hủy kèm lý do (cột `voided_*`). Quyết toán luôn tính lại từ sổ (`computeSettlement`), không lưu số dư.
- Mọi khoản thu có khóa idempotency (form sinh `crypto.randomUUID()` khi render) để bấm đúp không thu trùng. Hoàn tiền chỉ khi đơn đã nhận về/hủy và không quá số phải hoàn.
- Nội dung hợp đồng là bản chụp lúc lập (`contract.content`); PDF/màn hình dựng từ bản chụp, không đọc lại dữ liệu sống. Trang in dùng "In / Lưu PDF" của trình duyệt (chưa có PDF sinh ở server).
- Đổi trạng thái thiết bị lúc giao/nhận qua `setUnitStatus` (hệ thống), lịch (`unit_allocation`) chuyển ACTIVE khi giao và RELEASED khi nhận.
- Ảnh riêng tư (tài sản thế chấp, biên bản, chữ ký) phục vụ qua `/media/<loại>/<id>/<n>`: cần đăng nhập, quyền kiểm trong service.
- Playwright: `getByRole('alert')` khớp cả bộ thông báo route của Next; dùng `locator('p[role=alert]')`. Mã đơn bị test cấu hình đổi mẫu, đừng khẳng định tiền tố `DT-`. Vẽ chữ ký cần `scrollIntoViewIfNeeded()` trước khi dùng chuột.

## Tác vụ nền và thông báo (Giai đoạn 7): quy tắc không được phá

- Tác vụ nền nằm ở `apps/worker` (vòng lặp mỏng); logic ở `packages/db/src/jobs.ts` + `notify.ts`. Không dùng pg-boss: hàng đợi là bảng `notification_log` (`FOR UPDATE SKIP LOCKED`, khóa idempotency `(tenant_id, idempotency_key)`), khóa advisory chống hai worker chạy trùng một bước.
- Worker dùng role quản trị CHỈ để liệt kê tenant; mọi việc nghiệp vụ chạy trong `withTenantId` bằng role ứng dụng (RLS). Mỗi bước (`holds.release`, `reminders.scan`, `notifications.dispatch`) có giao dịch riêng và ghi `job_run`; lỗi một bước/tenant không chặn bước/tenant khác.
- Nhắc nhở chỉ phát slot MỚI NHẤT (`dueReminders`), nên worker nghỉ lâu không dồn tin cũ. Đổi quy tắc nhắc thì sửa `packages/core/src/notify/schedule.ts` + test.
- Bí mật nhà cung cấp (SMTP/eSMS/Zalo) mã hóa bằng `MASTER_KEY`, không bao giờ trả lại giao diện (`getNotifySettings` chỉ báo "đã lưu"). Tin ở chế độ `shared` tính vào `messages_per_month`; `console`/`OWN` không tính.
- `releaseExpiredHolds` dùng đồng hồ DB (`now()`), còn quét/gửi nhận `now` từ ngoài (test chủ động đặt giờ). Trong test, tạo đơn mới sẽ tự hủy phiếu giữ chỗ hết hạn nên tạo đơn HOLD hết hạn SAU CÙNG.
- Trang `/pay/<token>` là trang công khai duy nhất: token ký (14 ngày) gắn một đơn của một tenant, chỉ có quyền `payment.view`, không lộ tên khách.
- Zalo ZNS/eSMS/SpeedSMS được viết theo tài liệu công khai nhưng CHƯA thử với tài khoản thật (chỉ test bằng fetch giả); thử thật bằng nút "Gửi thử" trước khi bật cho khách.

## Bảo trì và sửa chữa (Giai đoạn 8): quy tắc không được phá

- Khung giờ bảo trì chiếm lịch bằng `unit_allocation` (status `MAINTENANCE`, `booking_id` NULL, `work_order_id` bắt buộc — ràng buộc `unit_allocation_owner`). Mọi chỗ ghi khung bảo trì phải `lockModels` trước (đã làm trong `reserveWindow`); trùng đơn đã đặt thì exclusion constraint chặn, service báo mã đơn trùng. Quét tự động mà không xếp được lịch thì VẪN tạo phiếu (chưa có khung) và cảnh báo quản lý.
- Trạng thái vật lý của chiếc đổi qua `setUnitStatus`: bắt đầu phiếu → `MAINTENANCE`, hoàn thành → `AVAILABLE` (chỉ khi không còn phiếu khác đang làm), thanh lý → `RETIRED`. Chiếc `MAINTENANCE` bị loại khỏi MỌI khung thời gian tra cứu còn trống (không chỉ khung phiếu).
- Kế hoạch định kỳ: số giờ/lượt thuê tính từ `handover` loại RETURN sau lần phiếu `DONE` gần nhất của kế hoạch (chưa có thì từ `created_at` của chiếc); điều kiện đến trước thì kích hoạt. Chỉ mục duy nhất `work_order_one_open_per_plan` chống tạo trùng khi quét đồng thời.
- Cột `date` của Postgres phải đọc bằng `to_char(..., 'YYYY-MM-DD')`: driver `pg` đổi thành `Date` theo múi giờ máy chủ và làm lệch một ngày.
- Biên bản nhận có hư hỏng tự tạo phiếu `REPAIR` gắn đơn (`createDamageOrder`, bỏ qua nếu gói không có `maintenance`). Chuyển chi phí cho khách (`chargeCustomer`) cần `booking.handover` nên kỹ thuật viên không làm được.
- Không đặt tên export trùng giữa các file `packages/core` (`export *` làm nuốt âm thầm một bên): đã gặp với `findFreeWindow`, `Part`, `listPlans`.

## Báo cáo (Giai đoạn 9): quy tắc không được phá

- Mọi báo cáo trả cùng cấu trúc `ReportResult` (thẻ + các phần có cột/dòng/dòng tổng/biểu đồ). Giao diện (`components/report-view.tsx`) và Excel (`reportToXlsx`) dựng từ cấu trúc này; thêm báo cáo mới = viết hàm `run` và gọi `registerReport` (extension cũng đăng ký theo cách này). Quyền và gói kiểm trong `runReport`, không kiểm ở UI.
- "Doanh thu ghi nhận" = tiền thuê của đơn ĐÃ GIAO (ACTIVE/RETURNED/CLOSED) tính theo ngày giao + phí phát sinh còn hiệu lực theo ngày phát sinh. "Thực thu" là dòng tiền từ `payment` (RENT + FEE + DEPOSIT − REFUND; WRITE_OFF không tính). Hai số này KHÁC NHAU có chủ ý, đừng gộp.
- Khoảng ngày luôn tính theo múi giờ cửa hàng (`resolveRange`: [00:00 ngày đầu, 00:00 ngày sau ngày cuối)). Truy vấn có tham số đánh số: mọi `$n` phải được dùng trong câu lệnh (Postgres báo "could not determine data type of parameter"), nên truyền mảng tham số riêng cho từng truy vấn.
- Báo cáo có tiền cần `reports.finance`; nhân viên quầy chỉ có `reports.view` nên chỉ thấy tổng quan (không có thẻ tiền), hiệu suất, tồn kho. ROI cần gói `reports.roi`, hiệu suất/bảo trì/khách hàng cần `reports.advanced`.
- Xuất Excel: ô chữ bắt đầu bằng `= + - @` được thêm dấu nháy để không thành công thức (dữ liệu khách nhập vào có thể chứa công thức). Mỗi lần xuất ghi `audit_log` action `report.export`.
- Gợi ý "thanh lý/mua thêm" chỉ là quy tắc ngưỡng đơn giản (`utilizationHint`), ghi rõ trên báo cáo là tham khảo.

## Tùy biến không-code (Giai đoạn 10): quy tắc không được phá

- Cây quyết định chọn tầng tùy biến nằm ở `docs/CUSTOMIZATION.md`. Thêm một dạng tùy biến mới = chọn nơi lưu (settings có schema zod có phiên bản, hoặc bảng có RLS) + service có `guard` + trang trong `/settings` + hiển thị ở trung tâm `/settings`.
- Trường tùy chỉnh: giá trị luôn đi qua `validateCustomValues` (khóa lạ bị từ chối, trường tắt không nhận). Ghi giá trị trong CÙNG giao dịch với lệnh tạo bản ghi (`withService(async (c) => { const id = await createX(...); await setCustomValues(c, ..., true); })`) để trường bắt buộc không bị bỏ sót. Tệp đính kèm chỉ đổi qua `setCustomFile` (không cho ghi đường dẫn tùy ý qua `setCustomValues`).
- Tìm kiếm theo trường tùy chỉnh dùng `jsonb_each_text(custom_fields)` giới hạn theo các khóa đang bật "tìm kiếm được"; danh sách thêm cột qua `listColumnsData`.
- Quyền hiệu lực của người dùng đọc lại từ DB MỖI request (`loadUserAccess`): vai trò tùy chỉnh chỉ có hiệu lực khi gói còn `custom_roles`; tài khoản bị khóa mất quyền ngay. Không cache quyền trong JWT.
- Logo/favicon: chỉ nhận JPG/PNG/WebP (không SVG), lưu riêng tư, phục vụ công khai qua `/brand/logo|favicon` theo host và chỉ khi gói có `white_label`. Trình duyệt cache 5 phút nên thay logo có độ trễ.
- Nhãn chỉ đổi chữ hiển thị (menu, tiêu đề các trang chính); mã, quyền, URL không đổi. Thêm nhãn mới vào `LABEL_DEFAULTS` rồi dùng `tenant.labels` trong giao diện.
- Dùng Python/shell để sửa file có chuỗi chứa `\r`, `\n`, `\t` rất dễ ghi nhầm ký tự điều khiển thật vào mã: dùng công cụ Edit/Write cho các đoạn đó.
- Playwright: sau chuyển trang mềm của Next, ô nhập (checkbox, select) GIỮ trạng thái cũ; trước mỗi lần điền form lặp lại hãy `page.goto` trang mới hoặc `setChecked` tường minh. `fetch` trong trang bị cache theo `cache-control`: thêm tham số `?v=` khi cần kiểm tra thay đổi ngay.

## Extension SDK (Giai đoạn 11): quy tắc không được phá

- Extension nằm ở `extensions/<ma>/`, chỉ import `@rentpro/extension-sdk` (+ zod). Đăng ký là LÚC BUILD qua file sinh `apps/{web,admin,worker}/src/extensions.generated.ts` (do `pnpm ext:sync`, đừng sửa tay; chỉ file này được import `@rentpro-ext/*`, ESLint miễn trừ). Thêm/xóa extension xong phải `ext:sync` + `pnpm install` + build lại. Tiến trình test E2E tự đăng ký extension (xem `z-extension.spec.ts`).
- Bật/tắt theo cửa hàng CHỈ ở cổng quản trị (`setTenantExtension`; role ứng dụng bị thu quyền ghi `tenant_extension`). Cần tính năng `extensions`.
- Mọi lời gọi extension đi qua `ExtensionHost`: timeout 2 giây, try/catch, ghi `extension_error_log`; từ chối chủ ý dùng `ExtensionVeto`; móc `required` mới làm thao tác thất bại. Lỗi ghi log trong giao dịch bị hủy sẽ mất (trả lại qua `notes`).
- Móc đồng bộ (`pricing.adjust`, `deposit.adjust`) gộp vào `ctx.pricingHook/depositHook`; hook giá nhận thêm `info {start,end}`. Giá đã chốt trong đơn không đổi theo extension.
- Migration extension chỉ tạo bảng `ext_<ma-gạch-dưới>_*` có `tenant_id` + RLS + policy `tenant_isolation`; cần kết nối DDL (`DATABASE_ADMIN_URL`); runner ghi checksum, không sửa migration đã áp.
- `ctx.read.query` chỉ SELECT (kiểm tra, LIMIT 5000, timeout 3 giây). Báo cáo extension khóa `ext.<ma>.<khoa>`; trang extension là dữ liệu `ReportResult`, không phải React.
- Webhook/tích hợp ngoài để Giai đoạn 12. Test E2E không khẳng định số tiền cố định (cấu hình dùng chung của tenant bị z-customization đổi, ví dụ VAT): so sánh với mức nền đo trước.
- Sửa file qua script `node` heredoc dễ mất dấu `\`: dùng Edit/Write.

## API công khai và webhook (Giai đoạn 12): quy tắc không được phá

- Mô tả endpoint ở MỘT nơi: `API_ENDPOINTS` (`packages/core/src/api/openapi.ts`). Thêm endpoint = thêm mô tả + một handler cùng `id` trong `apps/web/src/lib/api-v1.ts` (route catch-all `/api/v1/[...path]`); OpenAPI tự sinh ở `/api/v1/openapi.json`.
- Khóa API chạy với quyền HẸP (`SCOPE_PERMISSIONS`), không bao giờ có quyền giấy tờ, tiền cọc, cài đặt. Thêm phạm vi hoặc dịch vụ mới dùng thêm quyền nội bộ thì phải cập nhật bảng này (ví dụ tạo đơn cần `pricing.view` vì tính báo giá). Quyền thiếu hiện ra là 403 "Bạn không có quyền" khi chạy E2E `z-api.spec.ts`.
- Giờ trong API luôn ISO 8601 KÈM múi giờ (từ chối chuỗi không có offset). Đơn QUOTE không giữ chỗ, nên chỉ HOLD/CONFIRMED mới bị chặn vì hết tồn kho.
- Khóa/bí mật webhook hiện MỘT lần qua server action trả về client (`useActionState`), không đưa lên URL. `WEBHOOK_ALLOW_PRIVATE=true` (chỉ dev) cho phép http/địa chỉ nội bộ, web và worker dùng chung biến này.
- Chạy E2E trong máy không có Chrome: dùng Node 20 (`/opt/node20/bin`; Playwright + Node 22 lỗi "module not been linked" khi nạp exceljs), cần `AUTH_SECRET`, và trỏ `executablePath` tới Chromium có sẵn bằng một config tạm (đừng commit).

## Tìm nhanh Ctrl+K (Giai đoạn 13): quy tắc không được phá

- `globalSearch` (`packages/db/src/search.ts`) chỉ GỌI LẠI các service danh sách (`listModels/listUnits/listCustomers/listBookings`), không viết SQL riêng; mỗi nhóm chỉ chạy khi có quyền xem và gói bật tính năng, nhóm không đủ điều kiện trả rỗng (không báo lỗi). Thêm loại kết quả mới = thêm nhóm ở đây + test quyền/tính năng/cô lập.
- Kết quả khách chỉ hiện 4 số cuối điện thoại. Từ khóa dưới 2 ký tự trả rỗng, trên 80 ký tự báo lỗi. Các service danh sách chưa thoát ký tự `%` `_` của LIKE (chỉ ảnh hưởng dữ liệu của chính cửa hàng).
- Danh sách "Đi tới" lấy từ chính menu đã lọc quyền/gói ở `(app)/layout.tsx`; thêm mục menu thì palette tự có. Giao diện ở `components/command-palette.tsx`, API ở `/api/search` (cần đăng nhập, `no-store`).

## Hoàn thiện (Giai đoạn 13): quy tắc không được phá

- **Nhật ký thao tác** (`packages/db/src/audit-view.ts`, `/settings/audit`): chỉ ĐỌC `audit_log` (bảng chỉ thêm). Cần `audit.view` + tính năng `audit.log`; xuất CSV cần thêm `data.export` và tự ghi `audit.export`. CSV qua `toCsv` (thêm nháy trước ô bắt đầu `= + - @`, có BOM). Lọc ngày theo múi giờ cửa hàng. Mọi thao tác ghi mới đều phải gọi `audit(...)` để hiện ở đây.
- **Thông báo trong app** (`listInbox`): `unread`/`total` đếm trên TOÀN BỘ thông báo nhìn thấy được, không bị cắt theo `limit`; trạng thái đọc theo từng người (`read_by`).
- **Sentry không SDK** (`packages/core/src/observability/sentry.ts`): bật bằng `SENTRY_DSN`. `instrumentation.ts` của web/admin chỉ nạp `instrumentation-node.ts` khi `NEXT_RUNTIME === 'nodejs'` và import qua `@rentpro/core/sentry` (không import `@rentpro/core` gốc: kéo `node:crypto` vào bản Edge làm hỏng build). Thêm khóa nhạy cảm mới vào regex `SENSITIVE_KEY` (scrub dữ liệu trước khi gửi).
- **Pool Postgres** (`createPool`) có handler `error`: kết nối rỗi bị đóng không được làm sập tiến trình. Đừng tạo `new pg.Pool` trực tiếp trong mã ứng dụng.
- **Sao lưu** (`packages/db/src/backup-cli.ts`): `pnpm db:backup` / `db:backup:verify`. Logic đặt tên/dọn ở `packages/core/src/ops/backup.ts` (không bao giờ xóa tệp lạ, luôn giữ ≥ 1 bản). Ảnh (`STORAGE_DIR`) và `MASTER_KEY` sao lưu riêng (xem `docs/VAN_HANH.md`).
- **Seed demo** gồm đơn mẫu (`seed-activity.ts`) tạo qua service nghiệp vụ, chỉ khi demo chưa có đơn nào. Không viết SQL thẳng vào bảng `booking`/`unit_allocation` trong seed.
- **E2E**: spec cần tenant gói cao hơn thì tạo tenant MỚI (như `z-api`, `z-audit`, `z-search`) hoặc bật ghi đè cờ (như `z-customization`, nay có cả `api`). Thêm mục mới vào trung tâm cài đặt có `locked` theo gói thì nhớ cập nhật `z-customization.spec.ts`. Worker E2E (`pnpm --filter @rentpro/worker once`) cần `.env` ở gốc và `apps/*/.env.local` (có thể rỗng); trang đăng ký cần `DATABASE_PLATFORM_URL`.
