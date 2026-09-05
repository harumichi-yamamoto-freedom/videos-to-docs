/**
 * 裁定(Y13): UI 本文に Web フォント(next/font/google の Noto Sans JP)を採用する。
 * lead 承認済みの設計判断として、費用と根拠をここに残す。
 *
 * 狙い: 和文を OS 任せにしない。従来の Arial 始まりのスタックでは、和文の字面と
 *   字重が Windows / macOS / Android で割れ、字間と行の見え方が環境ごとに変わる。
 *
 * 費用(ビルド成果物の実測): woff2 124 本 / 4.98MB。ただし unicode-range で分割
 *   されており、閲覧者が実際に取得するのは表示に必要なチャンクだけ。
 *   400/500/700 の 3 ウェイトは同一ファイルを指す(font-weight 記述子だけが違う)
 *   ため、ウェイトを増やしてもバイトは増えず @font-face 宣言だけが増える。
 *
 * CLS: next/font が生成する "Noto Sans JP Fallback"(src:local(Arial),
 *   ascent-override 110.73%, descent-override 27.49%, size-adjust 104.76%)が
 *   metrics を合わせるため、差し替え時にレイアウトはずれない。
 *
 * preload: しない。Noto Sans JP の subsets に "japanese" は存在せず
 *   (cyrillic/latin/latin-ext/vietnamese のみ)、和文チャンクは原理的に preload
 *   対象にできない。preload:true でビルドして実測したところ、preload されるのは
 *   ラテン記号だけを含む 1 ファイルで、漢字も仮名も 1 文字も含まれなかった。
 *
 * 残る費用: 差し替え時のちらつき(FOUT)。display:swap で本文を先に見せる方を採る。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ownedSourceFiles, readOwnedFile } from '@/testUtils/ownedFiles';

const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const globalsCss = read('./globals.css');
const rootLayout = read('./layout.tsx');

/** body 規則だけを切り出す（@theme 側の宣言と取り違えないため）。 */
const bodyRule = /\nbody \{([\s\S]*?)\n\}/.exec(globalsCss)?.[1] ?? '';
const themeBlock = /@theme inline \{([\s\S]*?)\n\}/.exec(globalsCss)?.[1] ?? '';

describe('UI 本文フォント (E1)', () => {
    it('body の font-family が Arial ではなく Noto Sans JP 系から始まる', () => {
        expect(bodyRule).not.toBe('');
        const fontFamily = /font-family:([\s\S]*?);/.exec(bodyRule)?.[1] ?? '';
        expect(fontFamily.trim().startsWith('var(--font-ui)')).toBe(true);
        expect(fontFamily.trim().startsWith('Arial')).toBe(false);
    });

    it('--font-sans と body の font-family が同じ先頭を指す', () => {
        const sans = /--font-sans:([\s\S]*?);/.exec(themeBlock)?.[1] ?? '';
        expect(sans.trim().startsWith('var(--font-ui)')).toBe(true);
    });

    it('UI フォントは next/font/google の Noto Sans JP を --font-ui として読み込む', () => {
        expect(rootLayout).toContain('Noto_Sans_JP');
        expect(rootLayout).toMatch(/from "next\/font\/google"/);
        const uiFontCall = /const uiFont = Noto_Sans_JP\(\{([\s\S]*?)\}\);/.exec(rootLayout)?.[1] ?? '';
        expect(uiFontCall).not.toBe('');
        expect(uiFontCall).toContain('"--font-ui"');
        for (const weight of ['400', '500', '700']) {
            expect(uiFontCall, weight).toContain(`"${weight}"`);
        }
    });

    it('--font-ui の CSS 変数が body class として実際に注入されている', () => {
        expect(rootLayout).toContain('${uiFont.variable}');
    });
});

describe('PDF 用ローカルフォントを壊していない (E1 の禁止事項)', () => {
    it('印刷経路の埋め込み用 local Noto はフルファイル参照のまま残る', () => {
        expect(rootLayout).toContain('--font-noto-sans-jp');
        expect(rootLayout).toContain('./fonts/NotoSansJP-Regular.otf');
        expect(rootLayout).toContain('./fonts/NotoSansJP-Bold.otf');
        expect(rootLayout).toContain('localFont');
    });

    it('UI フォントと PDF フォントは別の CSS 変数である', () => {
        expect(rootLayout).toContain('variable: "--font-ui"');
        expect(rootLayout).toContain('variable: "--font-noto-sans-jp"');
    });
});

describe('意味トークン (E2)', () => {
    const REQUIRED_TOKENS = [
        '--color-muted',
        '--color-brand',
        '--color-action',
        '--color-action-hover',
        '--color-action-foreground',
        '--color-selection',
        '--color-selection-boundary',
        '--color-status-warning',
        '--color-status-danger',
        '--color-status-info',
        // elevation 3 段: 常設(境界+弱い影) / 選択(--color-selection-boundary) / オーバーレイ(強い影)
        '--color-elevation-persistent-boundary',
        '--shadow-elevation-persistent',
        '--shadow-elevation-overlay',
    ];

    it('色役割と elevation 3 段が @theme に定義されている', () => {
        for (const token of REQUIRED_TOKENS) {
            expect(themeBlock, token).toContain(token);
        }
    });

    it('REQUIRED_TOKENS が実参照と同期している（定義だけの錠にしない）', () => {
        // 🔴 referencedTokenIds() は src 配下を全走査するため、ソース増で遅くなる。
        //    既定 5000ms は全体実行時の負荷で超えることがある（単体では約 100ms）。余裕を持たせる。
        for (const token of REQUIRED_TOKENS) {
            expect(referencedTokenIds(), token).toContain(token.replace(/^--/, ''));
        }
    }, 20_000);

    it('@theme に未参照のトークンを残さない', () => {
        // 使われないトークンは「定義されている」錠だけを緑にして実物を守らない。
        // 許可リストは理由つきでのみ増やすこと。
        const ALLOWED_UNREFERENCED = new Map([
            // Next.js の初期テンプレ由来。body は素の --background/--foreground を参照しており、
            // bg-background/text-foreground を他レーンが使い得るため削除しない。
            ['color-background', 'Next テンプレ既定・他レーンが利用し得る'],
            ['color-foreground', 'Next テンプレ既定・他レーンが利用し得る'],
            // Tailwind 組み込みのテーマキー。font-sans ユーティリティと
            // --default-font-family を通じて preflight の html 規則へ流れる、
            // 自前トークンではなくフレームワーク所有の名前なので未参照でも残す。
            // 注意: html 側は現状ぶら下がりで、和文を支えているのは body の自前宣言。
            // 詳細は下の「html 側の font-family」の錠を参照。
            ['font-sans', 'Tailwind 組み込みのテーマキー（body 側の宣言と同一に保つ）'],
        ]);

        const referenced = new Set(referencedTokenIds());
        const dead = definedTokens()
            .map(token => token.id)
            .filter(id => !referenced.has(id) && !ALLOWED_UNREFERENCED.has(id));
        expect(dead, `未参照トークン: ${dead.join(', ')}`).toEqual([]);
    });

    it('陰性統制: 参照走査が架空のトークンを参照済みと言わない', () => {
        // 定義を消したトークン。走査が名前だけで緩く一致していれば、ここが緑に落ちる。
        expect(referencedTokenIds()).not.toContain('color-status-success');
        expect(referencedTokenIds()).not.toContain('color-elevation-selected-boundary');
        expect(referencedTokenIds()).not.toContain('color-selection-hover');
    });

    it('CTA の既定色は blue-500 相当ではなく blue-700/800 系である', () => {
        const action = /--color-action:\s*([^;]+);/.exec(themeBlock)?.[1]?.trim();
        expect(action).toBe('#1d4ed8');
        const hover = /--color-action-hover:\s*([^;]+);/.exec(themeBlock)?.[1]?.trim();
        expect(hover).toBe('#1e40af');
    });

    it('本文の muted 色は白地 7:1 (AAA) を満たす', () => {
        const muted = /--color-muted:\s*([^;]+);/.exec(themeBlock)?.[1]?.trim() ?? '';
        expect(contrastWithWhite(muted)).toBeGreaterThanOrEqual(7);
    });

    it('白文字を載せる action / badge は 4.5:1 (AA) を満たす', () => {
        for (const token of ['--color-action', '--color-action-hover', '--color-badge', '--color-status-danger']) {
            const value = new RegExp(`${token}:\\s*([^;]+);`).exec(themeBlock)?.[1]?.trim() ?? '';
            expect(contrastWithWhite(value), `${token} ${value}`).toBeGreaterThanOrEqual(4.5);
        }
    });

    it('コントラスト計算そのものが低コントラスト色を落とす（陰性統制）', () => {
        // 置換前の CTA。白文字で 3.76:1 しかなく AA を満たさない。
        expect(contrastWithWhite('#3b82f6')).toBeLessThan(4.5);
        expect(contrastWithWhite('#9ca3af')).toBeLessThan(4.5);
    });
});

const UTILITY_PREFIXES = [
    'bg', 'text', 'border', 'ring', 'shadow', 'from', 'to', 'via',
    'outline', 'fill', 'stroke', 'divide', 'accent', 'caret', 'placeholder',
    'font', 'decoration',
];

/** src 配下の全ソース（globals.css 自身は除く）。 */
function sourceCorpus(): string {
    const root = fileURLToPath(new URL('..', import.meta.url));
    let corpus = '';
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (/\.(tsx?|css)$/.test(entry.name) && !full.endsWith(join('app', 'globals.css'))) {
                corpus += readFileSync(full, 'utf8') + '\n';
            }
        }
    };
    walk(root);
    return corpus;
}

interface ThemeToken {
    /** color / shadow / font */
    kind: string;
    /** 接頭辞を除いた名前。ユーティリティ名の突き合わせに使う。 */
    name: string;
    /** kind まで含めた一意な識別子。許可リストの鍵に使う。 */
    id: string;
}

function definedTokens(): ThemeToken[] {
    return [...themeBlock.matchAll(/^\s*--(color|shadow|font)-([a-z0-9-]+):/gm)].map(m => ({
        kind: m[1],
        name: m[2],
        id: `${m[1]}-${m[2]}`,
    }));
}

/**
 * ソースに現れる「クラスらしき語」を集めてから突き合わせる。
 * 正規表現で当てにいくと bg-surface と bg-surface-subtle を取り違える。
 */
function referencedTokens(): ThemeToken[] {
    const corpus = sourceCorpus();
    const words = new Set(corpus.split(/[^A-Za-z0-9:_[\]/.-]+/));
    const bare = new Set([...words].map(word => word.replace(/^(?:[a-z-]+:)+/, '')));
    return definedTokens().filter(token => {
        if (UTILITY_PREFIXES.some(prefix => bare.has(`${prefix}-${token.name}`))) return true;
        return new RegExp(`var\\(--${token.kind}-${token.name}\\)`).test(corpus);
    });
}

const referencedTokenIds = () => referencedTokens().map(token => token.id);

describe('html 側の font-family (P5 の所見)', () => {
    /*
     * 実測: --font-ui は next/font が出すクラス(.noto_sans_jp_…__variable)でのみ定義され、
     * そのクラスは <body> に付く。一方 Tailwind preflight は
     *   html,:host { font-family: var(--default-font-family, …) }
     * を出し、--default-font-family は :root で --font-sans の値(= var(--font-ui) 始まり)へ
     * 展開される。つまり html の階層では var(--font-ui) が未定義で、この宣言は
     * guaranteed-invalid となり計算値時に無効。html には効いていない。
     * 和文を実際に支えているのは body 側の自前 font-family 宣言のほうである。
     *
     * 所見: 直すなら next/font の variable クラスを <body> ではなく <html> に付けるのが筋で、
     * そうすれば html と body の両方が解決し、body の重複宣言も不要になる。
     * ただし E1 のフォント配線そのものに触れるため、凍結後の別便で扱うのが適切。
     */
    it('和文は body の自前宣言で支えられている（html 頼みではない）', () => {
        expect(bodyRule).toContain('font-family');
        expect(rootLayout).toMatch(/<body[\s\S]*?\$\{uiFont\.variable\}/);
    });

    it('--font-ui を注入するクラスは html ではなく body に付いている', () => {
        const htmlTag = /<html[^>]*>/.exec(rootLayout)?.[0] ?? '';
        expect(htmlTag).not.toBe('');
        expect(htmlTag).not.toContain('uiFont.variable');
    });
});

describe('読み込み済みウェイトだけを使う (Y9)', () => {
    // 400/500/700 のみ読み込んでいる。font-semibold(600) は最近傍の 700 へ解決されるため
    // 見た目は同じだが、指定と実体がずれたままになる。
    // 対象ファイルは走査で決める(手書き名簿だと新規部品が検査の外に落ちる)。
    const LOADED = new Set(['font-normal', 'font-medium', 'font-bold']);

    it.each(ownedSourceFiles())('%s の font-weight 指定が 400/500/700 に収まっている', file => {
        const used = [...readOwnedFile(file).matchAll(
            /\bfont-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/g,
        )].map(match => match[0]);
        const unloaded = [...new Set(used)].filter(cls => !LOADED.has(cls));
        expect(unloaded, `${file}: ${unloaded.join(', ')}`).toEqual([]);
    });

    it('陰性統制: 未読み込みウェイトの検出器が反応する', () => {
        const sample = 'text-sm font-semibold text-muted';
        const used = [...sample.matchAll(/\bfont-(thin|extralight|light|normal|medium|semibold|bold|extrabold|black)\b/g)]
            .map(match => match[0]);
        expect(used.filter(cls => !LOADED.has(cls))).toEqual(['font-semibold']);
    });

    it('読み込むウェイトの宣言と一致している', () => {
        const uiFontCall = /const uiFont = Noto_Sans_JP\(\{([\s\S]*?)\}\);/.exec(rootLayout)?.[1] ?? '';
        expect(uiFontCall).toContain('"400"');
        expect(uiFontCall).toContain('"500"');
        expect(uiFontCall).toContain('"700"');
        expect(uiFontCall).not.toContain('"600"');
    });
});

function relativeLuminance(hex: string): number {
    const value = hex.replace('#', '');
    const channels = [0, 2, 4].map(offset => parseInt(value.slice(offset, offset + 2), 16) / 255);
    const [r, g, b] = channels.map(channel =>
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastWithWhite(hex: string): number {
    return 1.05 / (relativeLuminance(hex) + 0.05);
}
