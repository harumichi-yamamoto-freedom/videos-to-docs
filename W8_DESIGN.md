=== BEGIN PDF DESIGN ===

# videos-to-docs PDF 書き出し設計

## 1. アーキテクチャ選定

### 推奨: 印刷専用 DOM + print CSS + `window.print()`

デスクトップ版 Chromium 131 以降（Chrome / Edge）を正式な PDF 出力環境とし、選択中の文書を印刷専用 DOM に再レンダリングして、ブラウザの印刷ダイアログから「PDF に保存」する。

画面上のスクロール領域を直接印刷せず、`createPortal(..., window.document.body)` で `<body>` 直下に印刷専用 DOM を置く。現在の詳細パネルには `overflow-hidden` と `overflow-y-auto` があるため、そのまま印刷すると本文がクリップされる可能性がある（`src/components/DocumentDetailPanel.tsx:170-171`, `src/components/DocumentDetailPanel.tsx:227-248`）。

| 方式 | 日本語フォント | PDF の文字 | GFM 表・コード | Vercel 無料枠 | 実装量 |
|---|---|---|---|---|---|
| print CSS + `window.print()` | self-host した Noto Sans JP をブラウザで使用 | 選択・検索可能 | 既存の semantic HTML を再利用 | Function を使用しない | 小 |
| html2canvas + jsPDF | 見た目は取得できるが拡大時に滲む | 原則画像で選択不可 | 長文・表・コードのページ分割が弱い | クライアントだけで成立 | 中 |
| `@react-pdf/renderer` | TTF/WOFF を別途登録 | 選択可能 | Markdown から PDF primitive への再実装が必要 | クライアント生成可能 | 大 |
| サーバ側 headless Chromium | ブラウザと同等 | 選択可能 | HTML/CSS を再利用可能 | 成立するが Chromium の配備・実行コストあり | 中〜大 |
| Paged.js | Web font を利用 | 選択可能 | 高度な組版が可能 | browser 版は成立、CLI は headless browser | 中 |

推奨理由は次のとおり。

- Noto Sans JP を同一オリジンからロードし、`window.document.fonts.ready` 後に印刷すれば、OS ごとの日本語フォールバック差を抑えられる。
- Markdown を canvas に変換しないため、通常の本文、見出し、表、コードは文字として PDF に渡る。Chrome が semantic HTML からタグ付き PDF を生成することを根拠とした推論であり、文字選択・検索は受入試験でも確認する。
- 現行の `ReactMarkdown`、`remark-gfm`、カスタムコンポーネントを共有できる（`src/components/DocumentDetailPanel.tsx:29-86`, `src/components/DocumentDetailPanel.tsx:229-235`）。
- サーバ処理、Chromium バイナリ、PDF ライブラリを追加しないため、Vercel Function の CPU・メモリ・bundle 枠を消費しない。
- `@page`、CSS fragmentation、表ヘッダー、背景、ページ余白ボックスをブラウザの組版エンジンに任せられる。
- 制約は「PDF bytes を直接ダウンロードする API」ではない点である。ボタンは印刷ダイアログを開き、利用者が保存先として PDF を選ぶ。

### 次点 1: サーバ側 headless Chromium

同じ HTML/CSS から、選択可能な PDF をダイアログなしで生成できる。  
ただし Chromium・日本語 font の配備、cold start、認証済み文書の受け渡し、Function の bundle/メモリ/response 制限への対応が増えるため、現要件には過剰。無人生成や厳密な `Content-Disposition` が必須になった場合の昇格候補とする。

### 次点 2: `@react-pdf/renderer`

クライアントで文字選択可能な PDF と font 登録は実現できる。  
一方、HTML/Tailwind は再利用できず、Markdown AST から見出し、GFM 表、コード、引用、改ページを PDF primitive に再実装する必要があるため、Web/PDF の二重保守になる。

html2canvas + jsPDF は、長文を画像として分割するため文字選択、和文の細線、表の行境界、コードブロックのページ境界に不利なので採用しない。Paged.js は高度な脚注、目次、running header が必要になった場合には有効だが、本件では Chromium の native paged media で足りる。

一次資料:

- Native print: [`window.print()` は現在文書の印刷ダイアログを開く](https://developer.mozilla.org/en-US/docs/Web/API/Window/print)。[Chrome 131 から page margin box とページカウンタをサポート](https://developer.chrome.com/blog/print-margins)。[Chrome の「PDF に保存」は semantic HTML からタグ付き PDF を生成する](https://blog.chromium.org/2020/07/using-chrome-to-generate-more.html)。
- Font: [`document.fonts.ready` は font のロードと layout 完了後に resolve する](https://developer.mozilla.org/en-US/docs/Web/API/FontFaceSet/ready)。[`next/font/local` は font を self-host できる](https://nextjs.org/docs/app/getting-started/fonts)。
- html2canvas/jsPDF: [html2canvas は DOM の screenshot 表現であり、理解できる CSS のみ描画する](https://html2canvas.github.io/html2canvas/documentation/)。[jsPDF の `html` 機能は html2canvas を optional dependency とする](https://github.com/parallax/jsPDF#optional-dependencies)。
- React PDF: [`@react-pdf/renderer` は browser/server 用の別 React renderer](https://react-pdf.org/)。[font は TTF/WOFF の登録をサポートする](https://github.com/diegomura/react-pdf-site/blob/master/docs/fonts.md)。
- Headless/Paged.js: [Puppeteer `page.pdf()` は print CSS で PDF を生成する](https://pptr.dev/api/puppeteer.page.pdf)。[Vercel Function の現行制限](https://vercel.com/docs/functions/limitations)。[Paged.js CLI は headless browser を利用する](https://pagedjs.org/en/documentation/2-getting-started-with-paged.js/)。

## 2. 印刷用 CSS の具体仕様

### 日本語 font

現状の Geist / Geist Mono は Latin subset のみで（`src/app/layout.tsx:2-13`）、body は Arial/Helvetica を指定している（`src/app/globals.css:22-25`）。日本語の出力を OS に依存させないため、ライセンスを同梱した Noto Sans JP の完全な日本語 glyph を self-host する。

`src/app/layout.tsx` で `next/font/local` を追加する。

```ts
import localFont from "next/font/local";

const notoSansJP = localFont({
  src: [
    {
      path: "./fonts/NotoSansJP-Regular.woff2",
      weight: "400",
      style: "normal",
    },
    {
      path: "./fonts/NotoSansJP-Bold.woff2",
      weight: "700",
      style: "normal",
    },
  ],
  variable: "--font-noto-sans-jp",
  display: "swap",
  preload: true,
  fallback: ["Hiragino Sans", "Yu Gothic", "Meiryo", "sans-serif"],
  adjustFontFallback: false,
});
```

既存の `<body>` の class に `notoSansJP.variable` を追加する挿入点は `src/app/layout.tsx:26-30`。動的に生成される日本語を欠落させないよう、既知の文書だけから作った固定 subset は使用しない。

印刷開始前に印刷 DOM を一時的にレイアウト対象にし、その後 `await window.document.fonts.ready` を待つ。生成 PDF は `pdffonts output.pdf` で Noto Sans JP が `emb=yes`、可能なら `sub=yes` になっていること、および日本語をコピー・検索できることを受入条件とする。

### `src/app/document-print.css` の仕様

```css
/* Web 表示と印刷で同じ日本語 font stack を使う。 */
.markdown-document,
.pdf-document {
  font-family:
    var(--font-noto-sans-jp, "Noto Sans JP"),
    "Hiragino Sans",
    "Yu Gothic",
    YuGothic,
    Meiryo,
    sans-serif;
}

/* hidden 属性は Tailwind Preflight と競合し得るため使用しない。 */
.pdf-print-root {
  display: none;
}

/* window.print() 前に付与し、off-screen で font/layout を確定する。 */
body.pdf-export-active > .pdf-print-root {
  display: block;
  position: fixed;
  top: 0;
  left: -200vw;
  width: 176mm; /* A4 210mm - 左右余白 17mm × 2 */
  visibility: hidden;
  pointer-events: none;
}

/* 名前付き page にして、通常の画面印刷へ A4 設定を波及させない。 */
@page pdf-document {
  size: A4 portrait;
  margin: 18mm 17mm 20mm;

  /* Chromium 131+。未対応ブラウザは margin box のみ無視する。 */
  @bottom-center {
    content: counter(page) " / " counter(pages);
    font-family: Arial, sans-serif;
    font-size: 8pt;
    line-height: 1;
    color: #6b7280;
  }
}

@media print {
  body.pdf-export-active {
    width: auto !important;
    min-width: 0 !important;
    height: auto !important;
    min-height: 0 !important;
    margin: 0 !important;
    overflow: visible !important;
    background: #ffffff !important;
  }

  /* portal 以外の AppHeader、sidebar、編集 UI をまとめて除外する。 */
  body.pdf-export-active > :not(.pdf-print-root) {
    display: none !important;
  }

  body.pdf-export-active > .pdf-print-root {
    display: block !important;
    position: static !important;
    width: auto !important;
    visibility: visible !important;
    pointer-events: auto !important;
    page: pdf-document;
  }

  .pdf-document {
    color: #111827;
    background: #ffffff;
    font-size: 10.5pt;
    font-weight: 400;
    line-height: 1.75;
    letter-spacing: 0.01em;
    line-break: strict;
    word-break: normal;
    overflow-wrap: break-word;
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }

  .pdf-document *,
  .pdf-document *::before,
  .pdf-document *::after {
    box-sizing: border-box;
  }

  .pdf-document__header {
    margin: 0 0 9mm;
    padding: 0 0 5mm;
    border-bottom: 0.4mm solid #7c3aed;
    break-inside: avoid;
    break-inside: avoid-page;
    break-after: avoid;
    break-after: avoid-page;
    page-break-inside: avoid;
    page-break-after: avoid;
  }

  .pdf-document__title {
    margin: 0 0 3mm;
    color: #111827;
    font-size: 22pt;
    font-weight: 700;
    line-height: 1.35;
    letter-spacing: 0.025em;
    overflow-wrap: anywhere;
  }

  .pdf-document__meta {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 0.8mm 3mm;
    margin: 0;
    color: #6b7280;
    font-size: 8.5pt;
    line-height: 1.55;
  }

  .pdf-document__meta dt {
    font-weight: 700;
  }

  .pdf-document__meta dd {
    min-width: 0;
    margin: 0;
    overflow-wrap: anywhere;
  }

  .pdf-markdown > :first-child {
    margin-top: 0;
  }

  .pdf-markdown > :last-child {
    margin-bottom: 0;
  }

  .pdf-markdown h1,
  .pdf-markdown h2,
  .pdf-markdown h3,
  .pdf-markdown h4,
  .pdf-markdown h5,
  .pdf-markdown h6 {
    color: #111827;
    font-weight: 700;
    break-inside: avoid;
    break-inside: avoid-page;
    break-after: avoid;
    break-after: avoid-page;
    page-break-inside: avoid;
    page-break-after: avoid;
  }

  /* 見出しと直後の段落・表・リストの分離を抑える。 */
  .pdf-markdown :is(h1, h2, h3, h4, h5, h6) + * {
    break-before: avoid;
    break-before: avoid-page;
    page-break-before: avoid;
  }

  .pdf-markdown h1 {
    margin: 10mm 0 4mm;
    padding-bottom: 2mm;
    border-bottom: 0.25mm solid #d1d5db;
    font-size: 18pt;
    line-height: 1.45;
    letter-spacing: 0.035em;
  }

  .pdf-markdown h2 {
    margin: 8mm 0 3mm;
    padding-left: 3mm;
    border-left: 1mm solid #8b5cf6;
    font-size: 14.5pt;
    line-height: 1.5;
    letter-spacing: 0.025em;
  }

  .pdf-markdown h3 {
    margin: 6mm 0 2.5mm;
    font-size: 12pt;
    line-height: 1.55;
    letter-spacing: 0.02em;
  }

  .pdf-markdown h4 {
    margin: 5mm 0 2mm;
    font-size: 10.5pt;
    line-height: 1.6;
  }

  .pdf-markdown h5,
  .pdf-markdown h6 {
    margin: 4mm 0 1.5mm;
    font-size: 9.5pt;
    line-height: 1.6;
  }

  .pdf-markdown p {
    margin: 0 0 3.5mm;
    orphans: 3;
    widows: 3;
  }

  .pdf-markdown ul,
  .pdf-markdown ol {
    margin: 0 0 4mm;
    padding-left: 1.8em;
  }

  .pdf-markdown ul {
    list-style: disc outside;
  }

  .pdf-markdown ol {
    list-style: decimal outside;
  }

  .pdf-markdown ul ul {
    list-style: circle outside;
  }

  .pdf-markdown li {
    margin: 0;
    line-height: 1.72;
    orphans: 2;
    widows: 2;
  }

  .pdf-markdown li + li {
    margin-top: 1.2mm;
  }

  .pdf-markdown li > :last-child {
    margin-bottom: 0;
  }

  .pdf-markdown .contains-task-list {
    padding-left: 0;
    list-style: none;
  }

  .pdf-markdown .task-list-item input[type="checkbox"] {
    margin-right: 1.5mm;
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }

  .pdf-markdown a {
    color: #1d4ed8;
    text-decoration: underline;
    text-underline-offset: 0.12em;
    overflow-wrap: anywhere;
  }

  .pdf-markdown strong {
    color: #111827;
    font-weight: 700;
  }

  .pdf-markdown hr {
    height: 0;
    margin: 7mm 0;
    border: 0;
    border-top: 0.25mm solid #d1d5db;
  }

  /* 表全体はページを跨げる。行は可能な限り分断しない。 */
  .pdf-markdown table {
    width: 100%;
    max-width: 100%;
    margin: 5mm 0;
    border-collapse: collapse;
    border-spacing: 0;
    table-layout: auto;
    color: #111827;
    font-size: 8.7pt;
    line-height: 1.55;
    break-inside: auto;
    page-break-inside: auto;
  }

  .pdf-markdown thead {
    display: table-header-group;
  }

  .pdf-markdown tfoot {
    display: table-footer-group;
  }

  .pdf-markdown tr {
    break-inside: avoid;
    break-inside: avoid-page;
    page-break-inside: avoid;
  }

  .pdf-markdown th,
  .pdf-markdown td {
    padding: 1.8mm 2mm;
    border: 0.25mm solid #d1d5db;
    vertical-align: top;
    text-align: left;
    overflow-wrap: anywhere;
  }

  .pdf-markdown th {
    background: #f3f4f6;
    font-weight: 700;
  }

  .pdf-markdown tbody tr:nth-child(even) td {
    background: #fafafa;
  }

  /* 長いコードはページを跨がせる。 */
  .pdf-markdown pre {
    margin: 4mm 0;
    padding: 3mm;
    overflow: visible;
    border: 0.25mm solid #d1d5db;
    border-radius: 1.5mm;
    background: #f6f8fa;
    color: #1f2937;
    font-family:
      var(--font-geist-mono, "SFMono-Regular"),
      var(--font-noto-sans-jp, "Noto Sans JP"),
      "Yu Gothic",
      Meiryo,
      monospace;
    font-size: 8.3pt;
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    tab-size: 4;
    orphans: 3;
    widows: 3;
    break-inside: auto;
    page-break-inside: auto;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }

  /* 現行 pre/code の二重 padding と背景を除去する。 */
  .pdf-markdown pre > code {
    display: block;
    margin: 0;
    padding: 0;
    overflow: visible;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    white-space: inherit;
  }

  .pdf-markdown :not(pre) > code {
    display: inline;
    padding: 0.2mm 1mm;
    border: 0.2mm solid #e5e7eb;
    border-radius: 0.8mm;
    background: #f3f4f6;
    color: #6d28d9;
    font-family:
      var(--font-geist-mono, "SFMono-Regular"),
      var(--font-noto-sans-jp, "Noto Sans JP"),
      monospace;
    font-size: 0.88em;
    overflow-wrap: anywhere;
  }

  /* 長い引用は分割し、各 fragment の装飾を再描画する。 */
  .pdf-markdown blockquote {
    margin: 5mm 0;
    padding: 2.5mm 3mm 2.5mm 4mm;
    border-left: 1mm solid #a78bfa;
    background: #faf7ff;
    color: #374151;
    font-style: normal;
    orphans: 3;
    widows: 3;
    break-inside: auto;
    page-break-inside: auto;
    box-decoration-break: clone;
    -webkit-box-decoration-break: clone;
  }

  .pdf-markdown blockquote > :last-child {
    margin-bottom: 0;
  }

  .pdf-markdown img,
  .pdf-markdown svg,
  .pdf-markdown figure {
    max-width: 100%;
    height: auto;
    break-inside: avoid;
    break-inside: avoid-page;
    page-break-inside: avoid;
  }
}
```

ページ番号は Chromium 131 以降の progressive enhancement とする。未対応ブラウザでは本文は出力できるが、CSS ページ番号は保証しない。印刷ダイアログのブラウザ標準「ヘッダーとフッター」は重複を避けるため OFF、倍率は 100%、用紙は A4 と案内する。

### Tailwind CSS v4 との統合

`src/app/globals.css:1` の Tailwind import に続けて、すべての通常ルールより前に print CSS を import する。

```css
@import "tailwindcss";
@import "./document-print.css";
```

`@import "tailwindcss"` は Preflight を自動的に base layer へ注入するため、見出し、リスト、margin、border のブラウザ既定値には依存しない。[Tailwind Preflight](https://tailwindcss.com/docs/preflight)

print CSS は Tailwind layer の外側に置き、`.pdf-markdown h1` のように印刷ルートへ scope する。これにより、既存の `text-2xl`、`mt-*`、`bg-gray-100`、`overflow-x-auto` 等（`src/components/DocumentDetailPanel.tsx:29-86`）を印刷時だけ上書きする。

現行の `prose prose-sm`（`src/components/DocumentDetailPanel.tsx:229`）に対応する Typography plugin は依存一覧にない（`package.json:12-38`）ため、PDF の表やタイポグラフィを `prose` に依存させない。`print:` variant は単純な UI 非表示には使えるが、ページ組版は保守性のため `document-print.css` に集約する。

## 3. 統合設計

### UI

PDF ボタンは、選択文書のタイトル・生成情報を表示する詳細ヘッダー（`src/components/DocumentDetailPanel.tsx:172-195`）の右側、既存の表示/編集操作群（`src/components/DocumentDetailPanel.tsx:196-223`）の先頭へ置く。

- ラベルは「PDF に保存」、アイコンは `Download`。
- PDF ボタン自体は `isEditable` の外に置き、読み取り専用表示でも利用可能にする。
- 編集モード中は無効化し、「保存後に PDF 出力できます」と tooltip で示す。PDF は常に保存済みの `document.text` を出力し、未保存の textarea 内容と混在させない。
- 準備中は `isPreparing` で連打を防ぎ、「印刷を準備中…」を表示する。
- 現行 TXT ボタン（`src/components/DocumentListSidebar.tsx:304-312`）は残し、title を「TXT をダウンロード」に変更して形式を区別する。現行 TXT 生成処理は `src/components/DocumentListSidebar.tsx:62-74`。

### データの流れ

1. Firestore では本文を `transcription`、生成日時を `serverTimestamp()` として保存している（`src/lib/firestore.ts:77-89`）。
2. `getTranscriptions()` が Firestore を取得し（`src/lib/firestore.ts:185-210`）、`data.transcription` を `Transcription.text` に写像する（`src/lib/firestore.ts:223-233`）。
3. sidebar が一覧を読み込み（`src/components/DocumentListSidebar.tsx:28-48`）、クリックした文書を親へ渡す（`src/components/DocumentListSidebar.tsx:234-237`）。
4. documents page が `selectedDocument` に保持し（`src/app/(dashboard)/documents/page.tsx:8-14`）、詳細パネルへ渡す（`src/app/(dashboard)/documents/page.tsx:44-50`）。
5. 画面と印刷専用 DOM の両方が、共通 `MarkdownDocument` を通して `ReactMarkdown + remark-gfm` で semantic HTML に変換する。現行の描画箇所は `src/components/DocumentDetailPanel.tsx:229-235`。
6. PDF ボタンが body class を付け、印刷 DOM を off-screen で layout し、font 完了後に `window.print()` を呼ぶ。利用者が印刷ダイアログで「PDF に保存」を選択する。
7. `afterprint` または `window.print()` の復帰時に body class、準備状態、一時的な `window.document.title` を必ず復元する。

新しいサーバ route や Firestore 再取得は行わず、既に認可・取得済みの `selectedDocument` だけを使用する。

### ファイル名とメタデータ

`Transcription` には `title`、`fileName`、`promptName`、`createdAt: Timestamp | Date` がある（`src/lib/firestore.ts:41-48`）。

印刷本文の先頭には次を semantic HTML として出力する。

```html
<header class="pdf-document__header">
  <h1 class="pdf-document__title">文書タイトル</h1>
  <dl class="pdf-document__meta">
    <dt>生成日時</dt><dd>2026年9月1日 14:30</dd>
    <dt>元ファイル</dt><dd>meeting.mp4</dd>
    <dt>プロンプト</dt><dd>議事録</dd>
  </dl>
</header>
```

- `createdAt` は Firestore Timestamp の `toDate()` または `Date` を受け、`Asia/Tokyo`、`ja-JP` で表示する。
- 推奨ファイル名は `{sanitizedTitle}_{yyyyMMdd-HHmm}.pdf`。時刻は文書生成日時を使い、PDF 出力日時とは混同しない。
- sanitize は NFC 正規化、制御文字と `[<>:"/\\|?*]` の `_` 置換、連続空白の整理、末尾の空白・ピリオド除去、Windows 予約名回避、最大 100 Unicode code point、空なら `document` とする。
- `window.print()` はファイル名を指定できないため、印刷直前に `window.document.title` を拡張子なしの推奨 stem へ一時変更する。これは保存名の候補であり強制ではない。
- PDF 内部の Title はブラウザが `document.title` から設定する可能性があるが保証対象にしない。本文ヘッダーのタイトル・生成日時を正本とし、PDF の CreationDate は出力時刻としてブラウザに任せる。

## 4. 実装手順と落とし穴

### 新規ファイル

- `src/components/MarkdownDocument.tsx`
  - 現在ローカル定義されている `markdownComponents`（`src/components/DocumentDetailPanel.tsx:29-86`）と `ReactMarkdown` 呼び出しを共有化する。
  - `export type MarkdownDocumentProps = { markdown: string; className?: string }`
  - `export function MarkdownDocument(props: MarkdownDocumentProps): React.ReactElement`
  - inline code と fenced code は最終 DOM の `:not(pre) > code` / `pre > code` で区別できる構造を保つ。

- `src/components/DocumentPrintPortal.tsx`
  - mounted 後、`createPortal()` で `<body>` 直下へ `.pdf-print-root` を配置する。
  - `export type DocumentPrintPortalProps = { document: Transcription }`
  - `export function DocumentPrintPortal(props: DocumentPrintPortalProps): React.ReactPortal | null`
  - `<article class="pdf-document">`、メタデータヘッダー、`<MarkdownDocument className="pdf-markdown">` を出力する。

- `src/hooks/useDocumentPrint.ts`
  - `export function useDocumentPrint(document: Transcription | null): { printPdf: () => Promise<void>; isPreparing: boolean }`
  - body class、font 待機、二重 `requestAnimationFrame`、`window.print()`、`afterprint`、title 復元を管理する。
  - props 名の `document` と DOM global が衝突するため、DOM 参照は `window.document` と明記する。

- `src/lib/pdfExport.ts`
  - `export type DateLike = Date | { toDate(): Date }`
  - `export function dateLikeToDate(value: DateLike): Date`
  - `export function sanitizeFileStem(value: string): string`
  - `export function buildPdfFileStem(document: Pick<Transcription, "title" | "createdAt">): string`
  - 表示用日時とファイル名用日時を決定的に生成する。

- `src/app/document-print.css`
  - 前節の named `@page`、font、fragmentation、表、code、blockquote、print-only DOM 制御を担当する。

- `src/app/fonts/NotoSansJP-Regular.woff2`
- `src/app/fonts/NotoSansJP-Bold.woff2`
- `src/app/fonts/OFL.txt`
  - 完全な日本語 glyph と font ライセンスを保持する。

- `src/lib/pdfExport.test.ts`
  - 禁止文字、絵文字、結合文字、Windows 予約名、空タイトル、長いタイトル、Timestamp/Date、Asia/Tokyo の日付境界をテストする。

### 変更ファイル

- `src/components/DocumentDetailPanel.tsx`
  - ローカル `markdownComponents` を `MarkdownDocument` に置換する。
  - `src/components/DocumentDetailPanel.tsx:196-223` の操作領域へ PDF ボタンを追加する。
  - `DocumentPrintPortal` と `useDocumentPrint` を接続する。

- `src/app/globals.css`
  - `src/app/globals.css:1` の直後に `@import "./document-print.css";` を追加する。

- `src/app/layout.tsx`
  - `next/font/local` の Noto Sans JP を定義し、`src/app/layout.tsx:27-29` の body class に CSS variable を追加する。

- `src/components/DocumentListSidebar.tsx`
  - `src/components/DocumentListSidebar.tsx:304-312` の既存 Download button を「TXT」と明示する。PDF 生成ロジックは重複させない。

- `src/lib/firestore.ts`
  - 現在、保存・取得は `transcription` を使う一方（`src/lib/firestore.ts:77-88`, `src/lib/firestore.ts:226-233`）、本文更新だけ `text` を書いている（`src/lib/firestore.ts:297-303`）。
  - canonical field を `transcription` に統一し、読み取りは移行互換のため `data.transcription ?? data.text ?? ""` とする。

追加の PDF npm dependency は不要。

### 実装順

1. Firestore 本文 field の不整合を修正し、再読み込み後も編集済み Markdown が維持されることを確認する。
2. `MarkdownDocument` を抽出し、画面表示が変更前と同じであることを確認する。
3. Noto Sans JP とライセンスを追加し、Web 画面で日本語 font が適用されることを確認する。
4. print portal、named `@page`、印刷 CSS を実装する。
5. 詳細ヘッダーへ PDF ボタンと print lifecycle hook を統合する。
6. `next build`、lint、utility test を実行する。
7. 短文、複数ページの日本語、見出し直後、長い箇条書き、複数ページ表、長い code、長い blockquote、URL、絵文字を含む fixture で Chrome/Edge の PDF を確認する。
8. `pdffonts`、文字選択、コピー、検索、リンク、ページ番号、表ヘッダー反復、キャンセル後の画面復元を受入確認する。

### 既知の落とし穴

1. **Firestore 本文 field の不整合**  
   現状のままでは編集直後の画面では新本文でも、再取得後に古い `transcription` が戻り、PDF が古くなる可能性がある。PDF 実装と同時に canonical field を修正する。

2. **font のロード・埋め込み漏れ**  
   `display:none` の print DOM は font load を開始しない場合がある。off-screen で layout を強制してから `window.document.fonts.ready` を待ち、`pdffonts` とコピー試験で検証する。

3. **スクロール領域と一ページを超える要素**  
   現行の `overflow-hidden` / `overflow-y-auto` を印刷せず、body portal を使う。表全体、長い code、長い blockquote へ一律 `break-inside: avoid` を付けると、押し出しや欠落を起こすため分割可能にする。

4. **背景色が消える**  
   `print-color-adjust: exact` は要求にすぎず、利用者の印刷設定が優先される。コード・表・引用は背景色だけに依存せず border と文字コントラストでも区別する。[MDN](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/print-color-adjust)

5. **native print の制御範囲**  
   保存名、保存先、ブラウザ標準ヘッダー、PDF 内部 metadata は強制できない。CSS ページ番号は Chromium 131+ を保証範囲とし、他ブラウザではページ番号なしの graceful degradation とする。

=== END PDF DESIGN ===