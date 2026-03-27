export type InventoryStatus = "Available" | "Reserved" | "Sold Not Delivered" | "Delivered" | "Discontinued";

export type InventoryItem = {
  id: string;
  department: string;
  section: string;
  type: string;
  model: string;
  showroom_qty: number;
  warehouse_qty: number;
  reserved_qty: number;
  sold_not_delivered_qty: number;
  delivered_qty: number;
  on_order_qty: number;
  order_point: number;
  target_stock: number;
  otf: boolean;
  status: InventoryStatus;
  price: string;
  order_placed_date: string | null;
  order_notes: string;
  notes: string;
  created_at?: string;
  updated_at?: string;
};

export type ActivityItem = {
  id: string;
  event_type: string;
  model: string;
  qty_change: number;
  actor: string;
  created_at: string;
  notes: string;
};
