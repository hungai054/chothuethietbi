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
