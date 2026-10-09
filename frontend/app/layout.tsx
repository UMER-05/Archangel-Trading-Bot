import "@lib/cryptoPolyfill";
import "./globals.css";
import localFont from "next/font/local";
import Navbar from "@components/layout/navbar";
import Footer from "@components/layout/footer";
import { Toaster } from "react-hot-toast";
import type { Metadata, Viewport } from "next";
import { SocketProvider } from "./providers/SocketProvider";
import { SolanaWalletProvider } from "./providers/WalletProvider";
import { WalletDataProvider } from "./providers/WalletDataProvider";
import { AccountNotifications } from "@components/trading/AccountNotifications";

// Genuinely self-hosted — the actual variable-font .woff2 files ship inside
// the @fontsource-variable/* packages in node_modules, so next/font/local
// reads them straight off disk. next/font/google looked self-hosted too
// (same "no client-side external request" outcome) but still had to fetch
// the source files from Google's font CDN the first time it compiled, which
// fails outright on a machine that can't reach fonts.googleapis.com. This
// has zero network dependency at any point. Sora carries headings/display
// numbers (confident, geometric — fits a trading terminal); Inter carries
// body copy (dense-data legibility); JetBrains Mono carries
// addresses/figures/logs (real tabular figures).
const sora = localFont({
  src: "../node_modules/@fontsource-variable/sora/files/sora-latin-wght-normal.woff2",
  weight: "500 800",
  variable: "--font-display",
  display: "swap",
});
const inter = localFont({
  src: "../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
  weight: "400 700",
  variable: "--font-body",
  display: "swap",
});
const jetbrainsMono = localFont({
  src: "../node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2",
  weight: "400 600",
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ArchAngel Bot – Solana Trading Dashboard",
  description:
    "Automated Solana meme coin trading assistant powered by Jupiter DEX routing.",
  metadataBase: new URL("https://archangelbot.app"), // ✅ base for OpenGraph/Twitter images
  manifest: "/manifest.json",
  icons: {
    icon: [
      {
        url: "/icons/manifest-icon-192.maskable.png",
        type: "image/png",
        sizes: "192x192",
      },
      {
        url: "/icons/manifest-icon-512.maskable.png",
        type: "image/png",
        sizes: "512x512",
      },
    ],
    apple: [
      { url: "/icons/manifest-icon-192.maskable.png" },
      { url: "/icons/manifest-icon-512.maskable.png" },
    ],
  },
  openGraph: {
    title: "ArchAngel Bot",
    description:
      "Automated Solana meme coin trading assistant powered by Jupiter DEX routing.",
    url: "https://archangelbot.app",
    siteName: "ArchAngel Bot",
    images: [
      {
        url: "/icons/manifest-icon-512.maskable.png",
        width: 512,
        height: 512,
        alt: "ArchAngel Bot Logo",
      },
    ],
    locale: "en_US",
    type: "website",
  },
};

// ✅ Move themeColor to viewport (new Next.js convention)
export const viewport: Viewport = {
  themeColor: "#08080D",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${sora.variable} ${inter.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        {/* Progressive Web App meta tags */}
        <meta name="application-name" content="ArchAngel Bot" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta
          name="apple-mobile-web-app-status-bar-style"
          content="black-translucent"
        />
      </head>

      <body className="min-h-screen flex flex-col bg-base-100 text-base-content font-sans transition-colors duration-300">
        <SolanaWalletProvider>
          <SocketProvider>
            {/* Wallet balance polling, provisioning and the authenticated
                socket identify run ONCE here; useWallet() reads the result. */}
            <WalletDataProvider>
              <AccountNotifications />
              <Navbar />

              <main className="flex-grow container mx-auto px-4 py-8">
                {children}
              </main>

              <Footer />

              <Toaster
                position="bottom-right"
                toastOptions={{
                  className:
                    "bg-neutral text-neutral-content rounded-lg shadow-md",
                  duration: 3000,
                }}
              />
            </WalletDataProvider>
          </SocketProvider>
        </SolanaWalletProvider>
      </body>
    </html>
  );
}
