import "./globals.css";

export const metadata = {
  title: "PULSE — First Mile Operations",
  description: "Pickup Unified Logistics Surveillance & Execution",
};

export const viewport = { themeColor: "#ffe600" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
