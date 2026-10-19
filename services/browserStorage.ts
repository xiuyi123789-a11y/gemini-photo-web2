// Separate drafts, chat history and provider credentials for each signed-in account.
let accountId: string | null = null;
export const setStorageUser = (id: string | null) => { accountId = id; };
const keyFor = (key: string) => accountId ? `ql_account:${accountId}:${key}` : key;
const targetFor = (key: string) => key === 'replicate_api_token' ? sessionStorage : localStorage;
export const userStorage = {
  getItem: (key: string) => targetFor(key).getItem(keyFor(key)),
  setItem: (key: string, value: string) => targetFor(key).setItem(keyFor(key), value),
  removeItem: (key: string) => targetFor(key).removeItem(keyFor(key))
};
