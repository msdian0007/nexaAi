import { apiRequest } from '../../services/api.ts';

export type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

export interface AuthSession {
  token: string;
  user: { id: string; name: string; email: string };
  organization: { id: string; name: string; slug: string };
  role: Role;
}

export interface LoginInput { email: string; password: string }
export interface RegisterInput extends LoginInput { name: string; organizationName: string }
export interface AuthIdentity { userId: string; organizationId: string; role: Role }

export const login = (input: LoginInput, signal?: AbortSignal) =>
  apiRequest<AuthSession>('/auth/login', { method: 'POST', body: input, signal });

export const register = (input: RegisterInput, signal?: AbortSignal) =>
  apiRequest<AuthSession>('/auth/register', { method: 'POST', body: input, signal });

export const getIdentity = (token: string, signal?: AbortSignal) =>
  apiRequest<AuthIdentity>('/auth/me', { token, signal });
