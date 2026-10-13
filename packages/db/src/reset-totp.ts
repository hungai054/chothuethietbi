import pg from 'pg';
import { loadRootEnv } from './env';

loadRootEnv();
const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error('Thiếu DATABASE_ADMIN_URL (đặt trong .env ở gốc repo).');
const email = (process.argv[2] ?? 'admin@rentpro.local').toLowerCase();
const c = new pg.Client({ connectionString: url });
await c.connect();
const r = await c.query('UPDATE platform_user SET totp_enabled=false, totp_secret=NULL, totp_last_step=NULL WHERE email=$1', [email]);
console.log(r.rowCount ? `Đã đặt lại xác thực 2 lớp cho ${email}. Lần đăng nhập tới sẽ yêu cầu đăng ký lại.` : `Không có tài khoản ${email}.`);
await c.end();
