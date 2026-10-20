# Vận hành RentPro

## 1. Thành phần cần chạy

| Tiến trình | Lệnh | Ghi chú |
|---|---|---|
| Web (cửa hàng) | `pnpm --filter @rentpro/web build && pnpm --filter @rentpro/web start` (cổng 3000) | `/api/healthz` (sống), `/api/readyz` (kết nối DB được) |
| Admin | `pnpm --filter @rentpro/admin build && pnpm --filter @rentpro/admin start` (cổng 3001) | Nên đặt sau VPN/IP allowlist |
| Worker | `pnpm --filter @rentpro/worker start` | CHỈ chạy một bản (có khóa advisory chống chạy trùng nhưng không cần nhiều bản). `--once` để chạy một vòng |
| PostgreSQL ≥ 16 | | Cần extension `btree_gist` |

Reverse proxy phải chuyển đúng `Host` / `X-Forwarded-Host` (mỗi cửa hàng là một tên miền con `<slug>.<BASE_DOMAIN>`) và `X-Forwarded-Proto`.

## 2. Triển khai và nâng cấp

1. Sao lưu DB (mục 4).
2. Lấy mã mới, `pnpm install --frozen-lockfile`.
3. `NODE_ENV=production DATABASE_ADMIN_URL=… pnpm db:migrate` (lần đầu cần thêm `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD`, `APP_DB_PASSWORD`, `PLATFORM_DB_PASSWORD`; áp migration mới theo thứ tự, ghi checksum; **không bao giờ sửa migration đã áp**; cập nhật cả gói/cờ tính năng).
4. Nếu dùng extension: `pnpm ext:sync` rồi `pnpm ext:check` và `pnpm ext:migrate`.
5. Build và khởi động lại web, admin, worker.

Hai role DB: `rentpro_app` (ứng dụng, bị RLS ràng buộc) và `rentpro_admin` (quản trị nền tảng, DDL). Đổi mật khẩu mặc định ngay khi triển khai thật.

## 3. Biến môi trường

Bắt buộc ở production:

| Biến | Dùng cho |
|---|---|
| `DATABASE_URL` | Kết nối của role `rentpro_app` (web, worker) |
| `DATABASE_ADMIN_URL` | Migration, seed, sao lưu, worker liệt kê tenant |
| `DATABASE_PLATFORM_URL` | Kết nối role `rentpro_admin` cho web/admin (đăng ký, thuê bao, cổng quản trị) |
| `APP_DB_PASSWORD`, `PLATFORM_DB_PASSWORD` | Mật khẩu RIÊNG (≥ 16 ký tự) cho role `rentpro_app` và `rentpro_admin`; `pnpm db:migrate` đặt vào database. Bỏ trống thì role giữ mật khẩu MẶC ĐỊNH công khai (migrate cảnh báo khi `NODE_ENV=production`). Nhớ cập nhật `DATABASE_URL`/`DATABASE_PLATFORM_URL` cho khớp |
| `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_PASSWORD` | Tài khoản quản trị nền tảng đầu tiên (mật khẩu ≥ 12 ký tự, chữ và số). BẮT BUỘC khi `NODE_ENV=production` hoặc `SEED_DEMO=false`: seed khi đó chỉ tạo gói + tài khoản này, KHÔNG tạo cửa hàng demo, `*@demo.local` hay `admin@rentpro.local` |
| `AUTH_SECRET` | Ký phiên đăng nhập (cửa hàng) |
| `ADMIN_SECRET` | Ký phiên cổng quản trị |
| `MASTER_KEY` | 32 byte base64; mã hóa số giấy tờ, bí mật nhà cung cấp, bí mật webhook. **Mất khóa = mất dữ liệu mã hóa**, giữ bản sao ngoài DB |
| `BASE_DOMAIN` | Tên miền gốc (`cuahang.vn`), cửa hàng ở `<slug>.cuahang.vn` |
| `FILE_URL_SECRET` | Ký URL ảnh giấy tờ (hiệu lực 120 giây) |
| `SUPPORT_SECRET` | Ký phiên hỗ trợ (impersonate) |
| `STORAGE_DIR` | Thư mục ảnh/giấy tờ (nằm NGOÀI thư mục public; cần sao lưu riêng) |

Tùy chọn: `MASTER_KEY_PREVIOUS` (+ `MASTER_KEY_ID`, `MASTER_KEY_PREVIOUS_ID`) khi xoay khóa; `TENANT_URL_TEMPLATE`, `PUBLIC_URL_TEMPLATE`, `CUSTOM_DOMAIN_TARGET`, `DOMAIN_CHECK_KEY` (tên miền riêng); `DEPLOY_MODE=dedicated` + `DEDICATED_TENANT_SLUG` (triển khai riêng một khách); `WORKER_INTERVAL_SECONDS` (mặc định 60); `PAYOS_CLIENT_ID/API_KEY/CHECKSUM_KEY`, `BILLING_BANK_BIN/ACCOUNT/NAME` (thu tiền thuê bao); `SHARED_SMTP_*`, `SHARED_SMS_*`, `SHARED_ZALO_*` (kênh gửi dùng chung, tính vào hạn mức tin); `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`; `BACKUP_DIR`, `BACKUP_KEEP`.

`WEBHOOK_ALLOW_PRIVATE=true` chỉ để dev/test (cho webhook http và địa chỉ nội bộ). **Không đặt ở production.**

## 4. Sao lưu và khôi phục

Có hai phần dữ liệu, phải sao lưu CẢ HAI cùng thời điểm:

1. **PostgreSQL**: `pnpm db:backup` (cần `pg_dump` trên máy). Tạo `rentpro-<UTC>.dump` (định dạng custom, nén) + tệp `.sha256` trong `BACKUP_DIR` (mặc định `.data/backups`), giữ `BACKUP_KEEP` bản mới nhất (mặc định 14), không bao giờ xóa tệp lạ.
2. **Ảnh và giấy tờ**: thư mục `STORAGE_DIR` (rsync/snapshot ổ đĩa/đồng bộ lên kho đối tượng).
3. **`MASTER_KEY`** (và khóa cũ nếu đang xoay): lưu ở nơi an toàn, KHÔNG để chung với bản sao lưu DB.

Lịch gợi ý (cron của máy chủ): mỗi đêm `pnpm db:backup`, mỗi tuần `pnpm db:backup:verify`, rồi đẩy `BACKUP_DIR` lên kho lưu trữ ngoài máy.

**Kiểm tra khôi phục** (`pnpm db:backup:verify [tệp]`): kiểm tra SHA-256, khôi phục vào database tạm, so số dòng các bảng chính (tenant, app_user, customer, equipment_unit, booking, payment, audit_log) với DB đang chạy, rồi xóa DB tạm. Một bản sao lưu chưa từng được khôi phục thử thì chưa phải là bản sao lưu.

**Khôi phục thật**: dừng web/admin/worker → tạo DB trống → `pg_restore --no-owner --dbname <url> <tệp>` → chạy `pnpm db:migrate` (nếu bản mã mới hơn bản sao lưu) → chép lại `STORAGE_DIR` → đặt đúng `MASTER_KEY` → khởi động lại → mở `/api/readyz` và đăng nhập thử.

Từng cửa hàng có thể tự tải toàn bộ dữ liệu (ZIP gồm JSON + Excel + tệp) ở Cài đặt → Gói dịch vụ; xóa cửa hàng là xóa mềm 30 ngày rồi mới xóa hẳn.

## 5. Giám sát lỗi (Sentry hoặc GlitchTip)

Đặt `SENTRY_DSN` cho web, admin và worker để bật; bỏ trống là tắt (không gửi gì). Không cần SDK: lỗi chưa xử lý ở render/route/server action và lỗi vòng lặp worker được gửi qua giao thức envelope.

- Không báo lỗi nghiệp vụ đã có thông báo tiếng Việt (thiếu quyền, đầu vào sai…) và chuyển hướng.
- Giá trị của khóa nhạy cảm (mật khẩu, token, cookie, email, số điện thoại, số giấy tờ…) bị thay bằng `[đã ẩn]`; URL chỉ giữ đường dẫn, bỏ chuỗi truy vấn.
- Tối đa 20 sự kiện mỗi phút mỗi tiến trình; cùng một lỗi chỉ gửi một lần mỗi 60 giây.
- Việc gửi không bao giờ làm hỏng yêu cầu của người dùng.

Kết nối DB rỗi bị máy chủ đóng (khởi động lại DB, failover) được ghi cảnh báo `[db] kết nối rỗi bị đóng` và pool tự mở kết nối mới, không làm sập tiến trình.

## 6. Nhật ký và theo dõi

- **Nhật ký thao tác** của từng cửa hàng: Cài đặt → Nhật ký thao tác (quyền `audit.view`; xuất CSV cần `data.export`, mỗi lần xuất đều được ghi lại).
- **Tác vụ nền**: bảng `job_run` ghi mỗi bước (`holds.release`, `reminders.scan`, `notifications.dispatch`, `webhooks.dispatch`…), dọn tự động hằng ngày.
- **Cổng quản trị**: `platform_audit` ghi mọi thao tác của chủ sản phẩm, kể cả phiên hỗ trợ.

## 6b. Khách quên mật khẩu

- **Nhân viên/quản lý**: chủ cửa hàng đặt lại ở Cài đặt → Người dùng.
- **Chủ cửa hàng**: ở **cổng quản trị → trang khách hàng → "Chủ cửa hàng quên mật khẩu"** (vai trò SUPER_ADMIN hoặc SUPPORT, quyền `tenant.reset_password`). Nhập lý do (bắt buộc; hãy xác minh danh tính chủ trước, ví dụ gọi lại số đã đăng ký), bấm "Đặt lại mật khẩu chủ". Hệ thống tạo mật khẩu tạm ngẫu nhiên (hiện MỘT lần, không nằm trong URL), mở lại tài khoản nếu đang bị khóa, ghi nhật ký quản trị và cả nhật ký của cửa hàng (chủ thấy ai đã đặt lại, vì sao). Cửa hàng có nhiều tài khoản chủ thì chọn email cần đặt lại.
- Gửi mật khẩu tạm cho khách qua kênh an toàn. Khi đăng nhập bằng mật khẩu tạm, hệ thống **bắt buộc đổi mật khẩu**: mọi trang khác đều chuyển về `/account/password` cho đến khi người dùng đặt mật khẩu riêng (ít nhất 10 ký tự, có chữ và số, khác mật khẩu tạm). Việc này áp dụng cả khi chủ/quản lý đặt hộ mật khẩu cho nhân viên ở Cài đặt → Người dùng (tự đặt cho chính mình thì không bị buộc). Ai cũng tự đổi được mật khẩu bất cứ lúc nào bằng liên kết "Đổi mật khẩu" trên thanh đầu trang.
- **Khi không vào được cổng quản trị** (hỗ trợ khẩn, chạy trên máy có `DATABASE_ADMIN_URL`): `pnpm db:reset-password <slug> [email]`, dùng cùng logic với nút trên.
- Cả hai cách KHÔNG đổi trạng thái cửa hàng: nếu cửa hàng đang chỉ đọc/khóa/xóa mềm thì xử lý ở cổng quản trị.

## 7. Danh sách kiểm tra trước khi mở cho khách thật

- [ ] Đã đặt `APP_DB_PASSWORD` / `PLATFORM_DB_PASSWORD` và seed ở chế độ production (`NODE_ENV=production` hoặc `SEED_DEMO=false` + `PLATFORM_ADMIN_*`); không còn tài khoản `admin@rentpro.local`, `*@demo.local`. Nếu đã nạp dữ liệu mẫu nhầm vào máy chủ thật: xóa cửa hàng demo và tài khoản mẫu, đổi mật khẩu role DB.
- [ ] `MASTER_KEY`, `AUTH_SECRET`, `ADMIN_SECRET`, `FILE_URL_SECRET`, `SUPPORT_SECRET` đều là giá trị ngẫu nhiên riêng, đã sao lưu an toàn.
- [ ] HTTPS toàn bộ; cổng quản trị giới hạn IP.
- [ ] Lịch `db:backup` + `db:backup:verify` chạy và bản sao lưu được đẩy ra ngoài máy.
- [ ] `SENTRY_DSN` đã đặt; thử gây một lỗi và thấy nó trên Sentry.
- [ ] Worker đang chạy (xem `job_run` có bản ghi mới mỗi phút).
- [ ] Email (SMTP) đã bấm "Gửi thử" bằng tài khoản thật. SMS/Zalo đang tắt ở mọi gói; nếu bật lại (xem `DISABLED_FEATURES` trong `packages/db/src/seed.ts`) thì phải thử thật với nhà cung cấp (hiện mới được kiểm bằng fetch giả).
- [ ] `WEBHOOK_ALLOW_PRIVATE` KHÔNG được đặt.
