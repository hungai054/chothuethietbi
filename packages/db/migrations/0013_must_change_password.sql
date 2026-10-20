-- Bắt buộc đổi mật khẩu sau khi mật khẩu bị đặt lại hộ (quản trị đặt cho chủ, chủ/quản lý đặt cho người khác).
-- Mặc định false nên mọi tài khoản hiện có không bị ảnh hưởng; cờ tự tắt khi người dùng tự đổi mật khẩu.
ALTER TABLE app_user ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;
