
const API_BASE_URL = import.meta.env.VITE_API_URL || '/api';

export interface ErrorEntry {
    id: string;
    issue: string;
    solution: string;
    timestamp: string;
    tags?: string[];
}

export type NotebookWriteInput =
    | { issue: string; solution: string; tags?: string[] }
    | { type: string; details: string; tags?: string[] };

const callApi = async (endpoint: string, method: string = 'GET', body?: any) => {
    const headers: HeadersInit = {
        'Content-Type': 'application/json'
    };

    const response = await fetch(`${API_BASE_URL}${endpoint}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
        throw new Error(`API call failed: ${response.statusText}`);
    }

    return await response.json();
};

export const addToErrorNotebook = async (
    issueOrEntry: string | NotebookWriteInput,
    solution?: string,
    tags: string[] = []
) => {
    try {
        const payload =
            typeof issueOrEntry === 'string'
                ? { issue: issueOrEntry, solution: solution || '', tags }
                : 'issue' in issueOrEntry
                    ? { issue: issueOrEntry.issue, solution: issueOrEntry.solution, tags: issueOrEntry.tags || [] }
                    : { issue: issueOrEntry.type, solution: issueOrEntry.details, tags: issueOrEntry.tags || [] };

        await callApi('/error-notebook', 'POST', payload);
        console.log(`Added entry to error notebook: ${payload.issue}`);
    } catch (error) {
        console.error("Failed to write to error notebook:", error);
    }
};

export const logOperation = (action: string, data?: Record<string, any>, tags: string[] = []) => {
    void addToErrorNotebook(
        `[op] ${action}`,
        JSON.stringify(
            {
                ...data,
                clientTime: new Date().toISOString()
            },
            null,
            0
        ),
        ['operation', ...tags]
    );
};

export const getErrorNotebook = async (): Promise<ErrorEntry[]> => {
    try {
        return await callApi('/error-notebook', 'GET');
    } catch (error) {
        console.error("Failed to read error notebook:", error);
        return [];
    }
};
