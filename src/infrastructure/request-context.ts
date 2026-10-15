import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'crypto';

export interface RequestContextData {
  correlationId: string;
  userId?: string;
  email?: string;
  role?: string;
  tenantId?: string;
  startTime: number;
}

class RequestContextManager {
  private storage = new AsyncLocalStorage<RequestContextData>();

  run<R>(callback: () => R, correlationId: string = randomUUID()): R {
    const contextData: RequestContextData = {
      correlationId,
      startTime: Date.now(),
    };
    return this.storage.run(contextData, callback);
  }

  getStore(): RequestContextData | undefined {
    return this.storage.getStore();
  }

  getCorrelationId(): string {
    return this.getStore()?.correlationId ?? 'unknown';
  }

  getDuration(): number {
    const store = this.getStore();
    if (!store) return -1;
    return Date.now() - store.startTime;
  }

  setUser(userId: string, email: string, role: string, tenantId?: string) {
    const store = this.getStore();
    if (store) {
      store.userId = userId;
      store.email = email;
      store.role = role;
      store.tenantId = tenantId;
    }
  }

  getUserId(): string | undefined {
    return this.getStore()?.userId;
  }

  getTenantId(): string | undefined {
    return this.getStore()?.tenantId;
  }
}

export const requestContext = new RequestContextManager();
