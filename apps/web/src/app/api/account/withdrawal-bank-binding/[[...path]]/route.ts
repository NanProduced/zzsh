import { forwardWithdrawalRequest } from "../../../../../lib/withdrawal-proxy.ts";
type Context = { params: Promise<{ path?: string[] }> };
export const GET = (request: Request, context: Context) => forwardWithdrawalRequest(request, context, "withdrawal-bank-binding");
export const POST = (request: Request, context: Context) => forwardWithdrawalRequest(request, context, "withdrawal-bank-binding");
