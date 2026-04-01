"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import {
  AlertTriangle,
  Archive,
  ArrowDownCircle,
  ArrowRightLeft,
  BellRing,
  CheckCircle2,
  CircleCheck,
  ClipboardList,
  Download,
  History,
  Package,
  Plus,
  RefreshCcw,
  Search,
  ShoppingCart,
  Store,
  Tags,
  Trash2,
  Truck,
  Upload,
  Warehouse
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { ActivityItem, InventoryItem, InventoryStatus } from "@/lib/types";
import { DEFAULT_TARGET_STOCK, getAvailableToSell, getNeedsReorder, getPhysicalTotal, getSuggestedOrderQty, makeId, STATUS_OPTIONS } from "@/lib/utils";

const departmentsSeed = ["Refrigeration", "Laundry", "Cooking", "Dishwashers"];

const emptyItem: Omit<InventoryItem, "id"> = {
  department: "Refrigeration",
  section: "",
  type: "",
  model: "",
  showroom_qty: 0,
  warehouse_qty: 0,
  reserved_qty: 0,
  sold_not_delivered_qty: 0,
  delivered_qty: 0,
  on_order_qty: 0,
  order_point: 1,
  target_stock: DEFAULT_TARGET_STOCK,
  otf: false,
  status: "Available",
  price: "",
  order_placed_date: null,
  order_notes: "",
  notes: ""
};

function card(title: string, value: number, hint: string, Icon: React.ComponentType<{ className?: string }>) {
  return (
    <div className="rounded-3xl bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm text-slate-500">{title}</div>
          <div className="mt-2 text-3xl font-semibold">{value}</div>
          <div className="mt-1 text-sm text-slate-500">{hint}</div>
        </div>
        <div className="rounded-2xl bg-slate-100 p-3">
          <Icon className="h-5 w-5 text-slate-700" />
        </div>
      </div>
    </div>
  );
}

function cleanCell(value: unknown) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

function looksLikeModel(text: string) {
  if (!text || text.length < 4) return false;
  if (/^(qty|quantity|model|total)$/i.test(text)) return false;
  return /[A-Z]{2,}[A-Z0-9-]{2,}/i.test(text);
}

function isLikelySectionRow(values: unknown[]) {
  const joined = values.map(cleanCell).filter(Boolean).join(" ").trim();
  if (!joined || joined.length < 4) return false;
  const hasQty = values.some((v) => typeof v === "number" && Number.isFinite(v));
  if (hasQty) return false;
  return joined.toUpperCase() === joined && !/[0-9]{3,}/.test(joined);
}

function workbookToRows(file: File): Promise<InventoryItem[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = evt.target?.result;
        const workbook = XLSX.read(data, { type: "array" });
        const importedRows: InventoryItem[] = [];

        workbook.SheetNames.forEach((sheetName) => {
          const sheet = workbook.Sheets[sheetName];
          const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as unknown[][];
          let currentSection = "";

          matrix.forEach((rawRow) => {
            const values = rawRow.map(cleanCell);
            const nonEmpty = values.filter(Boolean);
            if (!nonEmpty.length) return;
            if (isLikelySectionRow(rawRow)) {
              currentSection = nonEmpty.join(" ");
              return;
            }

            let model = "";
            let type = "";
            let totalQty = 0;
            let onOrderQty = 0;
            let otf = false;
            let status: InventoryStatus = "Available";
            let price = "";

            rawRow.forEach((cell, index) => {
              const text = values[index];
              if (!model && looksLikeModel(text)) {
                model = text;
                return;
              }
              if (typeof cell === "number" && Number.isFinite(cell)) {
                if (totalQty === 0) totalQty = Math.max(0, Math.trunc(cell));
                else if (onOrderQty === 0) onOrderQty = Math.max(0, Math.trunc(cell));
                return;
              }
              const upper = text.toUpperCase();
              if (upper === "OTF") otf = true;
              if (["WASHER", "DRYER", "GAS", "ELECTRIC", "STACKED", "PAIR"].includes(upper)) type = text;
              if (upper.includes("DISCONTINUED")) status = "Discontinued";
              if (/^\$?[0-9,.]+$/.test(text) && text.includes("$")) price = text;
            });

            if (!model) return;
            importedRows.push({
              id: makeId(),
              department: sheetName,
              section: currentSection || "General",
              type,
              model,
              showroom_qty: 0,
              warehouse_qty: totalQty,
              reserved_qty: 0,
              sold_not_delivered_qty: 0,
              delivered_qty: 0,
              on_order_qty: onOrderQty,
              order_point: totalQty <= 1 ? 1 : 2,
              target_stock: DEFAULT_TARGET_STOCK,
              otf,
              status,
              price,
              order_placed_date: null,
              order_notes: "",
              notes: ""
            });
          });
        });

        if (!importedRows.length) throw new Error("No inventory rows were detected in the workbook.");
        resolve(importedRows);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.readAsArrayBuffer(file);
  });
}

export default function HomePage() {
  const [tab, setTab] = useState<"inventory" | "reorder" | "order-points" | "activity">("inventory");
  const [rows, setRows] = useState<InventoryItem[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("All");
  const [stockView, setStockView] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newItem, setNewItem] = useState(emptyItem);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Connecting to cloud inventory...");
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  async function loadData() {
    setStatusMessage("Loading cloud inventory...");
    const [{ data: inventoryData, error: inventoryError }, { data: activityData, error: activityError }] = await Promise.all([
      supabase.from("inventory_items").select("*").order("model"),
      supabase.from("activity_log").select("*").order("created_at", { ascending: false }).limit(50)
    ]);

    if (inventoryError || activityError) {
      setError(inventoryError?.message || activityError?.message || "Could not load cloud inventory.");
      setStatusMessage("Supabase connection needs setup.");
      return;
    }

    setRows((inventoryData as InventoryItem[]) || []);
    setActivity((activityData as ActivityItem[]) || []);
    setSelectedId((inventoryData as InventoryItem[])?.[0]?.id ?? null);
    setStatusMessage(`Loaded ${(inventoryData as InventoryItem[])?.length ?? 0} inventory items from Supabase.`);
  }

  useEffect(() => {
    loadData();
  }, []);

  const departments = useMemo(() => ["All", ...Array.from(new Set(rows.map((row) => row.department).filter(Boolean)))], [rows]);
  const selectedRow = useMemo(() => rows.find((row) => row.id === selectedId) || rows[0] || null, [rows, selectedId]);

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      const matchesDept = department === "All" || row.department === department;
      const haystack = `${row.model} ${row.section} ${row.department} ${row.type} ${row.status} ${row.notes} ${row.order_notes}`.toLowerCase();
      const matchesSearch = haystack.includes(search.toLowerCase());
      const available = getAvailableToSell(row);
      const matchesStock =
        stockView === "all" ||
        (stockView === "out" && available === 0) ||
        (stockView === "low" && available > 0 && available <= 1) ||
        (stockView === "reorder" && getNeedsReorder(row)) ||
        (stockView === "reserved" && row.reserved_qty > 0) ||
        (stockView === "on-order" && row.on_order_qty > 0) ||
        (stockView === "discontinued" && row.status === "Discontinued") ||
        (stockView === "otf" && row.otf);
      return matchesDept && matchesSearch && matchesStock;
    });
  }, [rows, department, search, stockView]);

  const metrics = useMemo(() => {
    const totalPhysical = rows.reduce((sum, row) => sum + getPhysicalTotal(row), 0);
    const available = rows.reduce((sum, row) => sum + getAvailableToSell(row), 0);
    const reserved = rows.reduce((sum, row) => sum + row.reserved_qty, 0);
    const onOrder = rows.reduce((sum, row) => sum + row.on_order_qty, 0);
    const reorderCount = rows.filter(getNeedsReorder).length;
    const showroom = rows.reduce((sum, row) => sum + row.showroom_qty, 0);
    return { totalPhysical, available, reserved, onOrder, reorderCount, showroom };
  }, [rows]);

  const reorderList = useMemo(() => rows.filter(getNeedsReorder).sort((a, b) => getSuggestedOrderQty(b) - getSuggestedOrderQty(a) || a.model.localeCompare(b.model)), [rows]);
  const orderPointList = useMemo(() => [...rows].sort((a, b) => a.department.localeCompare(b.department) || a.model.localeCompare(b.model)), [rows]);

  async function addActivity(eventType: string, model: string, qtyChange: number, notes = "") {
    await supabase.from("activity_log").insert({
      id: makeId(),
      event_type: eventType,
      model,
      qty_change: qtyChange,
      actor: "Shared Device",
      notes
    });
  }

  async function saveRow(updated: InventoryItem, activityType?: string, qtyChange = 0, notes = "") {
    setSaving(true);
    setError("");
    const cleanRow = {
  ...updated,
  product_id: null,
  model: updated.model,
};

const { error: saveError } = await supabase.from("inventory_items").upsert(cleanRow);
    if (saveError) {
      setError(saveError.message);
      setSaving(false);
      return;
    }
    if (activityType) await addActivity(activityType, updated.model, qtyChange, notes);
    await loadData();
    setSelectedId(updated.id);
    setSaving(false);
  }

  async function deleteRow(row: InventoryItem) {
    setSaving(true);
    const { error: deleteError } = await supabase.from("inventory_items").delete().eq("id", row.id);
    if (deleteError) {
      setError(deleteError.message);
      setSaving(false);
      return;
    }
    await addActivity("delete item", row.model, 0, "Removed from inventory");
    await loadData();
    setSaving(false);
  }

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setSaving(true);
    setError("");
    try {
      const importedRows = await workbookToRows(file);
      const { error: importError } = await supabase.from("inventory_items").upsert(importedRows);
      if (importError) throw importError;
      await addActivity("import workbook", file.name, importedRows.length, "Workbook imported to cloud inventory");
      await loadData();
      setStatusMessage(`Imported ${importedRows.length} rows from ${file.name}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    }
    setSaving(false);
    event.target.value = "";
  }

  function exportWorkbook() {
    const exportData = rows.map((row) => ({
      Department: row.department,
      Section: row.section,
      Type: row.type,
      Model: row.model,
      ShowroomQty: row.showroom_qty,
      WarehouseQty: row.warehouse_qty,
      ReservedQty: row.reserved_qty,
      SoldNotDeliveredQty: row.sold_not_delivered_qty,
      DeliveredQty: row.delivered_qty,
      OnOrderQty: row.on_order_qty,
      OrderPoint: row.order_point,
      TargetStock: row.target_stock,
      AvailableToSell: getAvailableToSell(row),
      SuggestedOrderQty: getSuggestedOrderQty(row),
      Status: row.status,
      OTF: row.otf ? "Yes" : "No",
      SuggestedRetail: row.price,
      OrderPlacedDate: row.order_placed_date ?? "",
      OrderNotes: row.order_notes,
      Notes: row.notes
    }));
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(exportData);
    XLSX.utils.book_append_sheet(workbook, worksheet, "Inventory");
    XLSX.writeFile(workbook, "appliance-inventory-live.xlsx");
  }

  async function addNewItem() {
    if (!newItem.model.trim()) return;
    const row: InventoryItem = { ...newItem, id: makeId(), model: newItem.model.trim() };
    await saveRow(row, "add item", getPhysicalTotal(row), "Added from web app");
    setNewItem(emptyItem);
  }

  async function patchSelected(patch: Partial<InventoryItem>, activityType?: string, qtyChange = 0, notes = "") {
    if (!selectedRow) return;
    const updated = { ...selectedRow, ...patch };
    await saveRow(updated, activityType, qtyChange, notes);
  }

  async function markSold() {
    if (!selectedRow) return;
    if (selectedRow.showroom_qty > 0) {
      await patchSelected({
        showroom_qty: selectedRow.showroom_qty - 1,
        sold_not_delivered_qty: selectedRow.sold_not_delivered_qty + 1,
        status: "Sold Not Delivered"
      }, "mark sold", -1, "Marked sold from showroom inventory");
      return;
    }
    if (selectedRow.warehouse_qty > 0) {
      await patchSelected({
        warehouse_qty: selectedRow.warehouse_qty - 1,
        sold_not_delivered_qty: selectedRow.sold_not_delivered_qty + 1,
        status: "Sold Not Delivered"
      }, "mark sold", -1, "Marked sold from warehouse inventory");
    }
  }

  async function moveToShowroom() {
    if (!selectedRow || selectedRow.warehouse_qty <= 0) return;
    await patchSelected({ warehouse_qty: selectedRow.warehouse_qty - 1, showroom_qty: selectedRow.showroom_qty + 1 }, "move to showroom", 1, "Moved one unit from warehouse to showroom floor");
  }

  async function reserveOne() {
    if (!selectedRow || getAvailableToSell(selectedRow) <= 0) return;
    await patchSelected({ reserved_qty: selectedRow.reserved_qty + 1, status: "Reserved" }, "reserve", 1, "Reserved one unit");
  }

  async function receiveOne(location: "Warehouse" | "Showroom Floor") {
    if (!selectedRow) return;
    const patch: Partial<InventoryItem> = {
      on_order_qty: Math.max(0, selectedRow.on_order_qty - 1),
      status: selectedRow.status === "Discontinued" ? "Discontinued" : "Available"
    };
    if (location === "Warehouse") patch.warehouse_qty = selectedRow.warehouse_qty + 1;
    else patch.showroom_qty = selectedRow.showroom_qty + 1;
    await patchSelected(patch, `receive to ${location.toLowerCase()}`, 1, `Received one unit to ${location}`);
  }

  async function placeOnOrder() {
    if (!selectedRow) return;
    await patchSelected({ on_order_qty: selectedRow.on_order_qty + 1, order_placed_date: new Date().toISOString().slice(0, 10) }, "placed on order", 1, "Marked as placed in vendor portal");
  }

  async function markDelivered() {
    if (!selectedRow || selectedRow.sold_not_delivered_qty <= 0) return;
    const nextSold = selectedRow.sold_not_delivered_qty - 1;
    await patchSelected({
      sold_not_delivered_qty: nextSold,
      delivered_qty: selectedRow.delivered_qty + 1,
      status: nextSold > 0 ? "Sold Not Delivered" : "Delivered"
    }, "mark delivered", 1, "Marked customer delivery complete");
  }

  return (
    <main className="min-h-screen p-4 text-slate-900 sm:p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="grid gap-4 xl:grid-cols-[1.5fr_.95fr]">
          <div className="rounded-[30px] bg-slate-900 p-7 text-white shadow-xl sm:p-8">
            <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <div className="text-sm uppercase tracking-[0.25em] text-slate-300">Version 3 · live cloud app</div>
                <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">Appliance Inventory Manager</h1>
                <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-300">
                  This build is ready for Vercel and uses Supabase so your team can share one live inventory across iPad, desktop, and phone.
                </p>
                <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-300">
                  <span className="rounded-full bg-slate-800 px-3 py-1">Cloud database</span>
                  <span className="rounded-full bg-slate-800 px-3 py-1">Monday reorder logic</span>
                  <span className="rounded-full bg-slate-800 px-3 py-1">Shared-device workflow</span>
                  <span className="rounded-full bg-slate-800 px-3 py-1">Vercel ready</span>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <button onClick={() => fileInputRef.current?.click()} className="rounded-2xl bg-white px-4 py-3 font-medium text-slate-900 hover:bg-slate-100">
                  <Upload className="mr-2 inline h-4 w-4" /> Import workbook
                </button>
                <button onClick={exportWorkbook} className="rounded-2xl bg-slate-700 px-4 py-3 font-medium text-white hover:bg-slate-600">
                  <Download className="mr-2 inline h-4 w-4" /> Export workbook
                </button>
                <button onClick={addNewItem} className="rounded-2xl bg-emerald-500 px-4 py-3 font-medium text-white hover:bg-emerald-600 sm:col-span-2">
                  <Plus className="mr-2 inline h-4 w-4" /> Save new item
                </button>
                <input ref={fileInputRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImport} />
              </div>
            </div>
          </div>

          <div className="rounded-[30px] bg-white p-6 shadow-sm">
            <div className="text-sm font-medium text-slate-500">Cloud status</div>
            <div className="mt-4 grid gap-3 text-sm text-slate-700">
              <div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 h-4 w-4" /> Team shares one live inventory through Supabase.</div>
              <div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 h-4 w-4" /> Vercel deploy gives you a web app you can save to iPad home screen.</div>
              <div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 h-4 w-4" /> Import keeps your spreadsheet useful as a migration path.</div>
            </div>
            <div className="mt-5 rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">{statusMessage}</div>
            {saving ? <div className="mt-3 text-sm text-blue-700">Saving to cloud…</div> : null}
            {error ? <div className="mt-3 text-sm text-rose-600">{error}</div> : null}
          </div>
        </section>

        <div className="rounded-3xl bg-white p-3 shadow-sm">
          <div className="flex flex-wrap gap-2 rounded-2xl bg-slate-100 p-2">
            {[
              ["inventory", "Inventory"],
              ["reorder", "Monday Reorder"],
              ["order-points", "Order Points"],
              ["activity", "Activity"]
            ].map(([value, label]) => (
              <button key={value} onClick={() => setTab(value as typeof tab)} className={`rounded-xl px-4 py-2 ${tab === value ? "bg-white shadow-sm" : "text-slate-600"}`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
          {card("Physical units", metrics.totalPhysical, "Showroom + warehouse", Package)}
          {card("Available to sell", metrics.available, "Excludes reserved and sold not delivered", Store)}
          {card("Reserved", metrics.reserved, "Not sellable right now", Archive)}
          {card("On order", metrics.onOrder, "Already placed in portal", Truck)}
          {card("Needs reorder", metrics.reorderCount, "Below order point", BellRing)}
          {card("Showroom units", metrics.showroom, "On the floor", Warehouse)}
        </div>

        {tab === "inventory" ? (
          <div className="grid gap-6 2xl:grid-cols-[1.55fr_.9fr_.95fr] xl:grid-cols-[1.35fr_.95fr]">
            <div className="space-y-6">
              <section className="rounded-[28px] bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 text-xl font-semibold"><Search className="h-5 w-5" /> Inventory browser</div>
                  <button onClick={loadData} className="rounded-2xl border px-3 py-2 text-sm hover:bg-slate-50"><RefreshCcw className="mr-2 inline h-4 w-4" /> Refresh</button>
                </div>
                <div className="space-y-4">
                  <div className="grid gap-3 lg:grid-cols-[1.2fr_.7fr]">
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search model, section, notes, or order notes" className="w-full rounded-2xl border bg-white py-3 pl-10 pr-4 outline-none focus:ring" />
                    </div>
                    <select value={department} onChange={(e) => setDepartment(e.target.value)} className="rounded-2xl border bg-white px-4 py-3 outline-none focus:ring">
                      {departments.map((dep) => <option key={dep} value={dep}>{dep}</option>)}
                    </select>
                  </div>

                  <div className="flex flex-wrap gap-2 rounded-2xl bg-slate-100 p-2">
                    {["all", "out", "low", "reorder", "reserved", "on-order", "otf", "discontinued"].map((value) => (
                      <button key={value} onClick={() => setStockView(value)} className={`rounded-xl px-4 py-2 capitalize ${stockView === value ? "bg-white shadow-sm" : "text-slate-600"}`}>{value.replace("-", " ")}</button>
                    ))}
                  </div>

                  <div className="max-h-[760px] overflow-auto rounded-3xl border border-slate-200">
                    <div className="hidden grid-cols-[1.1fr_.85fr_.55fr_.55fr_.55fr_.65fr] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500 lg:grid">
                      <div>Model</div>
                      <div>Department / Section</div>
                      <div className="text-center">Showroom</div>
                      <div className="text-center">Warehouse</div>
                      <div className="text-center">Available</div>
                      <div>Status</div>
                    </div>
                    {filteredRows.map((row) => (
                      <button key={row.id} onClick={() => setSelectedId(row.id)} className={`block w-full border-b border-slate-100 text-left hover:bg-slate-50 ${selectedId === row.id ? "bg-slate-50" : "bg-white"}`}>
                        <div className="grid gap-3 px-4 py-4 lg:grid-cols-[1.1fr_.85fr_.55fr_.55fr_.55fr_.65fr] lg:items-center">
                          <div>
                            <div className="font-medium text-slate-900">{row.model}</div>
                            <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-500">
                              {row.otf ? <span className="rounded-full bg-blue-100 px-2 py-1 text-blue-700">OTF</span> : null}
                              {getNeedsReorder(row) ? <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-700">Reorder</span> : null}
                            </div>
                          </div>
                          <div>
                            <div>{row.department}</div>
                            <div className="mt-1 text-xs text-slate-500">{row.section}</div>
                          </div>
                          <div className="text-center text-base font-semibold">{row.showroom_qty}</div>
                          <div className="text-center text-base font-semibold">{row.warehouse_qty}</div>
                          <div className="text-center text-base font-semibold">{getAvailableToSell(row)}</div>
                          <div className="space-y-1 text-sm text-slate-600">
                            <div>{row.status}</div>
                            <div className="text-xs text-slate-500">On order {row.on_order_qty}</div>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </section>
            </div>

            <div className="space-y-6">
              <section className="rounded-[28px] bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-center gap-3 text-xl font-semibold"><ClipboardList className="h-5 w-5" /> Item detail</div>
                {selectedRow ? (
                  <div className="space-y-4">
                    <div>
                      <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Selected item</div>
                      <div className="mt-2 text-xl font-semibold">{selectedRow.model}</div>
                      <div className="mt-1 text-sm text-slate-500">{selectedRow.department} · {selectedRow.section}</div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      {[ ["Showroom", selectedRow.showroom_qty], ["Warehouse", selectedRow.warehouse_qty], ["Reserved", selectedRow.reserved_qty], ["On order", selectedRow.on_order_qty] ].map(([label, value]) => (
                        <div key={String(label)} className="rounded-2xl bg-slate-50 p-4"><div className="text-xs uppercase tracking-wide text-slate-400">{label}</div><div className="mt-2 text-2xl font-semibold">{value}</div></div>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button onClick={markSold} className="rounded-2xl border px-3 py-3 hover:bg-slate-50"><ShoppingCart className="mr-2 inline h-4 w-4" /> Mark sold</button>
                      <button onClick={moveToShowroom} className="rounded-2xl border px-3 py-3 hover:bg-slate-50"><ArrowRightLeft className="mr-2 inline h-4 w-4" /> Move to floor</button>
                      <button onClick={reserveOne} className="rounded-2xl border px-3 py-3 hover:bg-slate-50"><Archive className="mr-2 inline h-4 w-4" /> Reserve</button>
                      <button onClick={placeOnOrder} className="rounded-2xl border px-3 py-3 hover:bg-slate-50"><Truck className="mr-2 inline h-4 w-4" /> Place on order</button>
                      <button onClick={() => receiveOne("Warehouse")} className="rounded-2xl border px-3 py-3 hover:bg-slate-50"><ArrowDownCircle className="mr-2 inline h-4 w-4" /> Receive to warehouse</button>
                      <button onClick={() => receiveOne("Showroom Floor")} className="rounded-2xl border px-3 py-3 hover:bg-slate-50"><Store className="mr-2 inline h-4 w-4" /> Receive to floor</button>
                      <button onClick={markDelivered} className="rounded-2xl border px-3 py-3 hover:bg-slate-50"><CircleCheck className="mr-2 inline h-4 w-4" /> Mark delivered</button>
                      <button onClick={() => patchSelected({ otf: !selectedRow.otf }, "toggle otf", 0, "Toggled OTF flag")} className="rounded-2xl border px-3 py-3 hover:bg-slate-50"><Tags className="mr-2 inline h-4 w-4" /> Toggle OTF</button>
                    </div>
                    <div className="grid gap-3">
                      <div className="grid grid-cols-2 gap-3">
                        <label className="text-sm">Order point<input type="number" value={selectedRow.order_point} onChange={(e) => patchSelected({ order_point: Number(e.target.value || 0) })} className="mt-1 w-full rounded-2xl border px-3 py-2" /></label>
                        <label className="text-sm">Target stock<input type="number" value={selectedRow.target_stock} onChange={(e) => patchSelected({ target_stock: Number(e.target.value || 0) })} className="mt-1 w-full rounded-2xl border px-3 py-2" /></label>
                      </div>
                      <label className="text-sm">Status<select value={selectedRow.status} onChange={(e) => patchSelected({ status: e.target.value as InventoryStatus })} className="mt-1 w-full rounded-2xl border bg-white px-3 py-2">{STATUS_OPTIONS.map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
                      <div className="grid grid-cols-2 gap-3">
                        <label className="text-sm">Order placed date<input value={selectedRow.order_placed_date ?? ""} onChange={(e) => patchSelected({ order_placed_date: e.target.value || null })} className="mt-1 w-full rounded-2xl border px-3 py-2" /></label>
                        <label className="text-sm">Suggested retail<input value={selectedRow.price} onChange={(e) => patchSelected({ price: e.target.value })} className="mt-1 w-full rounded-2xl border px-3 py-2" /></label>
                      </div>
                      <label className="text-sm">Order notes<textarea value={selectedRow.order_notes} onChange={(e) => patchSelected({ order_notes: e.target.value })} className="mt-1 min-h-[70px] w-full rounded-2xl border px-3 py-2" /></label>
                      <label className="text-sm">Notes<textarea value={selectedRow.notes} onChange={(e) => patchSelected({ notes: e.target.value })} className="mt-1 min-h-[90px] w-full rounded-2xl border px-3 py-2" /></label>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => patchSelected({ status: "Discontinued" })} className="rounded-2xl border px-3 py-2 hover:bg-slate-50">Mark discontinued</button>
                      <button onClick={() => deleteRow(selectedRow)} className="rounded-2xl border px-3 py-2 text-rose-600 hover:bg-rose-50"><Trash2 className="mr-2 inline h-4 w-4" /> Delete</button>
                    </div>
                  </div>
                ) : <div className="text-sm text-slate-500">Select an item to view and edit it.</div>}
              </section>
            </div>

            <div className="space-y-6 xl:col-span-2 2xl:col-span-1">
              <section className="rounded-[28px] bg-white p-6 shadow-sm">
                <div className="mb-4 flex items-center gap-3 text-xl font-semibold"><BellRing className="h-5 w-5" /> Quick reorder preview</div>
                <div className="space-y-3 max-h-[430px] overflow-auto pr-1">
                  {reorderList.slice(0, 12).map((item) => (
                    <div key={item.id} className="rounded-2xl border border-slate-200 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium text-slate-900">{item.model}</div>
                          <div className="mt-1 text-xs text-slate-500">Available {getAvailableToSell(item)} · On order {item.on_order_qty}</div>
                        </div>
                        <span className="rounded-full bg-amber-100 px-2 py-1 text-sm text-amber-700">Order {getSuggestedOrderQty(item)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
        ) : tab === "reorder" ? (
          <div className="grid gap-6 xl:grid-cols-[1.45fr_.9fr]">
            <section className="rounded-[28px] bg-white p-6 shadow-sm">
              <div className="mb-4 flex items-center gap-3 text-xl font-semibold"><ShoppingCart className="h-5 w-5" /> Monday reorder list</div>
              <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">This list shows every item below order point. Suggested quantity subtracts anything already placed on order.</div>
              <div className="mt-4 max-h-[760px] overflow-auto rounded-3xl border border-slate-200">
                <div className="grid grid-cols-[1.1fr_.45fr_.45fr_.45fr_.45fr_.45fr_.5fr_.6fr] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <div>Model</div><div className="text-center">Floor</div><div className="text-center">Warehouse</div><div className="text-center">Reserved</div><div className="text-center">Available</div><div className="text-center">On order</div><div className="text-center">Target</div><div className="text-center">Suggested</div>
                </div>
                {reorderList.map((row) => (
                  <div key={row.id} className="grid grid-cols-[1.1fr_.45fr_.45fr_.45fr_.45fr_.45fr_.5fr_.6fr] gap-3 border-b border-slate-100 px-4 py-4 items-center">
                    <div>
                      <div className="font-medium text-slate-900">{row.model}</div>
                      <div className="mt-1 text-xs text-slate-500">{row.department} · OP {row.order_point}</div>
                    </div>
                    <div className="text-center font-semibold">{row.showroom_qty}</div>
                    <div className="text-center font-semibold">{row.warehouse_qty}</div>
                    <div className="text-center font-semibold">{row.reserved_qty}</div>
                    <div className="text-center font-semibold">{getAvailableToSell(row)}</div>
                    <div className="text-center font-semibold">{row.on_order_qty}</div>
                    <div className="text-center font-semibold">{row.target_stock}</div>
                    <div className="flex items-center justify-center gap-2">
                      <span className="rounded-full bg-amber-100 px-2 py-1 text-sm text-amber-700">{getSuggestedOrderQty(row)}</span>
                      <button onClick={() => setSelectedId(row.id)} className="rounded-xl border px-2 py-1 text-sm hover:bg-slate-50">Open</button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-[28px] bg-white p-6 shadow-sm">
              <div className="mb-4 flex items-center gap-3 text-xl font-semibold"><AlertTriangle className="h-5 w-5" /> Reorder rules</div>
              <div className="space-y-3">
                <div className="rounded-2xl bg-slate-50 p-4"><div className="text-xs uppercase tracking-wide text-slate-400">Default target stock</div><div className="mt-2 text-3xl font-semibold">{DEFAULT_TARGET_STOCK}</div></div>
                <div className="rounded-2xl bg-slate-50 p-4 text-sm">Available to sell = showroom + warehouse − reserved − sold not delivered</div>
                <div className="rounded-2xl bg-slate-50 p-4 text-sm">Suggested order = target stock − available to sell − on order</div>
                <div className="rounded-2xl bg-slate-50 p-4 text-sm">The app shows the reorder list only. Orders still go through your vendor portal.</div>
              </div>
            </section>
          </div>
        ) : tab === "order-points" ? (
          <div className="grid gap-6 xl:grid-cols-[1.35fr_.95fr]">
            <section className="rounded-[28px] bg-white p-6 shadow-sm">
              <div className="mb-4 flex items-center gap-3 text-xl font-semibold"><BellRing className="h-5 w-5" /> Order point manager</div>
              <div className="rounded-2xl bg-slate-50 p-4 text-sm text-slate-600">Set order point and target stock here for each item.</div>
              <div className="mt-4 max-h-[760px] overflow-auto rounded-3xl border border-slate-200">
                <div className="grid grid-cols-[1.1fr_.7fr_.4fr_.5fr_.5fr_.6fr] gap-3 border-b border-slate-200 bg-slate-50 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">
                  <div>Model</div><div>Department</div><div className="text-center">Avail</div><div className="text-center">Order point</div><div className="text-center">Target</div><div>Status</div>
                </div>
                {orderPointList.map((row) => (
                  <div key={row.id} className="grid grid-cols-[1.1fr_.7fr_.4fr_.5fr_.5fr_.6fr] gap-3 border-b border-slate-100 px-4 py-4 items-center">
                    <div><div className="font-medium">{row.model}</div><div className="mt-1 text-xs text-slate-500">{row.section}</div></div>
                    <div className="text-sm">{row.department}</div>
                    <div className="text-center font-semibold">{getAvailableToSell(row)}</div>
                    <div className="px-2"><input type="number" value={row.order_point} onChange={(e) => saveRow({ ...row, order_point: Number(e.target.value || 0) })} className="w-full rounded-2xl border px-3 py-2 text-center" /></div>
                    <div className="px-2"><input type="number" value={row.target_stock} onChange={(e) => saveRow({ ...row, target_stock: Number(e.target.value || 0) })} className="w-full rounded-2xl border px-3 py-2 text-center" /></div>
                    <div>{getNeedsReorder(row) ? <span className="rounded-full bg-amber-100 px-2 py-1 text-sm text-amber-700">Needs reorder</span> : <span className="rounded-full bg-slate-100 px-2 py-1 text-sm text-slate-700">OK</span>}</div>
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-[28px] bg-white p-6 shadow-sm">
              <div className="mb-4 flex items-center gap-3 text-xl font-semibold"><Package className="h-5 w-5" /> Add item</div>
              <div className="grid gap-3 sm:grid-cols-2">
                <input placeholder="Model" value={newItem.model} onChange={(e) => setNewItem({ ...newItem, model: e.target.value })} className="rounded-2xl border px-3 py-2 sm:col-span-2" />
                <input placeholder="Section" value={newItem.section} onChange={(e) => setNewItem({ ...newItem, section: e.target.value })} className="rounded-2xl border px-3 py-2" />
                <input placeholder="Type" value={newItem.type} onChange={(e) => setNewItem({ ...newItem, type: e.target.value })} className="rounded-2xl border px-3 py-2" />
                <select value={newItem.department} onChange={(e) => setNewItem({ ...newItem, department: e.target.value })} className="rounded-2xl border bg-white px-3 py-2">{departmentsSeed.map((dep) => <option key={dep} value={dep}>{dep}</option>)}</select>
                <select value={newItem.status} onChange={(e) => setNewItem({ ...newItem, status: e.target.value as InventoryStatus })} className="rounded-2xl border bg-white px-3 py-2">{STATUS_OPTIONS.map((status) => <option key={status} value={status}>{status}</option>)}</select>
                <input type="number" placeholder="Showroom qty" value={newItem.showroom_qty} onChange={(e) => setNewItem({ ...newItem, showroom_qty: Number(e.target.value || 0) })} className="rounded-2xl border px-3 py-2" />
                <input type="number" placeholder="Warehouse qty" value={newItem.warehouse_qty} onChange={(e) => setNewItem({ ...newItem, warehouse_qty: Number(e.target.value || 0) })} className="rounded-2xl border px-3 py-2" />
                <input type="number" placeholder="Order point" value={newItem.order_point} onChange={(e) => setNewItem({ ...newItem, order_point: Number(e.target.value || 0) })} className="rounded-2xl border px-3 py-2" />
                <input type="number" placeholder="Target stock" value={newItem.target_stock} onChange={(e) => setNewItem({ ...newItem, target_stock: Number(e.target.value || 0) })} className="rounded-2xl border px-3 py-2" />
                <input placeholder="Suggested retail" value={newItem.price} onChange={(e) => setNewItem({ ...newItem, price: e.target.value })} className="rounded-2xl border px-3 py-2" />
                <input placeholder="Notes" value={newItem.notes} onChange={(e) => setNewItem({ ...newItem, notes: e.target.value })} className="rounded-2xl border px-3 py-2 sm:col-span-2" />
                <button onClick={addNewItem} className="rounded-2xl bg-emerald-500 px-4 py-3 font-medium text-white hover:bg-emerald-600 sm:col-span-2"><Plus className="mr-2 inline h-4 w-4" /> Save item</button>
              </div>
            </section>
          </div>
        ) : (
          <div className="grid gap-6 xl:grid-cols-[1.1fr_.9fr]">
            <section className="rounded-[28px] bg-white p-6 shadow-sm">
              <div className="mb-4 flex items-center gap-3 text-xl font-semibold"><History className="h-5 w-5" /> Recent activity</div>
              <div className="space-y-3">
                {activity.map((entry) => (
                  <div key={entry.id} className="rounded-2xl bg-slate-50 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="font-medium capitalize text-slate-900">{entry.event_type}</div>
                        <div className="mt-1 text-sm text-slate-600 break-all">{entry.model}</div>
                      </div>
                      <div className="text-right text-xs text-slate-500">
                        <div>{entry.actor}</div>
                        <div className="mt-1">{new Date(entry.created_at).toLocaleString()}</div>
                      </div>
                    </div>
                    {entry.qty_change !== 0 ? <div className="mt-2 text-sm text-slate-700">Change: {entry.qty_change > 0 ? `+${entry.qty_change}` : entry.qty_change}</div> : null}
                    {entry.notes ? <div className="mt-2 text-sm text-slate-600">{entry.notes}</div> : null}
                  </div>
                ))}
              </div>
            </section>
            <section className="rounded-[28px] bg-white p-6 shadow-sm">
              <div className="mb-4 flex items-center gap-3 text-xl font-semibold"><ClipboardList className="h-5 w-5" /> Team notes</div>
              <div className="space-y-3 text-sm text-slate-700">
                <div className="rounded-2xl bg-slate-50 p-4">Shared device mode is built for a single in-store iPad or desktop.</div>
                <div className="rounded-2xl bg-slate-50 p-4">Supabase keeps inventory live across devices, unlike the previous local-only build.</div>
                <div className="rounded-2xl bg-slate-50 p-4">You can later add staff logins if you want named actions instead of Shared Device.</div>
              </div>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
