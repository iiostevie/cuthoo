export type ProductStatus = "ACTIVE" | "PAUSED" | "TERMINATED";
export type StopReason =
  | "MANUAL_PAUSE" | "MANUAL_UNSUBSCRIBE" | "PRODUCT_REMOVED" | "OUT_OF_STOCK" | "SALE_ENDED"
  | "SHOP_DISABLED" | "RATE_LIMITED" | "ACCESS_DENIED" | "PARSE_ERROR" | "NETWORK_ERROR"
  | "FINAL_WINDOW_ENDED";

export interface ProductSnapshot {
  title: string;
  variantId: string;
  sku: string | null;
  price: number | null;
  inventory: number;
  soldOut: boolean;
  saleEnded: boolean;
}
