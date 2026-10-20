## Thay đổi gì và vì sao

## Cách đã kiểm tra
- [ ] `pnpm typecheck && pnpm lint`
- [ ] `pnpm test` (Postgres thật)
- [ ] `pnpm e2e` (nếu có thay đổi giao diện/luồng nghiệp vụ)

## Danh sách kiểm tra
- [ ] Tuân thủ quy ước trong CLAUDE.md (cách ly tenant, `guard`, `audit`, cờ tính năng)
- [ ] Migration mới thay vì sửa migration cũ (nếu đổi DB)
- [ ] Không commit bí mật, `.env`, dữ liệu khách hàng
- [ ] Đã cập nhật tài liệu liên quan
