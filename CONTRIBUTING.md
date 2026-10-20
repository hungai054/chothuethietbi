# Đóng góp cho RentPro

> **Dự án chỉ được công khai, không phát triển thêm.** Pull Request và issue có thể không được xem xét hoặc phản hồi. Bạn được khuyến khích **fork** và phát triển tiếp theo giấy phép MIT. Phần dưới mô tả cách làm việc với mã nguồn nếu bạn fork.

Cảm ơn bạn quan tâm! Trước khi sửa mã, hãy đọc [CLAUDE.md](CLAUDE.md): đó là tập quy ước kiến trúc và các quy tắc "không được phá" (cách ly tenant, đặt lịch, tiền, quyền…) mà mọi thay đổi phải tuân theo.

## Thiết lập

Xem [README.md](README.md) (bắt đầu nhanh) và [docs/CHAY_THU.md](docs/CHAY_THU.md). Cần Node 20+, pnpm, PostgreSQL 16+ (có `btree_gist`).

## Trước khi mở Pull Request

```bash
pnpm typecheck && pnpm lint
TEST_PG_SERVER_URL=postgresql://postgres:<mk>@localhost:5432/postgres pnpm test
pnpm e2e        # nếu thay đổi có giao diện hoặc luồng nghiệp vụ
```

- Test tích hợp chạy trên **PostgreSQL thật** (không giả lập), mỗi lần tạo database riêng.
- Tính năng mới phải đủ các bước ở mục "Thêm một tính năng mới" trong CLAUDE.md: cờ tính năng theo gói, `guard(...)` ở service, `audit(...)` khi thay đổi, test cô lập tenant / thiếu quyền / tính năng tắt / chỉ đọc / đầu vào sai.
- **Không sửa migration đã có**; tạo migration mới. Mọi bảng nghiệp vụ có `tenant_id` + RLS.
- Tiền là số nguyên VND; giờ lưu UTC.
- Thông báo cho người dùng viết bằng tiếng Việt.
- Dùng `git add <đường-dẫn-cụ-thể>`, không dùng `git add -A` (tránh kéo nhầm file cục bộ, mật khẩu, bộ cài).
- Mỗi PR nên nhỏ, có mô tả vì sao thay đổi và cách đã kiểm tra.

## Báo lỗi và đề xuất

Dùng tab *Issues* (có mẫu). Lỗ hổng bảo mật: xem [SECURITY.md](SECURITY.md), đừng mở issue công khai.

Bằng việc gửi đóng góp, bạn đồng ý đóng góp được cấp phép theo giấy phép MIT của dự án.
