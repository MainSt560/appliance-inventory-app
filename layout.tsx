import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Appliance Inventory Manager",
  description: "Cloud inventory app for showroom and warehouse appliance tracking"
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
