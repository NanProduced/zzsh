import { forwardOrderRequest } from "../../../../lib/order-proxy.ts";

export async function POST(request:Request) {
  return forwardOrderRequest(request,{params:Promise.resolve({})},"orders-v2");
}
