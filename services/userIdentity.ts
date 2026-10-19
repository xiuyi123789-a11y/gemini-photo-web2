import { userStorage } from './browserStorage';

// Used only by the local legacy mode. Production gets identity from the server session.
export const getUserId = (): string => {
  const valid = (s: string | null) => s && s !== 'default-user' && /^[a-zA-Z0-9-]+$/.test(s);
  const current = userStorage.getItem('quantum_leap_user_id');
  const legacy = userStorage.getItem('userId');
  const id = valid(current) ? current! : valid(legacy) ? legacy! : crypto.randomUUID();
  userStorage.setItem('quantum_leap_user_id', id);
  userStorage.setItem('userId', id);
  return id;
};
