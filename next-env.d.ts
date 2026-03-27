import { InventoryItem } from "@/lib/types";

export const DEFAULT_TARGET_STOCK = 2;
export const STATUS_OPTIONS = ["Available", "Reserved", "Sold Not Delivered", "Delivered", "Discontinued"] as const;

export function getPhysicalTotal(row: InventoryItem) {
  return Number(row.showroom_qty || 0) + Number(row.warehouse_qty || 0);
}

export function getAvailableToSell(row: InventoryItem) {
  return Math.max(0, getPhysicalTotal(row) - Number(row.reserved_qty || 0) - Number(row.sold_not_delivered_qty || 0));
}

export function getSuggestedOrderQty(row: InventoryItem) {
  const needed = Number(row.target_stock || 0) - getAvailableToSell(row) - Number(row.on_order_qty || 0);
  return Math.max(0, needed);
}

export function getNeedsReorder(row: InventoryItem) {
  return getAvailableToSell(row) <= Number(row.order_point || 0) && row.status !== "Discontinued";
}

export function makeId() {
  return crypto.randomUUID();
}
