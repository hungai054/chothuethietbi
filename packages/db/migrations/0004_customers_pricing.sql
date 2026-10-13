-- Giai đoạn 4: khách hàng, giấy tờ tùy thân (mã hóa), nhóm khách, bảng giá.

CREATE TABLE price_list (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  is_default boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Mỗi tenant tối đa một bảng giá mặc định (đang dùng)
CREATE UNIQUE INDEX price_list_one_default ON price_list (tenant_id) WHERE is_default AND deleted_at IS NULL;

CREATE TABLE price_rule (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  price_list_id uuid NOT NULL REFERENCES price_list(id) ON DELETE CASCADE,
  model_id uuid NOT NULL REFERENCES equipment_model(id),
  hour_price bigint CHECK (hour_price >= 0),
  day_price bigint CHECK (day_price >= 0),
  week_price bigint CHECK (week_price >= 0),
  month_price bigint CHECK (month_price >= 0),
  min_hours int NOT NULL DEFAULT 0 CHECK (min_hours >= 0 AND min_hours <= 720),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (price_list_id, model_id),
  CHECK (hour_price IS NOT NULL OR day_price IS NOT NULL OR week_price IS NOT NULL OR month_price IS NOT NULL)
);
CREATE INDEX ON price_rule (tenant_id, model_id);

CREATE TABLE customer_group (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  discount_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent <= 100),
  price_list_id uuid REFERENCES price_list(id),
  deleted_at timestamptz,
  UNIQUE (tenant_id, name)
);

ALTER TABLE customer
  ADD COLUMN type text NOT NULL DEFAULT 'PERSON' CHECK (type IN ('PERSON','COMPANY')),
  ADD COLUMN address text,
  ADD COLUMN zalo text,
  ADD COLUMN company_name text,
  ADD COLUMN tax_code text,
  ADD COLUMN representative text,
  ADD COLUMN trust_level text NOT NULL DEFAULT 'NEW' CHECK (trust_level IN ('NEW','TRUSTED','WATCH')),
  ADD COLUMN blacklist_reason text,
  ADD COLUMN group_id uuid REFERENCES customer_group(id),
  ADD COLUMN notes text,
  ADD COLUMN anonymized_at timestamptz,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT customer_blacklist_reason CHECK (NOT blacklisted OR length(btrim(coalesce(blacklist_reason, ''))) > 0);
CREATE INDEX ON customer (tenant_id, name);
CREATE INDEX ON customer (tenant_id, group_id);

-- Giấy tờ tùy thân: số được mã hóa AES-GCM; number_hash là chỉ mục mù để phát hiện trùng; ảnh nằm ở vùng lưu trữ riêng tư.
CREATE TABLE id_document (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  customer_id uuid NOT NULL REFERENCES customer(id),
  type text NOT NULL CHECK (type IN ('CCCD','PASSPORT','DRIVER_LICENSE')),
  number_enc text NOT NULL,
  number_last4 text NOT NULL CHECK (length(number_last4) = 4),
  number_hash text NOT NULL,
  issued_date date,
  issued_place text,
  front_path text,
  back_path text,
  consent_at timestamptz NOT NULL,
  consent_version text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ON id_document (tenant_id, customer_id);
CREATE INDEX ON id_document (tenant_id, number_hash);

-- Mỗi lần xem số giấy tờ hoặc ảnh đều được ghi lại; app role chỉ thêm, không sửa/xóa.
CREATE TABLE id_document_access_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  document_id uuid NOT NULL REFERENCES id_document(id),
  user_id uuid,
  action text NOT NULL CHECK (action IN ('VIEW_NUMBER','VIEW_FRONT','VIEW_BACK')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON id_document_access_log (tenant_id, document_id, created_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['price_list','price_rule','customer_group','id_document','id_document_access_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO rentpro_app', t);
  END LOOP;
END $$;
REVOKE UPDATE, DELETE ON id_document_access_log FROM rentpro_app;

-- Cửa hàng được sửa cấu hình của chính mình (chỉ hai cột này).
CREATE POLICY tenant_self_update ON tenant FOR UPDATE USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id());
GRANT UPDATE (settings, settings_version) ON tenant TO rentpro_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rentpro_app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO rentpro_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO rentpro_admin;
