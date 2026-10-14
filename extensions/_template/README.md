# __NAME__ (`__CODE__`)

Extension của RentPro cho khách hàng `__CODE__`. Sinh bằng `pnpm ext:new __CODE__`.

## Việc cần làm sau khi sinh
1. Sửa `src/index.ts` (manifest, cấu hình, móc cần dùng) và `test/index.test.ts`.
2. `pnpm ext:check` kiểm tra định nghĩa + tương thích SDK; `pnpm --filter @rentpro-ext/__CODE__ test` chạy test.
3. Build lại web/worker/admin để extension được nạp (`pnpm ext:sync` đã chạy sẵn khi sinh).
4. Trong cổng quản trị → khách hàng → Extension: bật `__CODE__` và nhập cấu hình (JSON).

## Quy tắc
- Chỉ import `@rentpro/extension-sdk` và thư viện của riêng extension. KHÔNG import `packages/*` khác.
- Không `if (tenant.slug === …)`: hành vi theo cửa hàng nằm trong cấu hình (`ctx.config`).
- Bảng riêng chỉ có tiền tố `ext_<mã>_` (xem `manifest.migrations`), có `tenant_id` và RLS; không sửa bảng lõi.
- Lỗi extension được cô lập và ghi nhật ký; chỉ móc khai báo `required` mới chặn được thao tác.
