import { sharedProvidersFromEnv } from '@rentpro/notifications';

/** Tài khoản gửi chung của nền tảng (cùng biến môi trường với worker) dùng khi cửa hàng bấm "Gửi thử" ở chế độ dùng chung. */
export const sharedFromEnv = () => sharedProvidersFromEnv(process.env);
