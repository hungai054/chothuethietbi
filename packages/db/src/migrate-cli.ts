import { migrate } from './migrate';
import { seed } from './seed';

const url = process.env.DATABASE_ADMIN_URL ?? 'postgresql://postgres:postgres@localhost:5432/rentpro';
console.log('migrate:', await migrate(url));
await seed(url);
console.log('seed ok');
