'use client';

import React, { useEffect } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { TeamPanel } from '@/components/team/TeamPanel';
import { useAuth } from '@/hooks/useAuth';

type TeamView = 'subordinates' | 'supervisors';

const isValidView = (view: string | null): view is TeamView => {
    return view === 'subordinates' || view === 'supervisors';
};

export default function TeamPage() {
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


