# Chính sách bảo mật

## Báo lỗi bảo mật

**Đừng mở issue công khai** cho lỗ hổng bảo mật. Hãy dùng **"Report a vulnerability"** ở tab *Security* của kho GitHub này (báo cáo riêng tư). Hãy nêu: phiên bản/commit, các bước tái hiện, ảnh hưởng, và (nếu có) đề xuất sửa.

Chúng tôi cố gắng phản hồi trong vòng 7 ngày và sẽ ghi công người báo (nếu bạn đồng ý) khi đã có bản sửa.

## Phạm vi

Các lỗi đáng quan tâm nhất: rò rỉ dữ liệu giữa các cửa hàng (tenant), vượt quyền, lộ số giấy tờ/ảnh giấy tờ, lộ bí mật (khóa API, bí mật webhook, `MASTER_KEY`), chèn SQL/XSS/SSRF, bỏ qua giới hạn gói hoặc chế độ chỉ đọc.

## Lưu ý khi tự triển khai (quan trọng)

Mã nguồn công khai nên các giá trị mặc định dành cho máy phát triển **ai cũng biết**. Trước khi mở ra Internet, bắt buộc:

1. **Đặt mật khẩu riêng cho hai role database**: `APP_DB_PASSWORD` (role `rentpro_app`) và `PLATFORM_DB_PASSWORD` (role `rentpro_admin`), ít nhất 16 ký tự, rồi chạy `pnpm db:migrate`; cập nhật `DATABASE_URL` và `DATABASE_PLATFORM_URL` cho khớp. Mật khẩu mặc định `rentpro_app` / `rentpro_admin` nằm trong migration.
2. **Không nạp dữ liệu mẫu**: đặt `NODE_ENV=production` (hoặc `SEED_DEMO=false`) cùng `PLATFORM_ADMIN_EMAIL` và `PLATFORM_ADMIN_PASSWORD` khi chạy `pnpm db:migrate`. Nếu không, hệ thống tạo tài khoản `admin@rentpro.local` và `*@demo.local` với mật khẩu công khai `Demo@12345678`.
3. **Đặt các bí mật ngẫu nhiên riêng**: `MASTER_KEY`, `AUTH_SECRET`, `ADMIN_SECRET`, `FILE_URL_SECRET`, `SUPPORT_SECRET`. Các khóa trong CI và E2E chỉ dành cho kiểm thử.
4. **HTTPS** toàn bộ và giới hạn truy cập cổng quản trị theo IP/VPN.
5. Không đặt `WEBHOOK_ALLOW_PRIVATE=true` ở production.

Danh sách đầy đủ: [docs/VAN_HANH.md](docs/VAN_HANH.md), mục 7.
