-- Nền móng: bảng nền tảng + bảng nghiệp vụ lõi + RLS. Chạy bằng role quản trị (owner).
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rentpro_app') THEN
    -- Không phải owner, không BYPASSRLS: RLS luôn có hiệu lực.
    CREATE ROLE rentpro_app LOGIN PASSWORD 'rentpro_app' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

-- ===== Bảng nền tảng (không tenant_id, không RLS; app role không được đụng trực tiếp) =====
CREATE TABLE plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  price_month bigint NOT NULL DEFAULT 0,
  price_year bigint NOT NULL DEFAULT 0,
  features jsonb NOT NULL DEFAULT '{}',
  limits jsonb NOT NULL DEFAULT '{}',
  is_custom boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('SUPER_ADMIN','SUPPORT','SALES')),
  totp_secret text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE platform_audit (
  id bigserial PRIMARY KEY,
  actor_id uuid,
  tenant_id uuid,
  action text NOT NULL,
  reason text,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name text NOT NULL,
  plan_id uuid NOT NULL REFERENCES plan(id),
  status text NOT NULL DEFAULT 'TRIAL' CHECK (status IN ('TRIAL','ACTIVE','READ_ONLY','SUSPENDED','DELETED')),
  release_channel text NOT NULL DEFAULT 'stable' CHECK (release_channel IN ('stable','beta')),
  timezone text NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  currency text NOT NULL DEFAULT 'VND',
  locale text NOT NULL DEFAULT 'vi',
  settings jsonb NOT NULL DEFAULT '{}',
  settings_version int NOT NULL DEFAULT 1,
  feature_overrides jsonb NOT NULL DEFAULT '{}',
  limit_overrides jsonb NOT NULL DEFAULT '{}',
  trial_ends_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_domain (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  domain text NOT NULL UNIQUE,
  verified boolean NOT NULL DEFAULT false
);

CREATE TABLE tenant_extension (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  extension_code text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, extension_code)
);

-- ===== Bảng nghiệp vụ lõi (mọi bảng có tenant_id đứng đầu index) =====
CREATE TABLE branch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL,
  address text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  email text NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('OWNER','MANAGER','STAFF','TECHNICIAN')),
  branch_ids uuid[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE category (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  parent_id uuid REFERENCES category(id),
  name text NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE equipment_model (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  category_id uuid REFERENCES category(id),
  name text NOT NULL,
  brand text,
  buffer_minutes int NOT NULL DEFAULT 0 CHECK (buffer_minutes >= 0),
  tracked boolean NOT NULL DEFAULT true,   -- false = hàng theo số lượng
  stock_qty int NOT NULL DEFAULT 0,
  custom_fields jsonb NOT NULL DEFAULT '{}',
  deleted_at timestamptz
);

CREATE TABLE equipment_unit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  model_id uuid NOT NULL REFERENCES equipment_model(id),
  branch_id uuid REFERENCES branch(id),
  serial text,
  barcode text NOT NULL,
  status text NOT NULL DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE','RESERVED','RENTED','INSPECTING','MAINTENANCE','RETIRED','LOST')),
  purchase_price bigint,
  custom_fields jsonb NOT NULL DEFAULT '{}',
  deleted_at timestamptz,
  UNIQUE (tenant_id, barcode)
);

CREATE TABLE customer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL,
  phone text NOT NULL,
  email text,
  blacklisted boolean NOT NULL DEFAULT false,
  custom_fields jsonb NOT NULL DEFAULT '{}',
  deleted_at timestamptz,
  UNIQUE (tenant_id, phone)
);

CREATE TABLE booking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  code text NOT NULL,
  customer_id uuid NOT NULL REFERENCES customer(id),
  status text NOT NULL DEFAULT 'QUOTE'
    CHECK (status IN ('QUOTE','HOLD','CONFIRMED','ACTIVE','RETURNED','CLOSED','CANCELLED')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  hold_expires_at timestamptz,
  total bigint NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE (tenant_id, code)
);

-- Chống trùng lịch tuyệt đối ở tầng DB.
CREATE TABLE unit_allocation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  booking_id uuid REFERENCES booking(id),
  unit_id uuid NOT NULL REFERENCES equipment_unit(id),
  period tstzrange NOT NULL CHECK (NOT isempty(period)),
  status text NOT NULL CHECK (status IN ('HOLD','CONFIRMED','ACTIVE','MAINTENANCE','RELEASED')),
  CONSTRAINT unit_allocation_no_overlap EXCLUDE USING gist
    (tenant_id WITH =, unit_id WITH =, period WITH &&)
    WHERE (status IN ('HOLD','CONFIRMED','ACTIVE','MAINTENANCE'))
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  user_id uuid,
  action text NOT NULL,
  entity text,
  entity_id text,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index: tenant_id đứng đầu
CREATE INDEX ON branch (tenant_id);
CREATE INDEX ON category (tenant_id, parent_id);
CREATE INDEX ON equipment_model (tenant_id, category_id);
CREATE INDEX ON equipment_unit (tenant_id, model_id, status);
CREATE INDEX ON booking (tenant_id, status, starts_at);
CREATE INDEX ON audit_log (tenant_id, created_at);

-- ===== RLS =====
CREATE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['branch','app_user','category','equipment_model','equipment_unit',
                           'customer','booking','unit_allocation','audit_log','tenant_domain','tenant_extension']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO rentpro_app', t);
  END LOOP;
END $$;

-- tenant: app chỉ thấy tenant của mình, và chỉ đọc
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenant FOR SELECT USING (id = app_tenant_id());
GRANT SELECT ON tenant TO rentpro_app;
GRANT SELECT ON plan TO rentpro_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO rentpro_app;
GRANT EXECUTE ON FUNCTION app_tenant_id() TO rentpro_app;

-- Phân giải tenant theo subdomain hoặc tên miền riêng trước khi có ngữ cảnh.
-- SECURITY DEFINER: chỉ lộ id + trạng thái, không lộ dữ liệu khác.
CREATE FUNCTION resolve_tenant(p_slug text, p_domain text DEFAULT NULL)
RETURNS TABLE (id uuid, status text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$
  SELECT t.id, t.status FROM tenant t
  WHERE t.deleted_at IS NULL AND (
    t.slug = p_slug
    OR t.id = (SELECT d.tenant_id FROM tenant_domain d WHERE d.domain = p_domain AND d.verified)
  )
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION resolve_tenant(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_tenant(text, text) TO rentpro_app;
