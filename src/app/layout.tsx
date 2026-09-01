import type { Metadata } from "next";
import {
  BIZ_UDPGothic,
  Geist_Mono,
  Noto_Sans_JP,
  Noto_Serif_JP,
  Shippori_Mincho,
  Zen_Kaku_Gothic_New,
  Zen_Maru_Gothic,
} from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";

const notoSansJP = localFont({
  src: [
    {
      path: "./fonts/NotoSansJP-Regular.otf",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/NotoSansJP-Bold.otf",
      weight: "700",
      style: "normal",
    },
  ],
  variable: "--font-noto-sans-jp",
  display: "swap",
  preload: false,
  fallback: ["Hiragino Sans", "Yu Gothic", "Meiryo", "sans-serif"],
  adjustFontFallback: false,
});

const uiFont = Noto_Sans_JP({
  weight: ["400", "500", "700"],
  subsets: ["latin"],
  variable: "--font-ui",
  display: "swap",
  preload: false,
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

/* PDF フォント選択肢。@font-face 宣言のみ注入され、選択されるまで実ダウンロードは起きない。 */
const notoSerifJP = Noto_Serif_JP({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-noto-serif-jp",
  display: "swap",
  preload: false,
});

const zenKakuGothicNew = Zen_Kaku_Gothic_New({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-zen-kaku-gothic",
  display: "swap",
  preload: false,
});

const shipporiMincho = Shippori_Mincho({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-shippori-mincho",
  display: "swap",
  preload: false,
});

const bizUDPGothic = BIZ_UDPGothic({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-biz-udpgothic",
  display: "swap",
  preload: false,
});

const zenMaruGothic = Zen_Maru_Gothic({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-zen-maru-gothic",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: "商談くんミニ（簡易版）",
  description: "動画・音声から自動で文書を生成",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <head>
        <meta name="color-scheme" content="light" />
      </head>
      <body
        className={`${uiFont.variable} ${notoSansJP.variable} ${geistMono.variable} ${notoSerifJP.variable} ${zenKakuGothicNew.variable} ${shipporiMincho.variable} ${bizUDPGothic.variable} ${zenMaruGothic.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
