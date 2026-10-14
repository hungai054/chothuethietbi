-- Giai đoạn 12: API công khai (khóa API theo cửa hàng) và webhook đi (hàng đợi giao có thử lại).

CREATE TABLE api_key (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX ON api_key (tenant_id, created_at);

ALTER TABLE api_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_key USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id());
-- Khóa không bị xóa mà bị thu hồi (giữ vết); không có quyền DELETE
GRANT SELECT, INSERT, UPDATE ON api_key TO rentpro_app;

-- Tra khóa theo băm TRƯỚC khi có ngữ cảnh tenant (giống resolve_tenant): chỉ lộ id/tenant/phạm vi của khóa còn hiệu lực
CREATE FUNCTION resolve_api_key(p_hash text)
RETURNS TABLE (id uuid, tenant_id uuid, scopes text[]) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$
  SELECT k.id, k.tenant_id, k.scopes FROM api_key k JOIN tenant t ON t.id = k.tenant_id
  WHERE k.key_hash = p_hash AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
    AND t.deleted_at IS NULL AND t.status IN ('TRIAL','ACTIVE','READ_ONLY')
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION resolve_api_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO rentpro_app;

CREATE TABLE webhook_endpoint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  url text NOT NULL CHECK (length(url) <= 500),
  description text,
  secret_enc text NOT NULL,
  events text[] NOT NULL CHECK (cardinality(events) > 0),
  active boolean NOT NULL DEFAULT true,
  consecutive_failures int NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  disabled_reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON webhook_endpoint (tenant_id, active);

CREATE TABLE webhook_delivery (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  endpoint_id uuid NOT NULL REFERENCES webhook_endpoint(id) ON DELETE CASCADE,
  event text NOT NULL,
  event_id uuid NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','SENT','FAILED')),
  attempts int NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status int,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  CHECK ((status = 'SENT') = (sent_at IS NOT NULL))
);
CREATE INDEX ON webhook_delivery (tenant_id, status, next_attempt_at);
CREATE INDEX ON webhook_delivery (tenant_id, endpoint_id, created_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['webhook_endpoint', 'webhook_delivery'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON webhook_endpoint TO rentpro_app;
-- Nhật ký giao: chỉ thêm/sửa trạng thái, không xóa tay (dọn theo lịch bằng role quản trị)
GRANT SELECT, INSERT, UPDATE ON webhook_delivery TO rentpro_app;

GRANT ALL ON ALL TABLES IN SCHEMA public TO rentpro_admin;
