/**
 * 描画結果の aria 参照が実在する id を指しているかを調べる。
 * 参照先が無い aria-controls は支援技術から見ると壊れたリンクで、
 * 「属性が付いている」ことだけを見る錠では捕まらない。
 */
export function danglingAriaReferences(html: string): string[] {
    const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map(match => match[1]));
    return [...html.matchAll(/ aria-(?:controls|labelledby|describedby|owns)="([^"]+)"/g)]
        .flatMap(match => match[1].split(/\s+/))
        .filter(id => id.length > 0 && !ids.has(id));
}

/** 参照が 1 本も無いと「全部実在した」と誤読するため、本数も返す。 */
export function ariaReferenceCount(html: string): number {
    return [...html.matchAll(/ aria-(?:controls|labelledby|describedby|owns)="([^"]+)"/g)]
        .flatMap(match => match[1].split(/\s+/))
        .filter(id => id.length > 0).length;
}
