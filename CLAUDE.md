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
