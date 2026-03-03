import { useState, useCallback, useRef } from 'react';

import type { SearchResult } from '../../shared/types';

type UseSearchReturn = {
    query: string;
    setQuery: (q: string) => void;
    results: SearchResult[];
    isSearching: boolean;
    search: (q: string, vaultPath: string) => void;
    clearResults: () => void;
};

export function useSearch(): UseSearchReturn {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<SearchResult[]>([]);
    const [isSearching, setIsSearching] = useState(false);

    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const search = useCallback((q: string, vaultPath: string) => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        if (!q.trim()) {
            setResults([]);
            return;
        }
        setIsSearching(true);
        debounceRef.current = setTimeout(() => {
            window.electronAPI
                .search(q, vaultPath)
                .then((res) => {
                    setResults(res);
                    setIsSearching(false);
                })
                .catch((err) => {
                    console.error(err);
                    setIsSearching(false);
                });
        }, 200);
    }, []);

    const clearResults = useCallback(() => {
        setQuery('');
        setResults([]);
        setIsSearching(false);
    }, []);

    return {
        query, setQuery,
        results,
        isSearching,
        search,
        clearResults,
    };
}
