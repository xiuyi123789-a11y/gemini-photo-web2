
const API_BASE_URL = '/api';

export interface ErrorEntry {
    id: string;
    issue: string;
    solution: string;
    timestamp: string;
    tags?: string[];
}

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

export const addToErrorNotebook = async (issue: string, solution: string, tags: string[] = []) => {
    try {
        await callApi('/error-notebook', 'POST', { issue, solution, tags });
        console.log(`Added entry to error notebook: ${issue}`);
    } catch (error) {
        console.error("Failed to write to error notebook:", error);
    }
};

export const getErrorNotebook = async (): Promise<ErrorEntry[]> => {
    try {
        return await callApi('/error-notebook', 'GET');
    } catch (error) {
        console.error("Failed to read error notebook:", error);
        return [];
    }
};
