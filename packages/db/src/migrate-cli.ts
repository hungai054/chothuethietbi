import { loadRootEnv } from './env';
import { migrate } from './migrate';
import { seed } from './seed';

loadRootEnv();
const url = process.env.DATABASE_ADMIN_URL;
if (!url) throw new Error('Thiếu DATABASE_ADMIN_URL (đặt trong .env ở gốc repo).');
console.log('migrate:', await migrate(url));
await seed(url);
console.log('seed ok');
