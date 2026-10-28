import { forwardOrderRequest } from "../../../lib/order-proxy.ts";

export async function GET(request: Request) {
  return forwardOrderRequest(request, { params: Promise.resolve({}) }, "rental-price-preview");
}
