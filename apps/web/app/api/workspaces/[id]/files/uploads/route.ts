import { api } from '@/server/api';
import { fileTransfer } from '@/server/file-transfers';
export const dynamic = 'force-dynamic';
export const POST = api(request => fileTransfer(request, 'create'));
