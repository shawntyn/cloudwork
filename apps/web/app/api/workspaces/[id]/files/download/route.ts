import { api } from '@/server/api';
import { fileTransfer } from '@/server/file-transfers';
export const dynamic = 'force-dynamic';
export const GET = api(request => fileTransfer(request, 'download'));
