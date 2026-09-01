import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * X5 レーンが所有するソースの名簿。
 * 手書きの固定リストにすると、新しく足した部品が検査の外へ落ちて素通りする。
 * ディレクトリ丸ごと所有している場所は走査で拾い、個別所有だけを列挙する。
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

/** 中身すべてを所有するディレクトリ（新規部品は自動で検査対象になる）。 */
const OWNED_DIRECTORIES = ['components/ui'];

/** 個別に所有しているファイル。 */
const OWNED_FILES = [
    'components/AppHeader.tsx',
    'components/AppShell.tsx',
    'components/NotificationBanner.tsx',
    'app/admin/page.tsx',
    'app/admin/layout.tsx',
    'app/(dashboard)/team/page.tsx',
    'app/(dashboard)/layout.tsx',
];

const isSource = (name: string) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name);

/** 所有ソースの相対パス一覧（src からの相対）。 */
export function ownedSourceFiles(): string[] {
    const fromDirectories = OWNED_DIRECTORIES.flatMap(directory =>
        readdirSync(join(SRC, directory), { withFileTypes: true })
            .filter(entry => entry.isFile() && isSource(entry.name))
            .map(entry => `${directory}/${entry.name}`),
    );
    return [...fromDirectories, ...OWNED_FILES].sort();
}

/** 名簿に載っているのに実在しないファイル（改名を黙って見逃さないため）。 */
export function missingOwnedFiles(): string[] {
    return OWNED_FILES.filter(relative => !existsSync(join(SRC, relative)));
}

export function readOwnedFile(relative: string): string {
    return readFileSync(join(SRC, relative), 'utf8');
}

export const OWNED_SOURCE_ROOT = SRC;
