import "./globals.css";

export const metadata = {
  title: "Monitoramento V2 — First Mile",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
