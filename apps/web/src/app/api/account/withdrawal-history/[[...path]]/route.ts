import { forwardWithdrawalRequest } from "../../../../../lib/withdrawal-proxy.ts";
export const GET = (request: Request, context: { params: Promise<{ path?: string[] }> }) => forwardWithdrawalRequest(request, context, "withdrawal-history");
