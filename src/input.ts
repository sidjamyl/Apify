import type { ActorInput, GraphExpansionInput, OperatorAccountInput, ProxyConfigurationInput } from './types.js';

export function normalizeUsername(rawUsername: string): string {
    return rawUsername.trim().replace(/^@+/, '').toLowerCase();
}

function parseOperatorAccounts(rawValue: unknown): OperatorAccountInput[] {
    if (rawValue == null) return [];
    if (!Array.isArray(rawValue)) {
        throw new Error('Input.operatorAccounts must be an array when provided.');
    }

    return rawValue.map((rawAccount, index) => {
        if (!rawAccount || typeof rawAccount !== 'object') {
            throw new Error(`Input.operatorAccounts[${index}] must be an object.`);
        }

        const username = Reflect.get(rawAccount, 'username');
        const password = Reflect.get(rawAccount, 'password');
        const sessionKey = Reflect.get(rawAccount, 'sessionKey');
        const sessionId = Reflect.get(rawAccount, 'sessionId');

        if (typeof username !== 'string' || username.trim().length === 0) {
            throw new Error(`Input.operatorAccounts[${index}].username must be a non-empty string.`);
        }

        if (password != null && (typeof password !== 'string' || password.length === 0)) {
            throw new Error(`Input.operatorAccounts[${index}].password must be a non-empty string when provided.`);
        }

        if (sessionKey != null && (typeof sessionKey !== 'string' || sessionKey.trim().length === 0)) {
            throw new Error(`Input.operatorAccounts[${index}].sessionKey must be a non-empty string when provided.`);
        }

        if (sessionId != null && (typeof sessionId !== 'string' || sessionId.trim().length === 0)) {
            throw new Error(`Input.operatorAccounts[${index}].sessionId must be a non-empty string when provided.`);
        }

        if ((typeof password !== 'string' || password.length === 0) && (typeof sessionId !== 'string' || sessionId.trim().length === 0)) {
            throw new Error(`Input.operatorAccounts[${index}] must include either password or sessionId.`);
        }

        return {
            username: normalizeUsername(username),
            password: typeof password === 'string' ? password : undefined,
            sessionKey: typeof sessionKey === 'string' ? sessionKey.trim() : undefined,
            sessionId: typeof sessionId === 'string' ? sessionId.trim() : undefined,
        };
    });
}

function parseProxyConfiguration(rawValue: unknown): ProxyConfigurationInput | null {
    if (rawValue == null) return null;
    if (!rawValue || typeof rawValue !== 'object') {
        throw new Error('Input.proxyConfiguration must be an object when provided.');
    }

    const useApifyProxy = Reflect.get(rawValue, 'useApifyProxy');
    const apifyProxyGroups = Reflect.get(rawValue, 'apifyProxyGroups');
    const apifyProxyCountry = Reflect.get(rawValue, 'apifyProxyCountry');
    const proxyUrls = Reflect.get(rawValue, 'proxyUrls');

    if (useApifyProxy != null && typeof useApifyProxy !== 'boolean') {
        throw new Error('Input.proxyConfiguration.useApifyProxy must be a boolean when provided.');
    }

    if (apifyProxyCountry != null && typeof apifyProxyCountry !== 'string') {
        throw new Error('Input.proxyConfiguration.apifyProxyCountry must be a string when provided.');
    }

    if (apifyProxyGroups != null && (!Array.isArray(apifyProxyGroups) || apifyProxyGroups.some((group) => typeof group !== 'string'))) {
        throw new Error('Input.proxyConfiguration.apifyProxyGroups must be an array of strings when provided.');
    }

    if (proxyUrls != null && (!Array.isArray(proxyUrls) || proxyUrls.some((proxyUrl) => typeof proxyUrl !== 'string' || proxyUrl.trim().length === 0))) {
        throw new Error('Input.proxyConfiguration.proxyUrls must be an array of non-empty strings when provided.');
    }

    return {
        useApifyProxy: typeof useApifyProxy === 'boolean' ? useApifyProxy : undefined,
        apifyProxyGroups: Array.isArray(apifyProxyGroups) ? apifyProxyGroups : undefined,
        apifyProxyCountry: typeof apifyProxyCountry === 'string' ? apifyProxyCountry : undefined,
        proxyUrls: Array.isArray(proxyUrls) ? proxyUrls : undefined,
    };
}

function parseGraphExpansion(rawValue: unknown): GraphExpansionInput {
    if (rawValue == null) {
        return {
            maxFollowersToInspect: 25,
            maxFollowingToInspect: 25,
            maxExpandedProfiles: 20,
        };
    }

    if (!rawValue || typeof rawValue !== 'object') {
        throw new Error('Input.graphExpansion must be an object when provided.');
    }

    const maxFollowersToInspect = Reflect.get(rawValue, 'maxFollowersToInspect');
    const maxFollowingToInspect = Reflect.get(rawValue, 'maxFollowingToInspect');
    const maxExpandedProfiles = Reflect.get(rawValue, 'maxExpandedProfiles');

    const normalizePositiveInteger = (value: unknown, fieldPath: string, fallback: number): number => {
        if (value == null) return fallback;
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
            throw new Error(`${fieldPath} must be a positive integer when provided.`);
        }
        return value;
    };

    return {
        maxFollowersToInspect: normalizePositiveInteger(maxFollowersToInspect, 'Input.graphExpansion.maxFollowersToInspect', 25),
        maxFollowingToInspect: normalizePositiveInteger(maxFollowingToInspect, 'Input.graphExpansion.maxFollowingToInspect', 25),
        maxExpandedProfiles: normalizePositiveInteger(maxExpandedProfiles, 'Input.graphExpansion.maxExpandedProfiles', 20),
    };
}

export function parseInput(input: unknown): ActorInput {
    if (!input || typeof input !== 'object') {
        throw new Error('Input must be a JSON object.');
    }

    const username = Reflect.get(input, 'username');
    if (typeof username !== 'string' || username.trim().length === 0) {
        throw new Error('Input.username must be a non-empty string.');
    }

    const normalizedUsername = normalizeUsername(username);
    if (!/^[a-z0-9._]+$/i.test(normalizedUsername)) {
        throw new Error('Input.username must be a valid Instagram username.');
    }

    const runMode = Reflect.get(input, 'runMode');
    const normalizedRunMode = runMode === 'freshness' ? 'freshness' : 'backfill';

    const maxDiscoveryCycles = Reflect.get(input, 'maxDiscoveryCycles');
    let normalizedMaxDiscoveryCycles: number;
    if (typeof maxDiscoveryCycles === 'number' && Number.isInteger(maxDiscoveryCycles) && maxDiscoveryCycles > 0) {
        normalizedMaxDiscoveryCycles = maxDiscoveryCycles;
    } else if (normalizedRunMode === 'freshness') {
        normalizedMaxDiscoveryCycles = 2;
    } else {
        normalizedMaxDiscoveryCycles = 5;
    }

    const operatorAccounts = parseOperatorAccounts(Reflect.get(input, 'operatorAccounts'));
    const proxyConfiguration = parseProxyConfiguration(Reflect.get(input, 'proxyConfiguration'));
    const graphExpansion = parseGraphExpansion(Reflect.get(input, 'graphExpansion'));

    return {
        username: normalizedUsername,
        runMode: normalizedRunMode,
        maxDiscoveryCycles: normalizedMaxDiscoveryCycles,
        operatorAccounts,
        proxyConfiguration,
        graphExpansion,
    };
}
