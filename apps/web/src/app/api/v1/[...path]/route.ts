import { handleApi } from '@/lib/api-v1';

export const dynamic = 'force-dynamic';

const go = (req: Request) => handleApi(req, new URL(req.url).pathname);
export const GET = go;
export const POST = go;
