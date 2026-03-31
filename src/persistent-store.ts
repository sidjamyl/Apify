import { Actor, log } from 'apify';

export interface PersistentStore {
    getValue<T>(key: string): Promise<T | null>;
    setValue<T>(key: string, value: T | null): Promise<void>;
}

function isInsufficientPermissionsError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const candidate = error as Error & { statusCode?: number; type?: string };
    return candidate.statusCode === 403 || candidate.type === 'insufficient-permissions' || error.message.includes('Insufficient permissions');
}

export async function openPersistentStore(input: {
    preferredName: string;
    fallbackNamespace: string;
}): Promise<PersistentStore> {
    const { preferredName, fallbackNamespace } = input;

    try {
        const namedStore = await Actor.openKeyValueStore(preferredName);
        return {
            async getValue<T>(key: string) {
                return namedStore.getValue<T>(key);
            },
            async setValue<T>(key: string, value: T | null) {
                await namedStore.setValue(key, value);
            },
        };
    } catch (error) {
        if (!isInsufficientPermissionsError(error)) {
            throw error;
        }

        log.warning(`Persistent store ${preferredName} is unavailable under limited permissions. Falling back to the default key-value store namespace ${fallbackNamespace}.`);
        const defaultStore = await Actor.openKeyValueStore();
        const prefix = `${fallbackNamespace}__`;

        return {
            async getValue<T>(key: string) {
                return defaultStore.getValue<T>(`${prefix}${key}`);
            },
            async setValue<T>(key: string, value: T | null) {
                await defaultStore.setValue(`${prefix}${key}`, value);
            },
        };
    }
}
