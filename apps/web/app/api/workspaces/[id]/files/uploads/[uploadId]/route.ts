import { api } from '@/server/api';
import { fileTransfer } from '@/server/file-transfers';
export const dynamic = 'force-dynamic';
export const PUT = api(request => fileTransfer(request, 'upload'), { contentType: 'application/octet-stream' });
export const DELETE = api(request => fileTransfer(request, 'cancel'));
