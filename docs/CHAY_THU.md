# Hướng dẫn chạy thử RentPro trên máy dev

Yêu cầu: Node 20+, pnpm, PostgreSQL 16+ đang chạy (máy này: cổng 5433). Không cần Docker.

## 1. Chuẩn bị (làm một lần)

File `.env` ở gốc repo (không commit) cần có:

```
DATABASE_ADMIN_URL=postgresql://postgres:<mật khẩu>@localhost:5433/rentpro
TEST_PG_SERVER_URL=postgresql://postgres:<mật khẩu>@localhost:5433/postgres
```

```bash
pnpm install
pnpm db:migrate        # tạo bảng + nạp gói, tài khoản và dữ liệu mẫu (chạy lại bao nhiêu lần cũng được)
```

## 2. Chạy ứng dụng (mở 2 cửa sổ terminal)

```bash
pnpm dev:web      # cửa hàng   → http://demo.localhost:3000
pnpm dev:admin    # quản trị   → http://localhost:3001
```

Lần đầu mỗi trang biên dịch mất vài giây. Dùng Chrome hoặc Edge: tên miền `*.localhost` tự trỏ về máy bạn, không cần sửa file hosts.

## 3. Cửa hàng demo — `http://demo.localhost:3000`

Mật khẩu chung: `Demo@12345678`

| Vai trò | Email | Thử được gì |
|---|---|---|
| Chủ cửa hàng | `owner@demo.local` | Mọi thứ, kể cả xem số giấy tờ, ẩn danh khách |
| Quản lý | `manager@demo.local` | Như chủ, trừ thanh toán thuê bao / xóa dữ liệu |
| Nhân viên quầy | `staff@demo.local` | Khách, bảng giá (chỉ xem); không xem được số và ảnh giấy tờ |
| Kỹ thuật | `technician@demo.local` | Thiết bị, kiểm kê; không thấy Khách hàng / Bảng giá |

Dữ liệu mẫu: 5 mẫu thiết bị, 22 thiết bị (mã `CAM-000001`…), bảng giá, 5 khách (2 khách thuộc nhóm "Đối tác" giảm 10%).

### Gợi ý thử theo thứ tự
1. **Thiết bị** → xem danh sách, lọc theo trạng thái, bấm một mã để đổi sang *Bảo trì* (bắt buộc lý do), xem lịch sử.
2. **Thiết bị → tick vài dòng → In tem** → trang tem có mã vạch + QR (Ctrl+P để in).
3. **Quét mã** → gõ `cam-000001` rồi Enter (giả lập máy quét USB). Trên điện thoại có nút Camera (cần HTTPS hoặc localhost).
4. **Nhập Excel** → tải file mẫu, thêm vài dòng (cố tình để trống tên mẫu một dòng) → xem lỗi từng dòng → sửa → nhập.
5. **Kiểm kê** → tạo đợt, quét 2-3 mã, tải lại để thấy danh sách *Thiếu*.
6. **Khách hàng** → thêm khách (thử SĐT `+84 901 234 567` rồi thêm lại số đó để thấy lỗi trùng).
7. Vào một khách → **Thêm giấy tờ** (tick đồng ý, chọn ảnh JPG/PNG) → bấm *Xem số đầy đủ*. Đăng nhập thử bằng `staff@demo.local` để thấy bị che.
8. **Bảng giá → Báo giá thử** → chọn Sony A7 IV, thuê 25 giờ → `1 ngày + 1 giờ`; thuê 9 ngày → `1 tuần + 2 ngày`. Chọn khách nhóm Đối tác để thấy giảm 10%.
9. **Bảng giá → Quy tắc tính giá** (quản lý/chủ) → bật VAT, đổi sang "ngày lịch", rồi báo giá lại một lần thuê qua đêm.

## 4. Cổng quản trị — `http://localhost:3001`

Đăng nhập `admin@rentpro.local` / `Demo@12345678`. Lần đầu hệ thống **bắt buộc đăng ký xác thực 2 lớp**: thêm khóa hiện trên màn hình vào Google Authenticator / Authy rồi nhập mã 6 số.
Nếu mất ứng dụng xác thực hoặc muốn đăng ký lại: `pnpm admin:reset-totp`.

Thử: tạo khách hàng mới (mật khẩu tạm của chủ hiện một lần), đổi gói, bật/tắt tính năng (rồi vào cửa hàng đó xem mục menu biến mất), khóa/chuyển chỉ đọc, và **Đăng nhập thay** (nhập lý do → mở cửa hàng với băng rôn vàng; chủ cửa hàng không bị lộ giấy tờ).

Khách mới tạo ở admin vào được qua `http://<slug>.localhost:3000`.

## 5. Chạy kiểm thử

```bash
pnpm typecheck && pnpm lint
pnpm test          # cần TEST_PG_SERVER_URL trong .env, mỗi lần tạo database riêng rồi xóa
pnpm e2e           # build web + admin rồi chạy Playwright bằng Chrome có sẵn (đóng 2 server dev trước)
```

## 6. Xử lý sự cố

| Triệu chứng | Cách xử lý |
|---|---|
| "Không tìm thấy cửa hàng" | Đang vào `localhost:3000` thay vì `demo.localhost:3000` |
| Lỗi kết nối DB / `readyz` 503 | Kiểm tra PostgreSQL chạy ở cổng 5433, `.env` đúng mật khẩu |
| `Thiếu DATABASE_ADMIN_URL` | Tạo file `.env` ở gốc repo như mục 1 |
| `Thiếu MASTER_KEY` khi chạy bản build | Chỉ xảy ra ở chế độ production. Đặt `MASTER_KEY` (`openssl rand -base64 32`). Chế độ dev dùng khóa dev kèm cảnh báo |
| Cổng 3000/3001 bận | Tắt tiến trình cũ (`Get-NetTCPConnection -LocalPort 3000`) |
| Muốn làm lại dữ liệu từ đầu | `pnpm db:reset` (xóa sạch database `rentpro` rồi tạo lại) |
