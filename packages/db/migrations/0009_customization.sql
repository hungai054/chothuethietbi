-- Giai đoạn 10: tùy biến không cần code — trường tùy chỉnh, vai trò tùy chỉnh, tên miền riêng.
-- Nhãn, mẫu tài liệu và thương hiệu nằm trong tenant.settings (đã có), logo/favicon nằm trong kho riêng tư.

CREATE TABLE custom_field_def (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  entity text NOT NULL CHECK (entity IN ('UNIT','CUSTOMER','BOOKING','CONTRACT')),
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  label text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 60),
  kind text NOT NULL CHECK (kind IN ('TEXT','NUMBER','DATE','SELECT','BOOLEAN','FILE')),
  required boolean NOT NULL DEFAULT false,
  options jsonb NOT NULL DEFAULT '[]',
  show_in_list boolean NOT NULL DEFAULT false,
  searchable boolean NOT NULL DEFAULT false,
  in_contract boolean NOT NULL DEFAULT false,
  sort int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity, key),
  -- Kiểu và cờ luôn khớp nhau ở tầng DB (tệp đính kèm không tìm kiếm/hiện danh sách/chèn hợp đồng được)
  CONSTRAINT custom_field_file_flags CHECK (kind <> 'FILE' OR (NOT searchable AND NOT show_in_list AND NOT in_contract)),
  CONSTRAINT custom_field_select_options CHECK ((kind = 'SELECT') = (jsonb_array_length(options) >= 2))
);
CREATE INDEX ON custom_field_def (tenant_id, entity, active, sort);

ALTER TABLE booking ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}';
ALTER TABLE contract ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}';

CREATE TABLE custom_role (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 40),
  permissions text[] NOT NULL CHECK (cardinality(permissions) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX custom_role_name_uq ON custom_role (tenant_id, lower(name));

-- Người dùng có thể gắn vai trò tùy chỉnh; cột role vẫn là vai trò nền (dùng khi vai trò tùy chỉnh bị gỡ hoặc gói hạ cấp)
ALTER TABLE app_user ADD COLUMN custom_role_id uuid REFERENCES custom_role(id);
CREATE INDEX ON app_user (tenant_id, custom_role_id) WHERE custom_role_id IS NOT NULL;

ALTER TABLE tenant_domain ADD COLUMN verify_token text, ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN verified_at timestamptz;
ALTER TABLE tenant_domain ADD CONSTRAINT tenant_domain_lower CHECK (domain = lower(domain));
ALTER TABLE tenant_domain ADD CONSTRAINT tenant_domain_verified_time CHECK (NOT verified OR verified_at IS NOT NULL);
-- Một tên miền chỉ thuộc về MỘT cửa hàng sau khi xác minh; chưa xác minh thì nhiều bên cùng đăng ký được (không ai chiếm chỗ bằng cách khai báo trước)
ALTER TABLE tenant_domain DROP CONSTRAINT tenant_domain_domain_key;
CREATE UNIQUE INDEX tenant_domain_verified_uq ON tenant_domain (domain) WHERE verified;
CREATE UNIQUE INDEX tenant_domain_tenant_uq ON tenant_domain (tenant_id, domain);

-- Máy chủ chặn trước TLS (Caddy on-demand) hỏi tên miền nào được cấp chứng chỉ: chỉ trả đúng/sai, không lộ dữ liệu khác.
CREATE FUNCTION domain_is_verified(p_domain text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT EXISTS (SELECT 1 FROM tenant_domain d JOIN tenant t ON t.id = d.tenant_id WHERE d.domain = lower(p_domain) AND d.verified AND t.deleted_at IS NULL AND t.status <> 'SUSPENDED') $$;
REVOKE ALL ON FUNCTION domain_is_verified(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION domain_is_verified(text) TO rentpro_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['custom_field_def','custom_role'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;

-- Định nghĩa trường: không xóa cứng (còn giá trị trong bản ghi), chỉ tắt. Vai trò xóa được khi không còn người dùng.
GRANT SELECT, INSERT, UPDATE ON custom_field_def TO rentpro_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON custom_role TO rentpro_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rentpro_app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO rentpro_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO rentpro_admin;
