'use client';

import React, { Suspense, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { Users } from 'lucide-react';
import { TeamPanel } from '@/components/team/TeamPanel';
import { useAuth } from '@/hooks/useAuth';
import { PageHeader } from '@/components/ui/PageHeader';

type TeamView = 'subordinates' | 'supervisors';

const isValidView = (view: string | null): view is TeamView => {
    return view === 'subordinates' || view === 'supervisors';
};

const VIEW_DESCRIPTION: Record<TeamView, string> = {
    subordinates: '部下の一覧と、届いている申請を管理します。',
    supervisors: '上司の登録と、申請の状況を確認します。',
};

function TeamPageContent() {
    const { user } = useAuth();
    const searchParams = useSearchParams();
    const router = useRouter();

    const searchParamValue = searchParams.get('view');
    const searchParamsString = searchParams.toString();
    const currentView = isValidView(searchParamValue) ? searchParamValue : 'subordinates';

    useEffect(() => {
        if (!isValidView(searchParamValue)) {
            const params = new URLSearchParams(searchParamsString);
            params.set('view', 'subordinates');
            router.replace(`/team?${params.toString()}`);
        }
    }, [router, searchParamValue, searchParamsString]);

    return (
        <>
            <PageHeader title="チーム" description={VIEW_DESCRIPTION[currentView]} icon={Users} />
            <TeamPanel user={user} view={currentView} />
        </>
    );
}

export default function TeamPage() {
    return (
        <Suspense
            fallback={
                <>
                    {/* 読み込み中も h1 を欠かさない（見出しが遅れて現れると読み上げの起点が消える）。 */}
                    <PageHeader title="チーム" icon={Users} />
                    <p role="status" className="text-muted">
                        チーム情報を読み込んでいます...
                    </p>
                </>
            }
        >
            <TeamPageContent />
        </Suspense>
    );
}
