'use client';

import React, { Suspense, useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { TeamPanel } from '@/components/team/TeamPanel';
import { useAuth } from '@/hooks/useAuth';

type TeamView = 'subordinates' | 'supervisors';

const isValidView = (view: string | null): view is TeamView => {
    return view === 'subordinates' || view === 'supervisors';
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

    return <TeamPanel user={user} view={currentView} />;
}

export default function TeamPage() {
    return (
        <Suspense fallback={<div className="p-6">チーム情報を読み込み中...</div>}>
            <TeamPageContent />
        </Suspense>
    );
}


