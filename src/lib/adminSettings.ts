/**
 * 管理者設定
 */

import { db } from './firebase';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';

export interface DefaultPromptTemplate {
    name: string;
    content: string;
}

export interface AdminSettings {
    maxPromptSize: number; // バイト単位
    maxDocumentSize: number; // バイト単位
    rateLimit: {
        promptsPerHour: number;
        documentsPerHour: number;
    };
    defaultPrompts?: DefaultPromptTemplate[];
    updatedAt?: Date;
    updatedBy?: string;
}

/**
 * 初期デフォルトプロンプト一覧
 */
export const INITIAL_DEFAULT_PROMPTS: DefaultPromptTemplate[] = [
    {
        name: '打ち合わせの流れ',
        content: `@ 命令書:
あなたは30年以上の経験を持つ編集者です。以下の#制約条件 に従って、文字起こしデータをもとに打ち合わせの話の流れをわかりやすくリスト形式の箇条書きマークダウンで出力してください。
@ 制約条件:
- 入力は長文の文字起こしデータです。
- 出力形式は以下の#出力形式に厳密に従ってください。
- 話の流れを正確に把握できるようにしてください。
@ 出力形式:
## 打ち合わせの話の流れ
- トピック1:
  - ポイント1
  - ポイント2
- トピック2:
  - ポイント1
  - ポイント2
...
あなたは文章修正のスペシャリストです。
入力された資料が正しい書式になるように、修正してください。

@ 出力形式:
## 打ち合わせの流れ
- トピック1:
  - ポイント1
  - ポイント2
- トピック2:
  - ポイント1
  - ポイント2
...

出力は正しく作成された資料のみを表示し、その他の説明や追加情報は不要です`,
    },
    {
        name: '希望条件',
        content: `あなたは世界最高のコンサルタントとして、打ち合わせのトランスクリプトから重複なく、漏れなく情報を収集し、顧客の希望条件をまとめてください。
利用者は住宅・不動産業界のプロフェッショナルです。その為ディティールにこだわって最高のアウトプットを作成する必要があります。
書式はマークダウン形式で出力してください。`,
    },
    {
        name: 'お客様情報',
        content: `お客様情報を一覧で出力して`,
    },
    {
        name: 'ヒヤッとアラートサンプル',
        content: `あなたは「ヒヤッとアラート」を担当する、注文住宅の商談解析AIです。
入力として与えられる商談文字起こし（顧客×営業・設計士の会話）を読解し、
"商談がうまくいっていない兆候"が十分に強い場合のみ、簡潔なアラートを報告します。
デフォルトは「問題なし」を返し、全体の約1割程度のみアラートを点灯させます（高しきい値運用）。

――――
【目的】
- 顧客の不安・不信・不満・温度低下・誤解・緊張などの"明確で持続的"な悪化兆候を検出。
- 単発のネガティブ発言ではなく、文脈としての"関係性の悪化"を重視。
- 誤検知を避け、基本は「問題なし」。強い根拠が複数揃ったときのみ点灯。

――――
【入力前提】
- 話者ラベルは区別されている（例：顧客／営業／設計士）。
- 句読点や言い淀み、相づちは原文のままで可。
- 誤変換が疑われる箇所は文脈で補正しつつ、確信が持てない場合は判断材料に過度に用いない。

――――
【評価ポリシー（発火率 ≈1割を目安にするための高しきい値）】
1) 以下の"複合的根拠"が2つ以上、かつ会話の"複数ターンに継続"して見られる場合にのみアラート。
   - 顧客の"購買温度の明確低下"の言明（例：「一旦白紙」「他社にします」）
   - 不信・期待不一致の指摘（例：「前と違う」「説明されていない」「約束と違う」）
   - 価格・仕様・工期など"決定要素"への強い懸念が解消されず累積
   - 営業/設計士の"共感不足・遮断・論点ずらし・押し付け"が反復
   - 会話テンポの崩れ（顧客の反応が短い、返答遅延が顕著、打ち切りムード）
2) 次の単発事象は"原則アラートにしない"（誤検知抑制ルール）
   - 「検討します」「家族と相談します」等の一般的保留の一回限り
   - 軽い価格反応（「高いですね」）が即座に説明/代替案で解消されたケース
   - 情報不足が速やかに補われ、顧客の納得が回復したケース
3) 迷ったら「問題なし」。アラートを出す際は"どの根拠が、どの発話で、どれだけ継続したか"を明示。

――――
【判定ラベル】
- 問題なし：特段の悪化兆候なし、もしくは軽微で解消済み。
- ヒヤッと注意：悪化の"兆候"が複数回見える。要フォロー（次回の打ち手提示）。
- ヒヤッと強：購買意欲の"明確低下"や"不信の固定化"が読み取れる。至急リカバリ。

※ デフォルトは必ず「問題なし」。強い根拠が揃った時のみ「ヒヤッと注意／強」を使用。

――――
【出力スタイル（非JSON、簡潔）】
- 3～7行で要点のみ。見出し→根拠→対応の順に箇条書き。
- 特定の発話は【引用】して"誰の発言か"がわかるように抜粋（1～2箇所まで）。
- 断定しすぎず、実務で即使える"次の一手"を具体化。

――――
【出力フォーマット（そのまま貼る）】
＜結論＞：問題なし｜ヒヤッと注意｜ヒヤッと強
・根拠（要約）：（悪化兆候がある場合のみ。無ければ書かない）
・該当抜粋：顧客/営業 の【重要フレーズ】（最大2つ）
・推定状況：温度感/信頼/意思決定の足枷 などの短い要約
・次の一手：具体策（例：代替案○/可視化△/費用内訳の再提示/宿題→次回冒頭で回答）
・備考（任意）：判断の不確実性や追加確認事項

――――
【出力例（1：発火しない想定＝既定運用）】
＜結論＞：問題なし
・推定状況：価格の初期反応はあったが、仕様見直し提案で納得に回復
・次の一手：次回は"比較表（標準/代替/削減案）"を1ページで提示し再確認

【出力例（2：中程度の兆候が持続）】
＜結論＞：ヒヤッと注意
・根拠（要約）：価格と工期への懸念が2回継続、代替案が曖昧で納得に至らず
・該当抜粋：顧客の【「一旦持ち帰らせてください」】／営業の【「後で確認します」だけで終了】
・推定状況：意思決定の足枷が残存（価格・工期）
・次の一手：価格の内訳再提示＋工期のクリティカルパス可視化；"決め所"を合意して次回日程を確定

【出力例（3：強い悪化の固定化）】
＜結論＞：ヒヤッと強
・根拠（要約）：説明不一致が繰り返され、不信が固定化
・該当抜粋：顧客の【「前回と話が違います」】／営業の【「その件は…」と話題転換】
・推定状況：信頼低下＋解消見通し不明
・次の一手：責任者同席で事実関係を整理・謝意表明・補償/代替条件の提示。場を改め短時間で合意形成

――――
【トーンと禁止事項】
- 冷静・簡潔・報告書調。誇張・断定・感情的表現（「最悪」等）は禁止。
- 憶測は避け、必ず"会話上の根拠（抜粋）"に紐づける。
- 守秘に配慮し、個人を特定できる情報や不要な評価語は書かない。
`,
    },
];

const DEFAULT_SETTINGS: AdminSettings = {
    maxPromptSize: 50000, // 50KB
    maxDocumentSize: 500000, // 500KB
    rateLimit: {
        promptsPerHour: 100,
        documentsPerHour: 50,
    },
    defaultPrompts: INITIAL_DEFAULT_PROMPTS,
};

/**
 * 管理者設定を取得
 * 設定が存在しない場合、デフォルト設定を自動的に保存する（初回マイグレーション）
 */
export async function getAdminSettings(): Promise<AdminSettings> {
    try {
        const docRef = doc(db, 'adminSettings', 'config');
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            const data = docSnap.data() as AdminSettings;

            // デフォルトプロンプトが未設定の場合、初期値を設定
            if (!data.defaultPrompts) {
                console.log('デフォルトプロンプトが未設定のため、初期値を設定します...');
                await setDoc(
                    docRef,
                    {
                        defaultPrompts: INITIAL_DEFAULT_PROMPTS,
                        updatedAt: serverTimestamp(),
                    },
                    { merge: true }
                );
                data.defaultPrompts = INITIAL_DEFAULT_PROMPTS;
            }

            return data;
        }

        // 設定が存在しない場合、デフォルト設定を保存
        console.log('管理者設定が存在しないため、初期設定を作成します...');
        await setDoc(docRef, {
            ...DEFAULT_SETTINGS,
            updatedAt: serverTimestamp(),
        });

        return DEFAULT_SETTINGS;
    } catch (error) {
        console.error('管理者設定取得エラー:', error);
        return DEFAULT_SETTINGS;
    }
}

/**
 * 管理者設定を更新（管理者のみ）
 */
export async function updateAdminSettings(
    settings: Partial<AdminSettings>,
    updatedBy: string
): Promise<void> {
    try {
        const docRef = doc(db, 'adminSettings', 'config');
        await setDoc(
            docRef,
            {
                ...settings,
                updatedAt: serverTimestamp(),
                updatedBy,
            },
            { merge: true }
        );
    } catch (error) {
        console.error('管理者設定更新エラー:', error);
        throw new Error('管理者設定の更新に失敗しました');
    }
}

/**
 * プロンプトのサイズをチェック
 */
export async function validatePromptSize(content: string): Promise<{ valid: boolean; size: number; maxSize: number }> {
    const size = new Blob([content]).size;
    const settings = await getAdminSettings();

    return {
        valid: size <= settings.maxPromptSize,
        size,
        maxSize: settings.maxPromptSize,
    };
}

/**
 * 文書のサイズをチェック
 */
export async function validateDocumentSize(content: string): Promise<{ valid: boolean; size: number; maxSize: number }> {
    const size = new Blob([content]).size;
    const settings = await getAdminSettings();

    return {
        valid: size <= settings.maxDocumentSize,
        size,
        maxSize: settings.maxDocumentSize,
    };
}

/**
 * デフォルトプロンプトテンプレートを取得
 */
export async function getDefaultPrompts(): Promise<DefaultPromptTemplate[]> {
    try {
        const settings = await getAdminSettings();
        return settings.defaultPrompts || INITIAL_DEFAULT_PROMPTS;
    } catch (error) {
        console.error('デフォルトプロンプト取得エラー:', error);
        return INITIAL_DEFAULT_PROMPTS;
    }
}

/**
 * デフォルトプロンプトテンプレートを更新（管理者のみ）
 * ゲストユーザーのデフォルトプロンプトも同期更新する
 */
export async function updateDefaultPrompts(
    prompts: DefaultPromptTemplate[],
    updatedBy: string
): Promise<void> {
    try {
        const docRef = doc(db, 'adminSettings', 'config');
        await setDoc(
            docRef,
            {
                defaultPrompts: prompts,
                updatedAt: serverTimestamp(),
                updatedBy,
            },
            { merge: true }
        );

        // ゲストユーザーのデフォルトプロンプトを同期更新
        try {
            const { syncGuestDefaultPrompts } = await import('./prompts');
            await syncGuestDefaultPrompts();
        } catch (syncError) {
            console.error('ゲストデフォルトプロンプト同期エラー:', syncError);
            // 同期エラーが発生しても管理者設定の更新は成功扱い
        }
    } catch (error) {
        console.error('デフォルトプロンプト更新エラー:', error);
        throw new Error('デフォルトプロンプトの更新に失敗しました');
    }
}

