# RentPro

SaaS đa khách hàng quản lý cho thuê thiết bị (camera, âm thanh, ánh sáng, dụng cụ…) cho thị trường Việt Nam: tồn kho theo từng chiếc, đặt lịch chống trùng, hợp đồng và tiền cọc, thông báo, bảo trì, báo cáo, tùy biến không-code, extension, API/webhook và thuê bao.

> **Cảnh báo bảo mật khi tự triển khai.** Mật khẩu mẫu (`Demo@12345678`, role DB `rentpro_app` / `rentpro_admin`) là công khai vì nằm trong mã nguồn. Trước khi mở ra Internet, hãy đặt mật khẩu riêng cho role DB, bỏ dữ liệu mẫu và đặt các bí mật ngẫu nhiên: xem [SECURITY.md](SECURITY.md) và [docs/VAN_HANH.md](docs/VAN_HANH.md).

| Tài liệu | Dành cho |
|---|---|
| [docs/HUONG_DAN_SU_DUNG.md](docs/HUONG_DAN_SU_DUNG.md) | Chủ cửa hàng, quản lý, nhân viên: dùng từng chức năng |
| [docs/CHAY_THU.md](docs/CHAY_THU.md) | Chạy thử trên máy dev (tài khoản demo, các màn hình) |
| [docs/VAN_HANH.md](docs/VAN_HANH.md) | Triển khai, biến môi trường, sao lưu/khôi phục, giám sát lỗi |
| [docs/API.md](docs/API.md) | Tích hợp qua API công khai và webhook |
| [docs/CUSTOMIZATION.md](docs/CUSTOMIZATION.md) | Làm tùy biến cho một khách hàng (cấu hình → cờ → không-code → extension) |
| [docs/PLAN.md](docs/PLAN.md) | Kế hoạch, mô hình dữ liệu, trạng thái các giai đoạn |
| [CLAUDE.md](CLAUDE.md) | Quy ước kiến trúc và các quy tắc không được phá (đọc trước khi sửa mã) |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Muốn đóng góp: cách chạy kiểm tra, quy ước PR |
| [SECURITY.md](SECURITY.md) | Báo lỗ hổng bảo mật và danh sách bảo mật khi triển khai |

## Cấu trúc

```
apps/web        cửa hàng (Next.js, mỗi cửa hàng một tên miền con)     :3000
apps/admin      cổng quản trị của chủ sản phẩm                         :3001
apps/worker     tác vụ nền: nhắc lịch, gửi tin, thuê bao, webhook
packages/core   logic thuần TypeScript (giá, trạng thái, quyền, Excel…), không phụ thuộc Next/DB
packages/db     migration SQL + service nghiệp vụ + test tích hợp trên Postgres thật
packages/tenancy  cờ tính năng, giới hạn gói, mã hóa, ngữ cảnh tenant
extensions/     module riêng cho từng khách hàng (không sửa lõi theo khách)
e2e/            Playwright
```

Cách ly dữ liệu giữa các cửa hàng có hai lớp: mọi truy vấn chạy trong `withTenantId` và mọi bảng nghiệp vụ bật Row-Level Security.

## Bắt đầu nhanh

Cần Node 20+, pnpm, PostgreSQL 16+ (cần `btree_gist`).

```bash
pnpm install
export DATABASE_ADMIN_URL=postgresql://postgres:<mật khẩu>@localhost:5432/rentpro   # tạo DB `rentpro` trước
pnpm db:migrate                  # bảng + gói + dữ liệu mẫu (chạy lại thoải mái)
pnpm --filter @rentpro/web dev   # http://demo.localhost:3000   owner@demo.local / Demo@12345678
pnpm --filter @rentpro/admin dev # http://localhost:3001        admin@rentpro.local / Demo@12345678
```

## Kiểm tra chất lượng

```bash
pnpm typecheck && pnpm lint
TEST_PG_SERVER_URL=postgresql://postgres:<mk>@localhost:5432/postgres pnpm test   # mỗi lần chạy tạo database riêng
pnpm e2e                                                                          # build web+admin rồi chạy Playwright
```

CI (GitHub Actions) chạy typecheck, lint và test trên Postgres thật cho mọi push/PR.

## Giấy phép

[MIT](LICENSE) © 2026 hungai054
