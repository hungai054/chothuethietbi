-- Giai đoạn 11: extension (module mở rộng bằng code). Extension được đăng ký lúc build; bảng này chỉ ghi
-- extension nào được BẬT cho cửa hàng nào (do cổng quản trị quyết định), cấu hình riêng, dữ liệu và nhật ký lỗi.

-- Cửa hàng chỉ ĐỌC danh sách extension được bật; chỉ cổng quản trị (rentpro_admin) bật/tắt/đổi cấu hình.
REVOKE INSERT, UPDATE, DELETE ON tenant_extension FROM rentpro_app;
ALTER TABLE tenant_extension ADD COLUMN version text, ADD COLUMN enabled_at timestamptz, ADD COLUMN enabled_by text;

-- Kho khóa–giá trị riêng của extension cho từng cửa hàng (extension không tự viết SQL vào bảng lõi).
CREATE TABLE extension_data (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  extension_code text NOT NULL,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, extension_code, key),
  CONSTRAINT extension_data_size CHECK (pg_column_size(value) <= 100000)
);

-- Lỗi của extension (bị cô lập, không làm hỏng luồng lõi) để quản trị xem và sửa.
CREATE TABLE extension_error_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  extension_code text NOT NULL,
  hook text NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON extension_error_log (tenant_id, created_at DESC);
CREATE INDEX ON extension_error_log (tenant_id, extension_code, created_at DESC);

-- Migration riêng của extension (toàn hệ thống, không thuộc tenant nào): chỉ rentpro_admin ghi.
CREATE TABLE ext_migration (
  extension_code text NOT NULL,
  migration_id text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (extension_code, migration_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['extension_data','extension_error_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON extension_data TO rentpro_app;
GRANT SELECT, INSERT ON extension_error_log TO rentpro_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rentpro_app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO rentpro_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO rentpro_admin;
